/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/require-await */
/**
 * Cloudflare Workers entry — Unraid Code-Mode MCP (cloud-hosted variant).
 *
 * NOTE: This is a SCAFFOLD. The Worker bindings (`Loader`, `BodyInit`,
 * `Request`/`Response`/`RequestInit`) come from `@cloudflare/workers-types`
 * which the linter sees as `error`/`any` until a Worker build wires them in
 * with `wrangler types`. The lint suppression at the file level prevents
 * those scaffolding errors from gating CI; revisit when this entry becomes
 * a first-class deployment target.
 *
 * This is a thin alternative to the Node entry that follows Cloudflare's
 * canonical Code-Mode pattern: `@cloudflare/codemode/mcp` `openApiMcpServer`
 * + `DynamicWorkerExecutor` (Worker Loader-backed sandbox).
 *
 * Differences from the Node entry:
 *   - Single-namespace per server instance (the `openApiMcpServer` helper
 *     wraps one schema at a time). v0 only ships `local`; the `connect`
 *     namespace remains reserved.
 *   - The sandbox is a real V8 Worker isolate (Worker Loader binding).
 *     `globalOutbound: null` blocks all outbound network from the sandbox;
 *     all Unraid calls go through the host `request()` below.
 *   - No on-disk spec cache — schemas are cached in module memory per
 *     Worker instance.
 *
 * Per-request multi-tenant credentials are read from headers exactly like
 * the Node HTTP transport (see [docs/multi-tenant.md](../docs/multi-tenant.md)).
 */

import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { openApiMcpServer, type RequestOptions } from '@cloudflare/codemode/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface Env {
  /** Worker Loader binding for the dynamic sandbox. */
  LOADER: WorkerLoader;
  /** Default upstream — operators can hardcode this for single-tenant deployments. */
  DEFAULT_BASE_URL?: string;
  DEFAULT_API_KEY?: string;
  /** Which namespace this Worker exposes. v0 only supports `local`. */
  NAMESPACE?: string;
}

const SPEC_CACHE = new Map<string, Promise<Record<string, unknown>>>();

const GRAPHQL_PATH = '/graphql';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', namespace: env.NAMESPACE ?? 'local' });
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    const namespace = env.NAMESPACE ?? 'local';
    if (namespace !== 'local') {
      return Response.json(
        { error: `Namespace "${namespace}" is reserved; v0 only ships "local".` },
        { status: 501 },
      );
    }

    const creds = readCreds(request, env);
    if (!creds) {
      return Response.json(
        {
          error:
            'Missing X-Unraid-Api-Key / X-Unraid-Base-Url headers (or DEFAULT_API_KEY / DEFAULT_BASE_URL env).',
        },
        { status: 401 },
      );
    }

    if (request.headers.get('x-unraid-insecure')?.toLowerCase() === 'true') {
      return Response.json(
        {
          error:
            'X-Unraid-Insecure is not supported on Cloudflare Workers. Provide a publicly trusted certificate on the Unraid server, or use the Node deployment.',
        },
        { status: 400 },
      );
    }

    let spec: Record<string, unknown>;
    try {
      spec = await loadSpec(creds);
    } catch (err) {
      return Response.json(
        { error: `Failed to load schema: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      timeout: 30_000,
      globalOutbound: null,
    });

    const server = openApiMcpServer({
      spec,
      executor,
      name: `unraid-code-mode-mcp-${namespace}`,
      // cf-worker scaffold: version is hand-stamped here because Workers can't
      // read package.json at runtime. Bump alongside the Node entry on each
      // release until the cf-worker becomes a first-class deployment target.
      version: '0.1.0-beta.2',
      request: async (opts: RequestOptions): Promise<unknown> => doRequest(opts, creds),
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    return adaptToFetch(transport, request);
  },
} satisfies ExportedHandler<Env>;

// ─── Tenant credentials ─────────────────────────────────────────────

interface UnraidCredsCf {
  baseUrl: string;
  apiKey: string;
}

function readCreds(request: Request, env: Env): UnraidCredsCf | undefined {
  const baseUrl = request.headers.get('x-unraid-base-url') ?? env.DEFAULT_BASE_URL ?? '';
  const apiKey = request.headers.get('x-unraid-api-key') ?? env.DEFAULT_API_KEY ?? '';
  if (!baseUrl || !apiKey) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
  };
}

// ─── Spec loading (cf-native; no undici, no fs) ─────────────────────

async function loadSpec(creds: UnraidCredsCf): Promise<Record<string, unknown>> {
  const cacheKey = creds.baseUrl;
  const cached = SPEC_CACHE.get(cacheKey);
  if (cached) return cached;
  const promise = fetchIntrospection(creds);
  SPEC_CACHE.set(cacheKey, promise);
  promise.catch(() => SPEC_CACHE.delete(cacheKey));
  return promise;
}

async function fetchIntrospection(creds: UnraidCredsCf): Promise<Record<string, unknown>> {
  const introspectionQuery = `
    query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        types {
          kind name description
          fields(includeDeprecated: true) {
            name description isDeprecated deprecationReason
            args { name description type { ...TypeRef } defaultValue }
            type { ...TypeRef }
          }
          inputFields { name description type { ...TypeRef } defaultValue }
          enumValues(includeDeprecated: true) { name description isDeprecated }
          possibleTypes { name }
        }
      }
    }
    fragment TypeRef on __Type {
      kind name
      ofType {
        kind name
        ofType {
          kind name
          ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
        }
      }
    }
  `;
  const res = await fetch(`${creds.baseUrl}${GRAPHQL_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': creds.apiKey,
    },
    body: JSON.stringify({ query: introspectionQuery }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} fetching introspection`);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  if (!body.data) throw new Error('introspection returned no data');
  return body.data;
}

// ─── Host-side request implementation ───────────────────────────────

async function doRequest(opts: RequestOptions, creds: UnraidCredsCf): Promise<unknown> {
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const qs = opts.query ? buildQuery(opts.query) : '';
  const url = `${creds.baseUrl}${path}${qs}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-api-key': creds.apiKey,
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'DELETE') {
    if (opts.rawBody) {
      body = opts.body as BodyInit;
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
  }

  const init: RequestInit = { method: opts.method, headers };
  if (body !== undefined) init.body = body;

  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') ?? '';
  let data: unknown;
  if (contentType.includes('application/json')) data = await res.json();
  else data = await res.text();

  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${String(res.status)} on ${path}`), {
      status: res.status,
      data,
    });
  }
  return data;
}

function buildQuery(query: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ─── Adapter: bridge MCP transport to a Worker fetch Response ───────

async function adaptToFetch(
  transport: StreamableHTTPServerTransport,
  request: Request,
): Promise<Response> {
  // The MCP SDK's StreamableHTTPServerTransport expects Node's IncomingMessage /
  // ServerResponse. On Workers we'd typically use a thin shim. For now this
  // worker is a scaffold demonstrating the integration; full request adaption
  // is intentionally left as a follow-up that requires either:
  //   1) a community shim package for Node ↔ Workers HTTP, or
  //   2) the MCP SDK adding a Web-Streams transport.
  //
  // See https://github.com/modelcontextprotocol/typescript-sdk for status.
  void transport;
  void request;
  return Response.json(
    {
      error:
        'Cloudflare Workers transport adapter is a scaffold. ' +
        'Use the Node entry (npm start) for a fully-working multi-tenant HTTP server. ' +
        'See cf-worker/README.md for adapter status.',
    },
    { status: 501 },
  );
}

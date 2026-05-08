/**
 * Spec loader for the Unraid 7.2+ GraphQL API.
 *
 * Loading order (first one that succeeds wins):
 *   1. Live introspection against `${baseUrl}/graphql` using the supplied
 *      API key. The result is cached on disk under `cacheDir` keyed by a
 *      SHA-256 hash of the base URL plus a `CACHE_SCHEMA_VERSION` constant.
 *   2. Bundled SDL fallback at `src/spec/local-fallback.graphql`. The SDL
 *      is parsed via `graphql` and converted to an introspection JSON via
 *      `introspectionFromSchema`. Used when the live server can't be
 *      reached or hasn't been configured yet.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { buildSchema, getIntrospectionQuery, introspectionFromSchema } from 'graphql';

import { buildOperationIndex, type IntrospectionResult } from './index-builder.js';
import type { Namespace, ProcessedSpec } from '../types/spec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bump this whenever the shape produced by `buildOperationIndex` changes
 * in a way that would make stale on-disk caches misleading. A mismatch
 * causes `readCacheFile` to ignore the cache and refetch upstream.
 *
 * History:
 *   v1 — initial cache schema
 */
export const CACHE_SCHEMA_VERSION = 1;

const memoryCache = new Map<string, ProcessedSpec>();

// ─── Public API ─────────────────────────────────────────────────────

export interface LoadUnraidSpecOptions {
  /** Base URL of the Unraid server, e.g. https://tower.local. */
  baseUrl: string;
  /** API key (x-api-key header). */
  apiKey: string;
  /** PEM-encoded CA bundle for TLS verification. */
  caCert?: string;
  /** Skip TLS verification entirely. */
  insecure?: boolean;
  /** Where to cache fetched introspection results on disk. */
  cacheDir: string;
  /** Force re-fetch from network even if a cache exists. */
  forceRefresh?: boolean;
  /** Optional callback for non-fatal warnings (cache misses, fallbacks, …). */
  onWarn?: (msg: string) => void;
  /** Namespace this spec belongs to. Defaults to `local`. */
  namespace?: Namespace;
}

/** Load (and cache) the Unraid GraphQL schema via live introspection. */
export async function loadUnraidSpec(opts: LoadUnraidSpecOptions): Promise<ProcessedSpec> {
  const namespace = opts.namespace ?? 'local';
  const cacheKey = `${namespace}:${hashBaseUrl(opts.baseUrl)}`;

  if (!opts.forceRefresh) {
    const cached = memoryCache.get(cacheKey);
    if (cached) return cached;
    const onDisk = await readCacheFile(cacheFilePath(opts.cacheDir, cacheKey));
    if (onDisk) {
      memoryCache.set(cacheKey, onDisk);
      return onDisk;
    }
  }

  const onWarn = opts.onWarn ?? (() => undefined);
  const dispatcher = buildDispatcher({ caCert: opts.caCert, insecure: opts.insecure });

  let introspection: IntrospectionResult;
  let sourceUrl: string;
  const version = 'live';

  try {
    const live = await fetchIntrospection({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      dispatcher,
    });
    introspection = live.introspection;
    sourceUrl = live.sourceUrl;
  } catch (err) {
    onWarn(
      `Live introspection against ${opts.baseUrl}/graphql failed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Falling back to bundled SDL.',
    );
    const fallback = await loadFallbackSpec(namespace);
    return fallback;
  }

  const built = buildOperationIndex(introspection, namespace);
  const queryCount = built.operations.filter((o) => o.kind === 'query').length;
  const mutationCount = built.operations.filter((o) => o.kind === 'mutation').length;
  const processed: ProcessedSpec = {
    sourceUrl,
    version,
    title: 'Unraid GraphQL API',
    namespace,
    operations: built.operations,
    types: built.types,
    queryCount,
    mutationCount,
  };

  memoryCache.set(cacheKey, processed);
  await writeCacheFile(cacheFilePath(opts.cacheDir, cacheKey), processed);
  return processed;
}

/**
 * Build a ProcessedSpec from the bundled SDL fallback. Used at startup when
 * no Unraid credentials are configured (multi-tenant scaffolding) and as a
 * last-resort when live introspection fails.
 */
export async function loadFallbackSpec(
  namespace: Namespace = 'local',
): Promise<ProcessedSpec> {
  const cacheKey = `${namespace}:fallback`;
  const cached = memoryCache.get(cacheKey);
  if (cached) return cached;

  const sdlPath = resolve(__dirname, 'local-fallback.graphql');
  if (!existsSync(sdlPath)) {
    throw new Error(
      `Bundled SDL fallback missing at ${sdlPath}. ` +
        'Run `npm run update-spec` to generate it.',
    );
  }
  const sdl = await readFile(sdlPath, 'utf-8');
  const schema = buildSchema(sdl, { assumeValidSDL: true });
  const introspection = introspectionFromSchema(schema) as unknown as IntrospectionResult;

  const built = buildOperationIndex(introspection, namespace);
  const queryCount = built.operations.filter((o) => o.kind === 'query').length;
  const mutationCount = built.operations.filter((o) => o.kind === 'mutation').length;
  const processed: ProcessedSpec = {
    sourceUrl: 'embedded:local-fallback.graphql',
    version: 'fallback',
    title: 'Unraid GraphQL API (fallback)',
    namespace,
    operations: built.operations,
    types: built.types,
    queryCount,
    mutationCount,
  };
  memoryCache.set(cacheKey, processed);
  return processed;
}

/** Drop all cached specs (forces re-fetch on next access). */
export function clearSpecCache(): void {
  memoryCache.clear();
}

// ─── Internals ──────────────────────────────────────────────────────

interface FetchIntrospectionArgs {
  baseUrl: string;
  apiKey: string;
  dispatcher: Dispatcher | undefined;
}

interface FetchIntrospectionResult {
  introspection: IntrospectionResult;
  sourceUrl: string;
}

async function fetchIntrospection(
  args: FetchIntrospectionArgs,
): Promise<FetchIntrospectionResult> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/graphql`;
  const res = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': args.apiKey,
    },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
    dispatcher: args.dispatcher,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Introspection request failed: HTTP ${String(res.status)} ${res.statusText}. ` +
        'Check UNRAID_BASE_URL, UNRAID_API_KEY, and (if on a *.unraid.net LAN cert) UNRAID_CA_CERT_PATH / UNRAID_INSECURE.',
    );
  }
  const body = (await res.json()) as { data?: IntrospectionResult; errors?: unknown };
  if (body.errors) {
    throw new Error(`GraphQL introspection returned errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data?.__schema) {
    throw new Error('GraphQL introspection returned no __schema payload');
  }
  return { introspection: body.data, sourceUrl: url };
}

function buildDispatcher(
  opts: { caCert?: string; insecure?: boolean } = {},
): Dispatcher | undefined {
  if (opts.insecure) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  if (opts.caCert) {
    return new Agent({ connect: { ca: opts.caCert } });
  }
  return undefined;
}

function hashBaseUrl(url: string): string {
  return createHash('sha256').update(url.toLowerCase().trim()).digest('hex').slice(0, 16);
}

function cacheFilePath(cacheDir: string, key: string): string {
  return resolve(cacheDir, `${key.replace(/[^a-z0-9_:.-]/gi, '_')}.json`);
}

interface CacheEnvelope extends ProcessedSpec {
  cacheSchemaVersion?: number;
}

async function readCacheFile(path: string): Promise<ProcessedSpec | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
    const { cacheSchemaVersion: _v, ...spec } = parsed;
    return spec;
  } catch {
    return undefined;
  }
}

async function writeCacheFile(path: string, spec: ProcessedSpec): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const envelope: CacheEnvelope = { ...spec, cacheSchemaVersion: CACHE_SCHEMA_VERSION };
  await writeFile(path, JSON.stringify(envelope), 'utf-8');
}

/**
 * Shared HTTP request implementation backing both the GraphQL client and the
 * raw `unraid.local.request(...)` escape hatch.
 *
 * Handles:
 *   - Query string serialization
 *   - JSON encoding
 *   - 429 Retry-After honoring (single retry)
 *   - Error normalization to UnraidHttpError / UnraidTransportError
 *   - Per-tenant TLS dispatcher (custom CA / insecure / strict)
 */

import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit } from 'undici';
import {
  UnraidHttpError,
  UnraidTransportError,
  type HttpMethod,
  type UnraidRequestParams,
  type UnraidResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES_429 = 1;

export interface HttpClientConfig {
  /** Full origin, e.g. https://tower.local (no trailing slash, no path). */
  baseUrl: string;
  /** API key for the `x-api-key` header. */
  apiKey: string;
  /** PEM CA bundle for TLS verification. */
  caCert?: string;
  /** Skip TLS verification entirely. */
  insecure?: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** A descriptive label for log messages. */
  label?: string;
  /** Optional warn handler — used to surface insecure-mode warnings to the caller. */
  onWarn?: (msg: string) => void;
}

export class HttpClient {
  private readonly dispatcher: Dispatcher | undefined;
  private readonly timeoutMs: number;

  constructor(public readonly config: HttpClientConfig) {
    this.dispatcher = buildDispatcher(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.insecure) {
      config.onWarn?.(
        `[${config.label ?? 'http'}] TLS verification disabled (insecure mode). ` +
          'Provide a custom CA bundle in production.',
      );
    }
  }

  async request<T = unknown>(params: UnraidRequestParams): Promise<UnraidResponse<T>> {
    const method = (params.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = this.buildUrl(params);
    return this.send<T>(url, method, params);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private buildUrl(params: UnraidRequestParams): string {
    const path = params.path.startsWith('/') ? params.path : `/${params.path}`;
    const qs = buildQueryString(params.query);
    return `${this.config.baseUrl}${path}${qs}`;
  }

  private async send<T>(
    url: string,
    method: HttpMethod,
    params: UnraidRequestParams,
    attempt = 0,
  ): Promise<UnraidResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-api-key': this.config.apiKey,
      ...(params.headers ?? {}),
    };

    let body: string | undefined;
    if (params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
      headers['Content-Type'] ??= 'application/json';
    }

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, init);
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new UnraidTransportError(
        isTimeout
          ? `Request to ${url} timed out after ${String(this.timeoutMs)}ms`
          : `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        params.path,
        err,
      );
    }

    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfter !== undefined) {
        await sleep(retryAfter);
        return this.send<T>(url, method, params, attempt + 1);
      }
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const ct = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (ct.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
    } else if (res.status === 204) {
      data = undefined;
    } else {
      data = await res.text().catch(() => undefined);
    }

    if (!res.ok) {
      throw new UnraidHttpError(
        formatHttpError(res.status, params.path, data),
        res.status,
        params.path,
        data,
      );
    }

    return { status: res.status, headers: responseHeaders, body: data as T };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

export function buildDispatcher(
  cfg: { caCert?: string; insecure?: boolean } = {},
): Dispatcher | undefined {
  if (cfg.insecure) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  if (cfg.caCert) {
    return new Agent({ connect: { ca: cfg.caCert } });
  }
  return undefined;
}

export function buildQueryString(
  query: Record<string, string | number | boolean | string[] | undefined> | undefined,
): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatHttpError(status: number, path: string, body: unknown): string {
  let detail = '';
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    // GraphQL error envelope: { errors: [{ message, extensions: { code } }] }
    // Surface these so callers (including the LLM in the sandbox) can see
    // validation messages instead of an opaque "HTTP 400 on /graphql".
    if (Array.isArray(b['errors']) && b['errors'].length > 0) {
      const errs = (b['errors'] as unknown[]).slice(0, 5).map((e) => {
        if (e && typeof e === 'object') {
          const eo = e as Record<string, unknown>;
          const msg = typeof eo['message'] === 'string' ? eo['message'] : 'unknown error';
          const ext = eo['extensions'];
          let code: string | undefined;
          if (ext && typeof ext === 'object') {
            const c = (ext as Record<string, unknown>)['code'];
            if (typeof c === 'string') code = c;
          }
          return code ? `${msg} [${code}]` : msg;
        }
        return String(e);
      });
      const more =
        (b['errors'] as unknown[]).length > 5
          ? ` (+${String((b['errors'] as unknown[]).length - 5)} more)`
          : '';
      detail = `: GraphQL ${errs.join(' | ')}${more}`;
    } else {
      const msg = b['message'] ?? b['error'];
      const code = b['code'];
      if (typeof msg === 'string') detail = `: ${msg}`;
      if (typeof code === 'string') detail += ` [${code}]`;
    }
  } else if (typeof body === 'string' && body.length < 500) {
    detail = `: ${body}`;
  }
  return `HTTP ${String(status)} on ${path}${detail}`;
}

/**
 * TenantContext — per-request credentials for the Unraid GraphQL API.
 *
 * The same code paths handle:
 *   - Single-user mode: context built from environment variables once at startup.
 *   - Multi-user mode: context built from HTTP request headers on each request.
 *
 * Credentials NEVER enter the QuickJS sandbox. The host-side dispatch handler
 * receives the TenantContext and uses it to authorize outbound HTTPS calls.
 *
 * The credential map is keyed by namespace. v0 only ships `local`; the
 * `connect` slot is reserved so the future Unraid Connect cloud surface can
 * be added without a context-shape change.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────

export interface UnraidCreds {
  /** Base URL of the Unraid server, e.g. https://tower.local (no path). */
  baseUrl: string;
  /** API key minted via `unraid-api apikey --create` or the web UI. */
  apiKey: string;
  /** PEM-encoded CA bundle used to validate the server's TLS cert. */
  caCert?: string;
  /** Skip TLS verification entirely. Logged loudly when used. */
  insecure?: boolean;
}

export type CredsByNamespace = {
  local?: UnraidCreds;
  /** Reserved for Unraid Connect cloud — not implemented in v0. */
  connect?: UnraidCreds;
};

export interface TenantContext extends CredsByNamespace {
  /** A short id used in logs; not security-sensitive. */
  requestId: string;
  /** Whether this context was assembled from HTTP headers (true) or env vars (false). */
  fromHeaders: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────

export class MissingCredentialsError extends Error {
  override readonly name = 'MissingCredentialsError';
  constructor(
    public readonly namespace: 'local' | 'connect',
    detail?: string,
  ) {
    super(
      `No credentials for "${namespace}" namespace. ` +
        (namespace === 'local'
          ? 'Provide UNRAID_API_KEY + UNRAID_BASE_URL via env (single-user) ' +
            'or X-Unraid-Api-Key + X-Unraid-Base-Url headers (multi-user).'
          : 'Unraid Connect support is reserved; v0 only ships the local namespace.') +
        (detail ? ` (${detail})` : ''),
    );
  }
}

// ─── Header constants ───────────────────────────────────────────────

export const HEADER_API_KEY = 'x-unraid-api-key';
export const HEADER_BASE_URL = 'x-unraid-base-url';
export const HEADER_CA_CERT = 'x-unraid-ca-cert';
export const HEADER_INSECURE = 'x-unraid-insecure';

// ─── Builders ───────────────────────────────────────────────────────

export interface EnvCreds {
  UNRAID_API_KEY?: string;
  UNRAID_BASE_URL?: string;
  UNRAID_CA_CERT_PATH?: string;
  UNRAID_CA_CERT?: string;
  UNRAID_INSECURE?: string;
}

/** Build a TenantContext from process.env. */
export function buildContextFromEnv(env: EnvCreds = process.env): TenantContext {
  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: false,
  };

  const local = readLocalFromEnv(env);
  if (local) ctx.local = local;

  return ctx;
}

/**
 * Build a TenantContext from a Node IncomingMessage's headers, falling back
 * to env vars per-namespace. The header set fully overrides the env set for
 * a namespace if any of its required headers are present.
 */
export function buildContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  fallbackEnv: EnvCreds = process.env,
): TenantContext {
  const get = (name: string): string | undefined => {
    const raw = headers[name.toLowerCase()];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };

  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: true,
  };

  const apiKey = get(HEADER_API_KEY);
  const baseUrl = get(HEADER_BASE_URL);
  if (apiKey || baseUrl) {
    if (!apiKey || !baseUrl) {
      throw new MissingCredentialsError(
        'local',
        `Header pair incomplete: provide both ${HEADER_API_KEY} and ${HEADER_BASE_URL}.`,
      );
    }
    ctx.local = {
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      caCert: get(HEADER_CA_CERT),
      insecure: parseBool(get(HEADER_INSECURE)),
    };
  } else {
    const fromEnv = readLocalFromEnv(fallbackEnv);
    if (fromEnv) ctx.local = fromEnv;
  }

  return ctx;
}

// ─── Helpers ────────────────────────────────────────────────────────

function readLocalFromEnv(env: EnvCreds): UnraidCreds | undefined {
  const apiKey = env.UNRAID_API_KEY;
  const baseUrl = env.UNRAID_BASE_URL;
  if (!apiKey || !baseUrl) return undefined;

  let caCert: string | undefined = env.UNRAID_CA_CERT;
  if (!caCert && env.UNRAID_CA_CERT_PATH) {
    try {
      caCert = readFileSync(resolve(env.UNRAID_CA_CERT_PATH), 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read UNRAID_CA_CERT_PATH=${env.UNRAID_CA_CERT_PATH}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    caCert,
    insecure: parseBool(env.UNRAID_INSECURE),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

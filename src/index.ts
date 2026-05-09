#!/usr/bin/env node
/**
 * Unraid Code-Mode MCP Server — entry point.
 *
 * Lifecycle:
 *   1. Validate env config (Zod).
 *   2. Pre-warm QuickJS WASM module.
 *   3. Try to load the GraphQL schema:
 *        a. Live introspection if env credentials are present (single-user).
 *        b. Bundled SDL fallback otherwise (multi-tenant scaffold).
 *   4. Build MCP server with `search` + `execute` tools.
 *   5. Start the chosen transport (stdio or HTTP).
 *
 * In multi-user mode (HTTP without env creds), the bundled SDL fallback is
 * loaded so `search` is immediately useful; per-request specs against real
 * controllers can be wired up later via the same loader.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { getQuickJSModule } from './sandbox/executor.js';
import { loadFallbackSpec, loadUnraidSpec } from './spec/loader.js';
import { specSummary } from './spec/index.js';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  type TenantContext,
} from './tenant/context.js';
import { createMcpServer } from './server/server.js';
import { startHttpTransport, startStdioTransport } from './server/transport.js';
import { currentRequestScope } from './server/request-context.js';
import type { ProcessedSpec } from './types/spec.js';

function readPackageVersion(): string {
  // dist/index.js → ../package.json. In dev (tsx src/index.ts) it's the
  // same relative offset because src/ and dist/ are siblings of package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'package.json'),
    resolve(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Try next candidate.
    }
  }
  return '0.0.0-unknown';
}

const SERVER_VERSION = readPackageVersion();

const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    console.error(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    console.error(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${msg}`, ...args);
  },
};

async function tryLoadLocalSpec(config: AppConfig): Promise<ProcessedSpec | undefined> {
  if (!config.unraidBaseUrl || !config.unraidApiKey) {
    logger.info(
      'No Unraid credentials in env; loading bundled SDL fallback. ' +
        'Configure UNRAID_BASE_URL + UNRAID_API_KEY for live introspection.',
    );
    try {
      const spec = await loadFallbackSpec();
      const sum = specSummary(spec);
      logger.info(
        `Loaded fallback spec: ${sum.title} v${sum.version} ` +
          `(${String(sum.queryCount)} queries, ${String(sum.mutationCount)} mutations, ${String(sum.typeCount)} types)`,
      );
      return spec;
    } catch (err) {
      logger.warn(
        `Failed to load bundled SDL fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
  try {
    const spec = await loadUnraidSpec({
      baseUrl: config.unraidBaseUrl,
      apiKey: config.unraidApiKey,
      ...(config.unraidInsecure !== undefined ? { insecure: config.unraidInsecure } : {}),
      cacheDir: config.unraidSpecCacheDir,
      onWarn: (msg: string) => {
        logger.warn(`[spec] ${msg}`);
      },
    });
    const sum = specSummary(spec);
    logger.info(
      `Loaded live spec: ${sum.title} v${sum.version} ` +
        `(${String(sum.queryCount)} queries, ${String(sum.mutationCount)} mutations, ${String(sum.typeCount)} types)`,
    );
    return spec;
  } catch (err) {
    logger.warn(
      `Failed to load live spec at startup: ${err instanceof Error ? err.message : String(err)}. ` +
        'Falling back to bundled SDL.',
    );
    try {
      return await loadFallbackSpec();
    } catch (fallbackErr) {
      logger.warn(
        `Bundled SDL fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  logger.info('Unraid Code-Mode MCP Server starting...');
  const config = loadConfig();
  logger.info(`Transport: ${config.mcpTransport}`);

  const wasmStart = Date.now();
  await getQuickJSModule();
  logger.info(`QuickJS WASM initialized in ${String(Date.now() - wasmStart)}ms`);

  const localSpec = await tryLoadLocalSpec(config);

  const tenantResolver = (): TenantContext => {
    const scope = currentRequestScope();
    if (scope) return buildContextFromHeaders(scope.headers);
    return buildContextFromEnv();
  };

  const server = createMcpServer({
    ...(localSpec ? { localSpec } : {}),
    tenantResolver,
    limits: {
      maxCallsPerExecute: config.unraidMaxCallsPerExecute,
      timeoutMs: config.unraidExecuteTimeoutMs,
    },
    logger,
    name: 'unraid-code-mode-mcp',
    version: SERVER_VERSION,
  });

  if (config.mcpTransport === 'stdio') {
    await startStdioTransport(server, logger);
  } else {
    await startHttpTransport(
      server,
      {
        port: config.mcpHttpPort,
        allowedOrigins: config.mcpHttpAllowedOrigins,
      },
      logger,
    );
  }
}

main().catch((err: unknown) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});

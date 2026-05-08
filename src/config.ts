/**
 * Top-level config loader. All env vars validated through Zod.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

function defaultCacheDir(): string {
  return resolve(homedir(), '.cache', 'unraid-code-mode-mcp');
}

const configSchema = z.object({
  // Transport
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  mcpHttpPort: z.coerce.number().int().min(1).max(65535).default(8000),
  mcpHttpAllowedOrigins: z
    .string()
    .default('http://localhost,http://127.0.0.1')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),

  // Unraid local
  unraidBaseUrl: z.string().optional(),
  unraidApiKey: z.string().optional(),
  unraidCaCertPath: z.string().optional(),
  unraidInsecure: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? undefined : ['true', '1', 'yes'].includes(v.toLowerCase()),
    ),

  // Spec cache
  unraidSpecCacheDir: z
    .string()
    .optional()
    .transform((p) => (p && p.length > 0 ? resolve(p) : defaultCacheDir())),

  // Sandbox
  unraidMaxCallsPerExecute: z.coerce.number().int().min(1).max(1000).default(50),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse({
    mcpTransport: env['MCP_TRANSPORT'],
    mcpHttpPort: env['MCP_HTTP_PORT'],
    mcpHttpAllowedOrigins: env['MCP_HTTP_ALLOWED_ORIGINS'],

    unraidBaseUrl: env['UNRAID_BASE_URL'],
    unraidApiKey: env['UNRAID_API_KEY'],
    unraidCaCertPath: env['UNRAID_CA_CERT_PATH'],
    unraidInsecure: env['UNRAID_INSECURE'],

    unraidSpecCacheDir: env['UNRAID_SPEC_CACHE_DIR'],

    unraidMaxCallsPerExecute: env['UNRAID_MAX_CALLS_PER_EXECUTE'],
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}

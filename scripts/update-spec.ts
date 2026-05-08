#!/usr/bin/env tsx
/**
 * Refresh the bundled Unraid GraphQL SDL fallback.
 *
 * Fetches the canonical schema from the upstream `unraid/api` repository
 * and writes it verbatim into `src/spec/local-fallback.graphql`. Run this
 * during scaffolding (so the bundled fallback exists at launch) and
 * whenever Unraid ships a new schema. The runtime loader prefers live
 * introspection — the bundled SDL is a startup-time safety net for
 * deployments that haven't been pointed at a real Unraid box yet.
 *
 * Usage:
 *   npm run update-spec
 *   UNRAID_SDL_URL=https://example/schema.graphql npm run update-spec
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetch as undiciFetch } from 'undici';

const DEFAULT_SDL_URL =
  'https://raw.githubusercontent.com/unraid/api/main/api/generated-schema.graphql';

async function main(): Promise<void> {
  const url = process.env['UNRAID_SDL_URL'] ?? DEFAULT_SDL_URL;
  const target = resolve(process.cwd(), 'src/spec/local-fallback.graphql');

  console.error(`[update-spec] fetching ${url}`);
  const res = await undiciFetch(url, {
    headers: { Accept: 'text/plain, */*;q=0.5' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch SDL: HTTP ${String(res.status)} ${res.statusText}`);
  }
  const sdl = await res.text();
  if (!sdl.includes('type ') && !sdl.includes('schema ')) {
    throw new Error(`Fetched payload does not look like GraphQL SDL (length ${String(sdl.length)})`);
  }
  await writeFile(target, sdl, 'utf-8');
  console.error(`[update-spec] wrote ${target} (${String(sdl.length)} bytes)`);
}

main().catch((err: unknown) => {
  console.error('[update-spec] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

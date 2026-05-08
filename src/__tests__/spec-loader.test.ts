import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { clearSpecCache, loadFallbackSpec, loadUnraidSpec } from '../spec/loader.js';

const FAKE_INTROSPECTION = {
  __schema: {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      {
        kind: 'OBJECT',
        name: 'Query',
        fields: [
          {
            name: 'ping',
            description: 'simple ping',
            args: [],
            type: { kind: 'SCALAR', name: 'String' },
          },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'Mutation',
        fields: [
          {
            name: 'reboot',
            description: 'reboot the server',
            args: [],
            type: { kind: 'SCALAR', name: 'Boolean' },
          },
        ],
      },
      { kind: 'SCALAR', name: 'String' },
      { kind: 'SCALAR', name: 'Boolean' },
    ],
  },
};

describe('spec loader', () => {
  let cacheDir: string;
  let originalDispatcher: Dispatcher;
  let mockAgent: MockAgent;

  beforeEach(() => {
    cacheDir = mkdtempSync(resolve(tmpdir(), 'unraid-spec-cache-'));
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent({ connections: 1 });
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    clearSpecCache();
  });

  afterEach(async () => {
    rmSync(cacheDir, { recursive: true, force: true });
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
    clearSpecCache();
  });

  it('loads via live introspection when the GraphQL endpoint responds', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(
        200,
        { data: FAKE_INTROSPECTION },
        { headers: { 'content-type': 'application/json' } },
      );

    const spec = await loadUnraidSpec({
      baseUrl: 'https://tower.local',
      apiKey: 'k',
      cacheDir,
    });

    expect(spec.queryCount).toBe(1);
    expect(spec.mutationCount).toBe(1);
    expect(spec.operations.map((o) => o.name).sort()).toEqual(['ping', 'reboot']);
    expect(spec.sourceUrl).toBe('https://tower.local/graphql');
  });

  it('falls back to bundled SDL when introspection fails', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool.intercept({ path: '/graphql', method: 'POST' }).reply(500, 'boom');

    const warns: string[] = [];
    const spec = await loadUnraidSpec({
      baseUrl: 'https://tower.local',
      apiKey: 'k',
      cacheDir,
      onWarn: (m) => warns.push(m),
    });

    // Fallback version is `fallback@<pinned-tag>` so the LLM (and operators
    // reading logs) can tell which Unraid release the bundled SDL came from.
    expect(spec.version).toMatch(/^fallback(@v\d+\.\d+\.\d+)?$/);
    expect(spec.operations.length).toBeGreaterThan(0);
    expect(warns.some((m) => m.includes('introspection'))).toBe(true);
  });

  it('caches results across calls', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(
        200,
        { data: FAKE_INTROSPECTION },
        { headers: { 'content-type': 'application/json' } },
      );

    const first = await loadUnraidSpec({
      baseUrl: 'https://tower.local',
      apiKey: 'k',
      cacheDir,
    });
    const second = await loadUnraidSpec({
      baseUrl: 'https://tower.local',
      apiKey: 'k',
      cacheDir,
    });

    expect(second).toBe(first);
  });

  it('reads bundled SDL via loadFallbackSpec', async () => {
    const spec = await loadFallbackSpec();
    expect(spec.version).toMatch(/^fallback(@v\d+\.\d+\.\d+)?$/);
    expect(spec.queryCount).toBeGreaterThan(0);
    expect(spec.mutationCount).toBeGreaterThan(0);
    // Sanity: a few well-known Unraid operations should be present.
    const names = new Set(spec.operations.map((o) => o.name));
    expect(names.has('info')).toBe(true);
  });

  it('exposes the pinned upstream tag in the spec metadata', async () => {
    const spec = await loadFallbackSpec();
    // The bundled SDL is regenerated from a pinned tag (see
    // scripts/update-spec.ts). The loader surfaces that tag in `version`
    // and `sourceUrl` so the LLM can see which Unraid release the offline
    // schema represents and so users can verify their box matches.
    expect(spec.version).toMatch(/^fallback@v\d+\.\d+\.\d+$/);
    expect(spec.sourceUrl).toMatch(
      /^embedded:local-fallback\.graphql \(unraid\/api v\d+\.\d+\.\d+\)$/,
    );
  });
});

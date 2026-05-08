import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecuteExecutor } from '../../sandbox/execute-executor.js';
import { loadFallbackSpec } from '../../spec/loader.js';
import type { ProcessedSpec } from '../../types/spec.js';
import { startMockServer, type MockServer } from './mock-server.js';
import { createUnraidClient } from '../../client/graphql.js';

/**
 * End-to-end-ish: a real ExecuteExecutor running real QuickJS, talking to a
 * tiny in-process node:http GraphQL server. Lets us cover the full path
 * from sandbox prelude → host bridge → undici fetch → response → handle
 * return → sandbox value, plus the Promise-callback bridge that powers
 * sequential `await`s.
 */
describe('integration: execute against mock GraphQL', () => {
  let mock: MockServer;
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
    mock = await startMockServer({
      // Match by `query` string (substring) → response body. Each handler
      // can override the response per-request to support call-counting and
      // negative-path cases.
      handlers: [
        {
          match: (req) => req.query.includes('boom'),
          respond: () => ({
            errors: [{ message: 'expected failure', extensions: { code: 'BAD_USER_INPUT' } }],
          }),
        },
        {
          match: (req) => req.query.includes('info'),
          respond: () => ({ data: { info: { os: { distro: 'Slackware' } } } }),
        },
        {
          match: (req) => req.query.includes('apiKeys'),
          respond: () => ({
            data: { apiKeys: [{ id: 'a1', name: 'mcp', roles: ['ADMIN'] }] },
          }),
        },
        {
          match: (req) => req.query.includes('shares'),
          respond: () => ({
            data: { shares: [{ name: 'media', size: 1024 }] },
          }),
        },
      ],
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  function makeExecutor(): ExecuteExecutor {
    return new ExecuteExecutor({
      tenant: {
        local: { baseUrl: mock.baseUrl, apiKey: 'mock' },
        requestId: 'test',
        fromHeaders: false,
      },
      localSpec: spec,
      buildLocalClient: (tenant) => {
        if (!tenant.local) throw new Error('test tenant missing local creds');
        return createUnraidClient({ baseUrl: mock.baseUrl, apiKey: tenant.local.apiKey });
      },
    });
  }

  it('runs unraid.local.query.info({ fields }) end-to-end', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        const i = await unraid.local.query.info({ fields: ['os { distro }'] });
        return i;
      })()
    `);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ os: { distro: 'Slackware' } });
    expect(result.callsMade).toBe(1);
  });

  it('runs unraid.local.graphql({ query }) end-to-end', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        const d = await unraid.local.graphql({ query: '{ apiKeys { id name roles } }' });
        return d;
      })()
    `);
    expect(result.ok).toBe(true);
    const data = result.data as { apiKeys: Array<{ id: string; name: string }> };
    expect(data.apiKeys[0]?.name).toBe('mcp');
  });

  it('supports many sequential awaits in one execute (regression: code-mode multi-step)', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        const out = [];
        for (let i = 0; i < 10; i++) {
          const i_ = await unraid.local.query.info({ fields: ['os { distro }'] });
          out.push(i_.os.distro);
        }
        return out;
      })()
    `);
    expect(result.ok).toBe(true);
    const data = result.data as string[];
    expect(data).toHaveLength(10);
    expect(data.every((d) => d === 'Slackware')).toBe(true);
    expect(result.callsMade).toBe(10);
  });

  it('supports mixing sequential awaits across query, mutation-like, and raw graphql calls', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        const a = await unraid.local.query.info({ fields: ['os { distro }'] });
        const b = await unraid.local.graphql({ query: '{ apiKeys { id name } }' });
        const c = await unraid.local.query.shares({ fields: ['name', 'size'] });
        return { a, b, c };
      })()
    `);
    expect(result.ok).toBe(true);
    const data = result.data as {
      a: { os: { distro: string } };
      b: { apiKeys: Array<{ name: string }> };
      c: Array<{ name: string; size: number }>;
    };
    expect(data.a.os.distro).toBe('Slackware');
    expect(data.b.apiKeys[0]?.name).toBe('mcp');
    expect(data.c[0]?.name).toBe('media');
  });

  it('supports Promise.all parallel batching', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        const [i, k] = await Promise.all([
          unraid.local.query.info({ fields: ['os { distro }'] }),
          unraid.local.graphql({ query: '{ apiKeys { id name } }' }),
        ]);
        return { i, k };
      })()
    `);
    expect(result.ok).toBe(true);
    expect(result.callsMade).toBe(2);
  });

  it('rejects with a readable error when a GraphQL call fails (errors bubble through async)', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(`
      (async () => {
        try {
          await unraid.local.graphql({ query: '{ boom }' });
          return 'no throw';
        } catch (e) {
          return String(e && e.message);
        }
      })()
    `);
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('string');
    const msg = String(result.data);
    expect(msg).toMatch(/unraid\.local\.graphql/);
    expect(msg).toMatch(/expected failure/);
  });

  it('enforces the per-execute call budget', async () => {
    const executor = new ExecuteExecutor({
      tenant: {
        local: { baseUrl: mock.baseUrl, apiKey: 'mock' },
        requestId: 'test',
        fromHeaders: false,
      },
      localSpec: spec,
      buildLocalClient: (tenant) => {
        if (!tenant.local) throw new Error('test tenant missing local creds');
        return createUnraidClient({ baseUrl: mock.baseUrl, apiKey: tenant.local.apiKey });
      },
      limits: { maxCallsPerExecute: 3 },
    });
    const result = await executor.execute(`
      (async () => {
        const out = [];
        try {
          for (let i = 0; i < 10; i++) {
            out.push(await unraid.local.query.info({ fields: ['os { distro }'] }));
          }
          return { count: out.length };
        } catch (e) {
          return { count: out.length, err: String(e && e.message) };
        }
      })()
    `);
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; err: string };
    expect(data.count).toBe(3);
    expect(data.err).toMatch(/call limit exceeded/i);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecuteExecutor } from '../../sandbox/execute-executor.js';
import { loadFallbackSpec } from '../../spec/loader.js';
import type { ProcessedSpec } from '../../types/spec.js';
import { startMockServer, type MockServer } from './mock-server.js';
import { createUnraidClient } from '../../client/graphql.js';

/**
 * End-to-end-ish: a real ExecuteExecutor running real QuickJS, talking to a
 * tiny in-process node:http GraphQL server. Lets us cover the full path
 * from sandbox prelude → asyncified host call → undici fetch → response
 * → handle return → sandbox value.
 */
describe('integration: execute against mock GraphQL', () => {
  let mock: MockServer;
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
    mock = await startMockServer({
      // Match by `query` string (substring) → response body.
      handlers: [
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
});

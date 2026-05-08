import { describe, expect, it, beforeAll } from 'vitest';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { loadFallbackSpec } from '../spec/loader.js';
import type { ProcessedSpec } from '../types/spec.js';
import type { GraphqlClient } from '../client/graphql.js';

describe('SearchExecutor', () => {
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
  });

  it('exposes the index global', async () => {
    const executor = new SearchExecutor({ local: spec });
    const result = await executor.execute('index.namespace');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('local');
  });

  it('exposes searchOperations / getOperation / getType', async () => {
    const executor = new SearchExecutor({ local: spec });
    const result = await executor.execute(`
      var hits = searchOperations('info', 5);
      var op = getOperation('info');
      var t = getType('Info');
      ({ count: hits.length, hasInfo: !!op, infoType: t ? t.kind : null });
    `);
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; hasInfo: boolean; infoType: string | null };
    expect(data.count).toBeGreaterThan(0);
    expect(data.hasInfo).toBe(true);
  });

  it('captures console.log output', async () => {
    const executor = new SearchExecutor({ local: spec });
    const result = await executor.execute(`console.log('hello'); 1+1;`);
    expect(result.ok).toBe(true);
    expect(result.logs.map((l) => l.message)).toEqual(['hello']);
  });
});

describe('ExecuteExecutor', () => {
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
  });

  function buildExecutorWithMockClient(
    handler: (op: string, payload: string) => unknown,
    opts: { maxCalls?: number } = {},
  ): ExecuteExecutor {
    const fakeClient = {
      execute: () => Promise.resolve(null),
      rawHttp: { request: () => Promise.resolve({ status: 200, headers: {}, body: null }) },
    } as unknown as GraphqlClient;
    return new ExecuteExecutor({
      tenant: {
        local: { baseUrl: 'https://example', apiKey: 'k' },
        requestId: 'test',
        fromHeaders: false,
      },
      localSpec: spec,
      buildLocalClient: () => {
        // Return a stub client whose execute() invokes the supplied handler so
        // the tests can assert on the dispatch outcome without real HTTP.
        return {
          execute: (params: { query: string; variables?: Record<string, unknown> }) =>
            Promise.resolve(handler('execute', JSON.stringify(params))),
          rawHttp: fakeClient.rawHttp,
        } as unknown as GraphqlClient;
      },
      ...(opts.maxCalls !== undefined
        ? { limits: { maxCallsPerExecute: opts.maxCalls } }
        : {}),
    });
  }

  it('dispatches a query with a shorthand fields array', async () => {
    let captured: { query: string; variables?: Record<string, unknown> } | undefined;
    const executor = buildExecutorWithMockClient((_op, payload) => {
      captured = JSON.parse(payload) as typeof captured;
      // GraphqlClient unwraps the outer `{ data: ... }` envelope before
      // returning to dispatch, so the mock here returns the inner field map.
      return { info: { os: { distro: 'Slackware' } } };
    });
    const result = await executor.execute(
      `(async () => unraid.local.query.info({ fields: ['os { distro }'] }))()`,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ os: { distro: 'Slackware' } });
    expect(captured?.query).toContain('info');
    expect(captured?.query).toContain('os { distro }');
  });

  it('tags missing-selection errors clearly', async () => {
    const executor = buildExecutorWithMockClient(() => null);
    const result = await executor.execute(
      `(async () => unraid.local.query.info({}))()`,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[unraid.local.graphql]');
  });

  it('enforces the per-execute call budget', async () => {
    const executor = buildExecutorWithMockClient(() => ({ info: { os: {} } }), {
      maxCalls: 2,
    });
    const code = `
      (async function() {
        var calls = [];
        for (var i = 0; i < 5; i++) {
          calls.push(unraid.local.query.info({ fields: ['os { distro }'] }));
        }
        return await Promise.all(calls);
      })()
    `;
    const result = await executor.execute(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/call limit exceeded/i);
  });

  it('handles a raw graphql() call', async () => {
    let captured: { query: string } | undefined;
    const executor = buildExecutorWithMockClient((_op, payload) => {
      captured = JSON.parse(payload) as typeof captured;
      // Raw graphql() returns the unwrapped data envelope as-is.
      return { ping: 'pong' };
    });
    const result = await executor.execute(
      `(async () => unraid.local.graphql({ query: '{ ping }' }))()`,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ping: 'pong' });
    expect(captured?.query).toBe('{ ping }');
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { buildDispatcher, HttpClient } from '../client/http.js';
import { GraphqlClient } from '../client/graphql.js';
import { UnraidGraphqlError, UnraidHttpError } from '../client/types.js';

describe('HttpClient + GraphqlClient', () => {
  let originalDispatcher: Dispatcher;
  let mockAgent: MockAgent;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it('sends the x-api-key header on every request', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool
      .intercept({
        path: '/graphql',
        method: 'POST',
        headers: (h) => h['x-api-key'] === 'secret',
      })
      .reply(200, { data: { ping: 'pong' } }, { headers: { 'content-type': 'application/json' } });

    const client = new GraphqlClient(
      new HttpClient({ baseUrl: 'https://tower.local', apiKey: 'secret' }),
    );
    const data = await client.execute<{ ping: string }>({ query: '{ ping }' });
    expect(data.ping).toBe('pong');
  });

  it('builds a dispatcher with a custom CA when supplied', () => {
    const dispatcher = buildDispatcher({ caCert: '-----BEGIN CERTIFICATE-----' });
    expect(dispatcher).toBeDefined();
  });

  it('builds a dispatcher in insecure mode when requested', () => {
    const dispatcher = buildDispatcher({ insecure: true });
    expect(dispatcher).toBeDefined();
  });

  it('returns no dispatcher when no TLS options are set (uses global)', () => {
    expect(buildDispatcher({})).toBeUndefined();
  });

  it('warns when constructed in insecure mode', () => {
    const warns: string[] = [];
    new HttpClient({
      baseUrl: 'https://tower.local',
      apiKey: 'k',
      insecure: true,
      onWarn: (m) => warns.push(m),
    });
    expect(warns.some((w) => w.toLowerCase().includes('insecure'))).toBe(true);
  });

  it('maps non-2xx HTTP responses to UnraidHttpError', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(401, { message: 'unauthorized' }, { headers: { 'content-type': 'application/json' } });

    const client = new GraphqlClient(
      new HttpClient({ baseUrl: 'https://tower.local', apiKey: 'wrong' }),
    );
    await expect(client.execute({ query: '{ ok }' })).rejects.toBeInstanceOf(UnraidHttpError);
  });

  it('maps GraphQL `errors` payloads to UnraidGraphqlError', async () => {
    const pool = mockAgent.get('https://tower.local');
    pool.intercept({ path: '/graphql', method: 'POST' }).reply(
      200,
      {
        data: null,
        errors: [{ message: 'no permission' }],
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = new GraphqlClient(
      new HttpClient({ baseUrl: 'https://tower.local', apiKey: 'k' }),
    );
    await expect(client.execute({ query: '{ ok }' })).rejects.toBeInstanceOf(UnraidGraphqlError);
  });

  it('surfaces GraphQL validation errors when the server responds with HTTP 400', async () => {
    // Unraid 7.2 returns HTTP 400 (not 200) when the server can validate the
    // document but the field/type is unknown — e.g. when the bundled SDL has
    // drifted from the live schema. The HTTP client must turn the body's
    // `errors[]` array into a readable detail string so the LLM can fix its
    // selection.
    const pool = mockAgent.get('https://tower.local');
    pool.intercept({ path: '/graphql', method: 'POST' }).reply(
      400,
      {
        errors: [
          {
            message: 'Cannot query field "banner" on type "InfoDisplay".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = new GraphqlClient(
      new HttpClient({ baseUrl: 'https://tower.local', apiKey: 'k' }),
    );
    let captured: unknown;
    try {
      await client.execute({ query: '{ display { banner } }' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UnraidHttpError);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/Cannot query field "banner" on type "InfoDisplay"/);
    expect(msg).toMatch(/GRAPHQL_VALIDATION_FAILED/);
  });
});

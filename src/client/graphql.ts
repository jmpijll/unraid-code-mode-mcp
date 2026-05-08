/**
 * Unraid GraphQL client — thin wrapper around HttpClient that posts queries
 * to `${baseUrl}/graphql` and normalizes errors.
 *
 * The Unraid 7.2+ API exposes a single GraphQL endpoint and authenticates
 * via the `x-api-key` header (mint with the `unraid-api apikey` CLI or via
 * the Settings → Management Access → API Keys panel in the web UI).
 */

import { HttpClient } from './http.js';
import type { UnraidCreds } from '../tenant/context.js';
import { UnraidGraphqlError } from './types.js';
import type { GraphqlRequestParams, GraphqlResponse } from './types.js';

export interface UnraidClientOptions {
  onWarn?: (msg: string) => void;
}

const GRAPHQL_PATH = '/graphql';

export class GraphqlClient {
  constructor(private readonly http: HttpClient) {}

  /** POST a GraphQL document to `${baseUrl}/graphql`. */
  async execute<T = unknown, TVars = Record<string, unknown>>(
    params: GraphqlRequestParams<TVars>,
  ): Promise<T> {
    const body: Record<string, unknown> = { query: params.query };
    if (params.variables !== undefined) body['variables'] = params.variables;
    if (params.operationName !== undefined) body['operationName'] = params.operationName;

    const res = await this.http.request<GraphqlResponse<T>>({
      method: 'POST',
      path: GRAPHQL_PATH,
      body,
      headers: { 'Content-Type': 'application/json' },
    });

    // res.body is typed as GraphqlResponse<T> but the underlying HTTP client
    // can return undefined when the server replies with a non-JSON body.
    const payload: GraphqlResponse<T> | undefined = res.body;
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    if (payload?.errors && payload.errors.length > 0) {
      const summary = payload.errors.map((e) => e.message || 'unknown GraphQL error').join('; ');
      throw new UnraidGraphqlError(`GraphQL error: ${summary}`, payload.errors, payload.data);
    }
    if (!payload || payload.data === undefined) {
      throw new UnraidGraphqlError('GraphQL response had no data and no errors', [
        { message: 'empty response' },
      ]);
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    return payload.data;
  }

  /** Raw access to the underlying HttpClient — used by `unraid.local.request`. */
  get rawHttp(): HttpClient {
    return this.http;
  }
}

export function createUnraidClient(
  creds: UnraidCreds,
  opts: UnraidClientOptions = {},
): GraphqlClient {
  const http = new HttpClient({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    caCert: creds.caCert,
    insecure: creds.insecure,
    label: 'unraid.local',
    onWarn: opts.onWarn,
  });
  return new GraphqlClient(http);
}

/**
 * Shared client types — what the sandbox sees when it calls request() / graphql().
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface UnraidRequestParams {
  /** HTTP method (case-insensitive) — default GET. */
  method?: HttpMethod | Lowercase<HttpMethod>;
  /** Path under the API server (e.g. "/graphql" or "/api/info"). */
  path: string;
  /** Query parameters. Arrays are repeated; booleans become "true"/"false". */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** Extra headers (Content-Type and x-api-key are set automatically). */
  headers?: Record<string, string>;
}

export interface UnraidResponse<T = unknown> {
  /** HTTP status code. */
  status: number;
  /** Response headers as a plain object. */
  headers: Record<string, string>;
  /** Parsed JSON response body, or text fallback. */
  body: T;
}

export interface GraphqlRequestParams<TVars = Record<string, unknown>> {
  /** GraphQL document (query, mutation, or fragment). */
  query: string;
  /** Variables object — JSON-serialized into the POST body. */
  variables?: TVars;
  /** Optional named operation when the document contains multiple operations. */
  operationName?: string;
}

export interface GraphqlResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
    extensions?: Record<string, unknown>;
  }>;
  extensions?: Record<string, unknown>;
}

export class UnraidHttpError extends Error {
  override readonly name = 'UnraidHttpError';
  public readonly status: number;
  public override readonly cause?: unknown;
  constructor(
    message: string,
    status: number,
    public readonly path: string,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.status = status;
  }
}

export class UnraidTransportError extends Error {
  override readonly name = 'UnraidTransportError';
  public override readonly cause?: unknown;
  constructor(
    message: string,
    public readonly path: string,
    cause?: unknown,
  ) {
    super(message);
    this.cause = cause;
  }
}

export class UnraidGraphqlError extends Error {
  override readonly name = 'UnraidGraphqlError';
  constructor(
    message: string,
    public readonly errors: NonNullable<GraphqlResponse['errors']>,
    public readonly partial?: unknown,
  ) {
    super(message);
  }
}

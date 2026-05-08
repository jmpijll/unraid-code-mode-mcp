/**
 * Host-side dispatch — turns sandbox calls into real GraphQL operations.
 *
 * Three entry points consumed by the execute sandbox:
 *
 *   - dispatchOperation(): named operation lookup. The LLM calls
 *     `unraid.local.query.info({ args, fields })` which becomes a call here.
 *     We synthesize a `query op($a: T!) { field(arg: $a) { selection } }`
 *     document on the fly, matching the introspected arg types.
 *
 *   - dispatchGraphql(): the LLM writes a full GraphQL document and passes
 *     it through. The host posts it to /graphql with the supplied variables.
 *
 *   - dispatchRawRequest(): the LLM calls `unraid.local.request({ method,
 *     path, body, headers })`. Used to talk to non-GraphQL HTTP endpoints
 *     on the Unraid server (rare; primarily an escape hatch).
 *
 * Together these three cover everything the sandbox needs to talk to the
 * GraphQL API. The host enforces credentials, TLS, and the call budget;
 * none of those leak into the sandbox.
 */

import type { GraphqlClient } from '../client/graphql.js';
import type {
  GraphqlRequestParams,
  UnraidRequestParams,
  UnraidResponse,
} from '../client/types.js';
import { getOperation, stringifyTypeRef } from '../spec/index.js';
import { sanitizeIdentifier } from './../spec/index-builder.js';
import type { ArgInfo, IndexedOperation, ProcessedSpec, TypeRef } from '../types/spec.js';

// ─── Errors ─────────────────────────────────────────────────────────

export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError';
  constructor(
    public readonly namespace: string,
    public readonly operationName: string,
    public readonly kind?: 'query' | 'mutation',
  ) {
    super(
      `No ${kind ?? 'operation'} "${operationName}" in unraid.${namespace} schema`,
    );
  }
}

export class SelectionRequiredError extends Error {
  override readonly name = 'SelectionRequiredError';
  constructor(opName: string, returnTypeName: string) {
    super(
      `Operation "${opName}" returns "${returnTypeName}" — pass a \`fields\` selection ` +
        '(either a GraphQL selection-set string or an array of leaf field names).',
    );
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export interface DispatchOperationArgs {
  /** Field arguments (mapped to GraphQL `$variables`). */
  args?: Record<string, unknown>;
  /**
   * Selection set. Either:
   *   - a GraphQL selection-set string (without the wrapping braces), or
   *   - a shorthand array of leaf-field names that get joined with spaces.
   * Optional/ignored when the return type is a scalar/enum.
   */
  fields?: string | string[];
}

/**
 * Dispatch a typed query/mutation. Builds the GraphQL document from the
 * indexed operation, then POSTs it via the supplied client.
 *
 * The sandbox-facing return value is unwrapped to the field's value rather
 * than the GraphQL `data` envelope. So
 *
 *   await unraid.local.query.info({ fields: ['os { distro }'] })
 *
 * resolves to `{ os: { distro: 'Slackware' } }` rather than
 * `{ info: { os: { distro: 'Slackware' } } }`. This matches what the LLM
 * "expected" intuitively when picking a single field-level call.
 */
export async function dispatchOperation(
  client: GraphqlClient,
  spec: ProcessedSpec,
  namespace: string,
  operationName: string,
  payload: DispatchOperationArgs = {},
  kind?: 'query' | 'mutation',
): Promise<unknown> {
  const op = getOperation(spec, operationName, kind);
  if (!op) throw new UnknownOperationError(namespace, operationName, kind);

  const document = buildOperationDocument(op, payload.fields);
  const variables = buildVariables(op, payload.args ?? {});
  const data: unknown = await client.execute({ query: document, variables });
  if (data && typeof data === 'object' && op.name in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)[op.name];
  }
  return data;
}

/** Dispatch a free-form GraphQL document. */
export async function dispatchGraphql(
  client: GraphqlClient,
  payload: GraphqlRequestParams,
): Promise<unknown> {
  if (typeof payload !== 'object' || typeof payload.query !== 'string') {
    throw new Error(
      'graphql() argument must be an object with at least a string `query` field. ' +
        'Example: unraid.local.graphql({ query: "{ info { os { distro } } }" })',
    );
  }
  return client.execute(payload);
}

/** Dispatch a raw HTTP request via the underlying HttpClient. */
export async function dispatchRawRequest(
  client: GraphqlClient,
  args: UnraidRequestParams,
): Promise<UnraidResponse> {
  if (typeof args !== 'object' || typeof args.path !== 'string') {
    throw new Error(
      'request() argument must be an object with at least a string `path` field. ' +
        'Example: unraid.local.request({ method: "GET", path: "/health" })',
    );
  }
  return client.rawHttp.request(args);
}

// ─── Document building ──────────────────────────────────────────────

/**
 * Synthesize a GraphQL document for an indexed operation.
 *
 * Shape:
 *   query|mutation $op($a1: T1, $a2: T2) {
 *     fieldName(a1: $a1, a2: $a2) {
 *       <selection>
 *     }
 *   }
 *
 * If the return type is a scalar/enum, the selection set is omitted (and
 * any `fields` argument is ignored). When the return type is complex and
 * `fields` is missing, throw a clear error so the LLM knows it has to
 * pick a selection.
 */
export function buildOperationDocument(
  op: IndexedOperation,
  fields: string | string[] | undefined,
): string {
  const safeOpName = sanitizeIdentifier(`${op.kind}_${op.name}`);
  const argsList = op.args
    .map((a) => `$${a.name}: ${stringifyTypeRef(a.type)}`)
    .join(', ');
  const argsApply = op.args.map((a) => `${a.name}: $${a.name}`).join(', ');

  const head =
    `${op.kind} ${safeOpName}` + (argsList.length > 0 ? `(${argsList})` : '');
  const fieldCall =
    op.args.length > 0 ? `${op.name}(${argsApply})` : op.name;

  const namedReturn = unwrapToNamed(op.returnType);
  const isLeaf =
    namedReturn?.kind === 'SCALAR' || namedReturn?.kind === 'ENUM' || namedReturn === undefined;

  if (isLeaf) {
    return `${head} { ${fieldCall} }`;
  }

  let selection: string;
  if (Array.isArray(fields)) {
    if (fields.length === 0) {
      throw new SelectionRequiredError(op.name, namedReturn.name ?? '<unknown>');
    }
    selection = fields.join(' ');
  } else if (typeof fields === 'string' && fields.trim().length > 0) {
    selection = fields.trim();
  } else if (op.returnTypeFields.length > 0) {
    // No selection requested → fail loud rather than silently picking a
    // guess. LLMs benefit from being told explicitly that they need to
    // select fields, with the candidate list as a hint.
    throw new SelectionRequiredError(op.name, namedReturn.name ?? '<unknown>');
  } else {
    throw new SelectionRequiredError(op.name, namedReturn.name ?? '<unknown>');
  }

  return `${head} { ${fieldCall} { ${selection} } }`;
}

function buildVariables(
  op: IndexedOperation,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const argSpec of op.args) {
    if (argSpec.name in args) {
      vars[argSpec.name] = args[argSpec.name];
    }
  }
  return vars;
}

function unwrapToNamed(t: TypeRef): TypeRef | undefined {
  let cur: TypeRef | undefined = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    cur = cur.ofType;
  }
  return cur;
}

// ─── Prelude builder ────────────────────────────────────────────────

/**
 * Build a JS prelude that creates the `unraid` namespace at sandbox init
 * time. The prelude wires every `query` and `mutation` field to a host
 * binding that delegates back to TypeScript via `newAsyncifiedFunction`.
 *
 * Output shape:
 *   unraid.local.graphql({ query, variables, operationName }) -> any
 *   unraid.local.query.<fieldName>({ args, fields }) -> any
 *   unraid.local.mutation.<fieldName>({ args, fields }) -> any
 *   unraid.local.request({ method, path, body, headers }) -> { status, body }
 *   unraid.local.spec -> { title, version, sourceUrl, ... }
 */
export function buildUnraidPrelude(localSpec: ProcessedSpec | undefined): string {
  const lines: string[] = [];
  lines.push('var unraid = {};');

  if (!localSpec) {
    const message =
      'No spec loaded for unraid.local. Provide UNRAID_BASE_URL + UNRAID_API_KEY ' +
      'via env (single-user) or X-Unraid-Base-Url + X-Unraid-Api-Key headers (multi-user).';
    lines.push(
      `unraid.local = { __missing: true, ` +
        `graphql: function() { throw new Error(${JSON.stringify(message)}); }, ` +
        `request: function() { throw new Error(${JSON.stringify(message)}); }, ` +
        `query: {}, mutation: {} };`,
    );
    return lines.join('\n');
  }

  const queries = localSpec.operations.filter((o) => o.kind === 'query');
  const mutations = localSpec.operations.filter((o) => o.kind === 'mutation');

  const usedQueryNames = new Set<string>();
  const usedMutationNames = new Set<string>();

  lines.push('unraid.local = (function() {');
  lines.push('  var ns = {');
  lines.push(
    `    spec: ${JSON.stringify({
      title: localSpec.title,
      version: localSpec.version,
      sourceUrl: localSpec.sourceUrl,
      queryCount: localSpec.queryCount,
      mutationCount: localSpec.mutationCount,
    })},`,
  );
  lines.push(
    '    graphql: function(args) { return __unraidCallLocalGraphql(JSON.stringify(args || {})); },',
  );
  lines.push(
    '    request: function(args) { return __unraidRawLocal(JSON.stringify(args || {})); }',
  );
  lines.push('  };');

  lines.push('  ns.query = {};');
  for (const op of queries) {
    const jsName = uniqueIdentifier(op.jsName, usedQueryNames);
    lines.push(
      `  ns.query.${jsName} = function(payload) { return __unraidCallLocal(${JSON.stringify(op.name)}, "query", JSON.stringify(payload || {})); };`,
    );
  }

  lines.push('  ns.mutation = {};');
  for (const op of mutations) {
    const jsName = uniqueIdentifier(op.jsName, usedMutationNames);
    lines.push(
      `  ns.mutation.${jsName} = function(payload) { return __unraidCallLocal(${JSON.stringify(op.name)}, "mutation", JSON.stringify(payload || {})); };`,
    );
  }

  lines.push('  return ns;');
  lines.push('})();');

  return lines.join('\n');
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${String(i)}`)) i += 1;
  const candidate = `${base}_${String(i)}`;
  used.add(candidate);
  return candidate;
}

export function lookupArgType(op: IndexedOperation, name: string): ArgInfo | undefined {
  return op.args.find((a) => a.name === name);
}

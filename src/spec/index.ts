/**
 * Spec module entry — re-exports + helpers for working with a ProcessedSpec.
 */

import type { IndexedOperation, NamedTypeEntry, ProcessedSpec, TypeRef } from '../types/spec.js';

export {
  loadUnraidSpec,
  loadFallbackSpec,
  CACHE_SCHEMA_VERSION,
  clearSpecCache,
} from './loader.js';
export {
  buildOperationIndex,
  convertTypeRef,
  unwrapToNamed,
  sanitizeIdentifier,
} from './index-builder.js';

/**
 * Look up an operation by name (`info`, `array.start`, …).
 *
 * GraphQL allows the same field name to exist as both a query and a mutation
 * (Unraid does this for `array`, `docker`, etc.), so when the caller knows
 * which one it wants it can pass `kind` to disambiguate. Without `kind` the
 * first match wins, which is fine for read-only schema exploration.
 */
export function getOperation(
  spec: ProcessedSpec,
  name: string,
  kind?: IndexedOperation['kind'],
): IndexedOperation | undefined {
  if (kind) return spec.operations.find((o) => o.name === name && o.kind === kind);
  return spec.operations.find((o) => o.name === name);
}

/** Find every operation whose name contains the given substring (case-insensitive). */
export function findOperationsByName(spec: ProcessedSpec, substring: string): IndexedOperation[] {
  const q = substring.toLowerCase();
  return spec.operations.filter((o) => o.name.toLowerCase().includes(q));
}

/** Look up a named type by name from the compact type map. */
export function getType(spec: ProcessedSpec, name: string): NamedTypeEntry | undefined {
  return spec.types[name];
}

/**
 * Substring/keyword search across name, description, args, and return type
 * names. Case-insensitive, whitespace-tolerant. Returns a ranked list.
 */
export function searchOperations(
  spec: ProcessedSpec,
  query: string,
  limit = 25,
): IndexedOperation[] {
  const q = query.toLowerCase().trim();
  if (!q) return spec.operations.slice(0, limit);

  const scored: Array<{ op: IndexedOperation; score: number }> = [];
  for (const op of spec.operations) {
    let score = 0;
    const lcName = op.name.toLowerCase();
    if (lcName === q) score += 100;
    else if (lcName.includes(q)) score += 30;
    if (op.description.toLowerCase().includes(q)) score += 10;
    if (op.args.some((a) => a.name.toLowerCase().includes(q))) score += 8;
    if (op.tags.some((t) => t.includes(q))) score += 5;
    const returnTypeName = unwrappedTypeName(op.returnType);
    if (returnTypeName && returnTypeName.toLowerCase().includes(q)) score += 6;
    if (score > 0) scored.push({ op, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.op);
}

function unwrappedTypeName(t: TypeRef): string | undefined {
  let cur: TypeRef | undefined = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    cur = cur.ofType;
  }
  return cur?.name;
}

/**
 * Compact each operation for safe serialization into the sandbox. The shape
 * here mirrors what `searchOperations` returns — just smaller because we
 * drop type entries and full type metadata.
 */
export function summarizeOperation(op: IndexedOperation): Record<string, unknown> {
  return {
    kind: op.kind,
    namespace: op.namespace,
    name: op.name,
    description: op.description || undefined,
    args: op.args.map((a) => ({
      name: a.name,
      type: stringifyTypeRef(a.type),
      ...(a.defaultValue !== undefined ? { defaultValue: a.defaultValue } : {}),
    })),
    returnType: stringifyTypeRef(op.returnType),
    returnTypeFields: op.returnTypeFields.length > 0 ? op.returnTypeFields : undefined,
    deprecated: op.deprecated || undefined,
  };
}

/** Convert a TypeRef into a compact GraphQL-style string (e.g. "[String!]!"). */
export function stringifyTypeRef(t: TypeRef): string {
  if (t.kind === 'NON_NULL') return `${t.ofType ? stringifyTypeRef(t.ofType) : '?'}!`;
  if (t.kind === 'LIST') return `[${t.ofType ? stringifyTypeRef(t.ofType) : '?'}]`;
  return t.name ?? '<unknown>';
}

/** Helper for diagnostics. */
export function specSummary(spec: ProcessedSpec): {
  title: string;
  version: string;
  operationCount: number;
  queryCount: number;
  mutationCount: number;
  typeCount: number;
} {
  return {
    title: spec.title,
    version: spec.version,
    operationCount: spec.operations.length,
    queryCount: spec.queryCount,
    mutationCount: spec.mutationCount,
    typeCount: Object.keys(spec.types).length,
  };
}

/**
 * Shared GraphQL spec types — what the host and sandbox both reason about.
 *
 * The Unraid GraphQL schema is ingested via standard introspection, then
 * compacted into an `OperationIndex` of every `Query` and `Mutation` field
 * partitioned by namespace. The compact shape is JSON-serializable so it
 * can be injected into the QuickJS sandbox alongside lookup helpers.
 */

/** A namespace key — v0 only uses `local`. `connect` is reserved. */
export type Namespace = 'local' | 'connect';

/** Compact representation of a GraphQL type reference (no recursion via $ref). */
export interface TypeRef {
  /** GraphQL type kind. */
  kind:
    | 'SCALAR'
    | 'OBJECT'
    | 'INTERFACE'
    | 'UNION'
    | 'ENUM'
    | 'INPUT_OBJECT'
    | 'LIST'
    | 'NON_NULL';
  /** Named-type name when applicable (always set on the leaf node). */
  name?: string;
  /** Wrapped inner type for LIST / NON_NULL kinds. */
  ofType?: TypeRef;
}

export interface ArgInfo {
  name: string;
  description?: string;
  type: TypeRef;
  /** GraphQL default value, encoded as a string the way introspection emits it. */
  defaultValue?: string;
}

/** A single Query or Mutation field, fully indexed for search + dispatch. */
export interface IndexedOperation {
  /** `query` or `mutation`. */
  kind: 'query' | 'mutation';
  /** Always `local` in v0; `connect` reserved for the future. */
  namespace: Namespace;
  /** GraphQL field name (e.g. `info`, `array.start`). */
  name: string;
  /** Sanitized identifier that survives JS sandbox property access. */
  jsName: string;
  /** GraphQL description (truncated to fit the index). */
  description: string;
  /** Field arguments. */
  args: ArgInfo[];
  /** Return type (full TypeRef chain — preserves NON_NULL / LIST wrappers). */
  returnType: TypeRef;
  /** Top-level field names of the named return type, when it's a complex object. */
  returnTypeFields: string[];
  /** Search-friendly tags collected from name segments and the named return type. */
  tags: string[];
  /** Whether the field is marked `@deprecated`. */
  deprecated: boolean;
}

/** Compact named-type entry stored in the index for `getType()` lookups. */
export interface NamedTypeEntry {
  name: string;
  kind: 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';
  description?: string;
  /** Field names → return type kind for OBJECT / INTERFACE / INPUT_OBJECT. */
  fields?: Array<{ name: string; description?: string; type: TypeRef }>;
  /** Member type names for UNION. */
  possibleTypes?: string[];
  /** Enum values for ENUM. */
  enumValues?: Array<{ name: string; description?: string; deprecated?: boolean }>;
}

/** Top-level processed spec — the canonical shape passed to executors. */
export interface ProcessedSpec {
  /** Source URL where the introspection result was fetched. */
  sourceUrl: string;
  /** Free-form version string (e.g. controller's reported version, or "fallback"). */
  version: string;
  /** Friendly title. */
  title: string;
  /** Namespace this spec belongs to. */
  namespace: Namespace;
  /** Flattened operations (queries + mutations). */
  operations: IndexedOperation[];
  /** Named types keyed by name — for `getType()` lookups. */
  types: Record<string, NamedTypeEntry>;
  /** Number of queries (cached for diagnostics). */
  queryCount: number;
  /** Number of mutations (cached for diagnostics). */
  mutationCount: number;
}

/**
 * The compact, JSON-serializable shape we inject into the search sandbox.
 * It carries everything the LLM helpers need to discover operations.
 */
export interface OperationIndex {
  namespace: Namespace;
  title: string;
  version: string;
  sourceUrl: string;
  operations: IndexedOperation[];
  types: Record<string, NamedTypeEntry>;
}

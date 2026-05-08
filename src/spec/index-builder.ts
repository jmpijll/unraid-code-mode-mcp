/**
 * Build the lightweight operations index from a GraphQL introspection result.
 *
 * The index is the data structure exposed to the `search` sandbox and the
 * `execute` dispatcher. It must stay small and JSON-serializable.
 *
 * We walk the introspection JSON and emit one `IndexedOperation` per field
 * of `Query` and `Mutation`. Each operation captures the args (with full
 * TypeRef chains), return type, and — when the return type is a complex
 * object — the top-level field names so the LLM can pick a sensible
 * default selection set.
 */

import type {
  ArgInfo,
  IndexedOperation,
  Namespace,
  NamedTypeEntry,
  TypeRef,
} from '../types/spec.js';

const MAX_DESCRIPTION_LENGTH = 500;

// ─── Introspection JSON shape (subset we care about) ────────────────

interface IntrospectionType {
  kind: string;
  name?: string | null;
  description?: string | null;
  fields?: IntrospectionField[] | null;
  inputFields?: IntrospectionInputValue[] | null;
  enumValues?: Array<{
    name: string;
    description?: string | null;
    isDeprecated?: boolean | null;
  }> | null;
  possibleTypes?: Array<{ name?: string | null }> | null;
}

interface IntrospectionField {
  name: string;
  description?: string | null;
  args?: IntrospectionInputValue[] | null;
  type: IntrospectionTypeRef;
  isDeprecated?: boolean | null;
}

interface IntrospectionInputValue {
  name: string;
  description?: string | null;
  type: IntrospectionTypeRef;
  defaultValue?: string | null;
}

interface IntrospectionTypeRef {
  kind: string;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
}

interface IntrospectionSchema {
  queryType?: { name?: string | null } | null;
  mutationType?: { name?: string | null } | null;
  types: IntrospectionType[];
}

export interface IntrospectionResult {
  __schema: IntrospectionSchema;
}

// ─── Builder ────────────────────────────────────────────────────────

export interface BuildIndexResult {
  operations: IndexedOperation[];
  types: Record<string, NamedTypeEntry>;
}

export function buildOperationIndex(
  introspection: IntrospectionResult,
  namespace: Namespace = 'local',
): BuildIndexResult {
  const schema = introspection.__schema;
  const typesByName = new Map<string, IntrospectionType>();
  for (const t of schema.types) {
    if (typeof t.name === 'string') typesByName.set(t.name, t);
  }

  const namedTypes: Record<string, NamedTypeEntry> = {};
  for (const t of schema.types) {
    if (typeof t.name !== 'string' || t.name.startsWith('__')) continue;
    namedTypes[t.name] = compactNamedType(t);
  }

  const operations: IndexedOperation[] = [];

  const queryTypeName = schema.queryType?.name;
  const mutationTypeName = schema.mutationType?.name;

  if (queryTypeName) {
    const root = typesByName.get(queryTypeName);
    for (const field of root?.fields ?? []) {
      operations.push(buildOperation('query', namespace, field, typesByName));
    }
  }
  if (mutationTypeName) {
    const root = typesByName.get(mutationTypeName);
    for (const field of root?.fields ?? []) {
      operations.push(buildOperation('mutation', namespace, field, typesByName));
    }
  }

  // Stable sort: kind, then name. Produces predictable test output.
  operations.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return { operations, types: namedTypes };
}

function buildOperation(
  kind: 'query' | 'mutation',
  namespace: Namespace,
  field: IntrospectionField,
  typesByName: Map<string, IntrospectionType>,
): IndexedOperation {
  const description = (field.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH);
  const args: ArgInfo[] = (field.args ?? []).map((a) => {
    const arg: ArgInfo = {
      name: a.name,
      type: convertTypeRef(a.type),
    };
    if (a.description) arg.description = a.description;
    if (a.defaultValue !== null && a.defaultValue !== undefined) {
      arg.defaultValue = a.defaultValue;
    }
    return arg;
  });
  const returnType = convertTypeRef(field.type);
  const namedReturn = unwrapToNamed(returnType);
  const namedReturnType =
    namedReturn?.name !== undefined ? typesByName.get(namedReturn.name) : undefined;
  const returnTypeFields = collectTopLevelFieldNames(namedReturnType);
  const tags = collectTags(field.name, namedReturn?.name);

  return {
    kind,
    namespace,
    name: field.name,
    jsName: sanitizeIdentifier(field.name),
    description,
    args,
    returnType,
    returnTypeFields,
    tags,
    deprecated: Boolean(field.isDeprecated),
  };
}

function compactNamedType(t: IntrospectionType): NamedTypeEntry {
  const entry: NamedTypeEntry = {
    name: t.name ?? '<unknown>',
    kind: t.kind as NamedTypeEntry['kind'],
  };
  if (t.description) entry.description = t.description;
  if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
    entry.fields = (t.fields ?? []).map((f) => ({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      type: convertTypeRef(f.type),
    }));
  }
  if (t.kind === 'INPUT_OBJECT') {
    entry.fields = (t.inputFields ?? []).map((f) => ({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      type: convertTypeRef(f.type),
    }));
  }
  if (t.kind === 'UNION') {
    entry.possibleTypes = (t.possibleTypes ?? [])
      .map((p) => p.name)
      .filter((n): n is string => typeof n === 'string');
  }
  if (t.kind === 'ENUM') {
    entry.enumValues = (t.enumValues ?? []).map((v) => ({
      name: v.name,
      ...(v.description ? { description: v.description } : {}),
      ...(v.isDeprecated ? { deprecated: true } : {}),
    }));
  }
  return entry;
}

// ─── Helpers ────────────────────────────────────────────────────────

export function convertTypeRef(t: IntrospectionTypeRef): TypeRef {
  const kind = t.kind as TypeRef['kind'];
  const out: TypeRef = { kind };
  if (typeof t.name === 'string') out.name = t.name;
  if (t.ofType) out.ofType = convertTypeRef(t.ofType);
  return out;
}

export function unwrapToNamed(t: TypeRef): TypeRef | undefined {
  let cur: TypeRef | undefined = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    cur = cur.ofType;
  }
  return cur;
}

function collectTopLevelFieldNames(t: IntrospectionType | undefined): string[] {
  if (!t) return [];
  if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
    return (t.fields ?? []).map((f) => f.name);
  }
  return [];
}

function collectTags(fieldName: string, returnTypeName: string | undefined): string[] {
  const tags = new Set<string>();
  for (const part of splitCamelCase(fieldName)) {
    if (part.length > 0) tags.add(part.toLowerCase());
  }
  if (returnTypeName) {
    for (const part of splitCamelCase(returnTypeName)) {
      if (part.length > 0) tags.add(part.toLowerCase());
    }
  }
  return Array.from(tags);
}

function splitCamelCase(s: string): string[] {
  // Splits "getDockerContainers" → ["get", "Docker", "Containers"]; treats
  // contiguous uppercase runs as a single token (`HTTP` stays together).
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
]);

export function sanitizeIdentifier(input: string): string {
  let out = input.replace(/[^a-zA-Z0-9_$]/g, '_');
  if (out.length === 0 || /^[0-9]/.test(out)) out = `_${out}`;
  if (RESERVED_WORDS.has(out)) out = `${out}_`;
  return out;
}

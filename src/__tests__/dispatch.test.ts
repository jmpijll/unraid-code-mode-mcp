import { describe, expect, it, beforeAll } from 'vitest';
import {
  buildOperationDocument,
  buildUnraidPrelude,
  SelectionRequiredError,
} from '../sandbox/dispatch.js';
import { loadFallbackSpec } from '../spec/loader.js';
import { getOperation } from '../spec/index.js';
import type { ProcessedSpec } from '../types/spec.js';

describe('dispatch', () => {
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
  });

  describe('buildOperationDocument', () => {
    it('builds a query document with selection set', () => {
      const op = getOperation(spec, 'info');
      if (!op) throw new Error('info missing');
      const doc = buildOperationDocument(op, ['os { distro }']);
      expect(doc).toContain('query ');
      expect(doc).toContain('info');
      expect(doc).toContain('os { distro }');
    });

    it('omits selection set for scalar return types', () => {
      // findOperationsByName + look for any scalar-returning op
      const scalarOps = spec.operations.filter((o) => {
        let t = o.returnType;
        while (t.kind === 'NON_NULL' || t.kind === 'LIST') {
          if (!t.ofType) break;
          t = t.ofType;
        }
        return t.kind === 'SCALAR' || t.kind === 'ENUM';
      });
      expect(scalarOps.length).toBeGreaterThan(0);
      const op = scalarOps[0];
      if (!op) throw new Error('expected at least one scalar-returning op');
      const doc = buildOperationDocument(op, undefined);
      // No nested braces — just the field call plus the single wrapping pair.
      const innerBraces = doc.match(/\{/g)?.length ?? 0;
      expect(innerBraces).toBe(1);
    });

    it('throws when a non-scalar return type is missing fields', () => {
      const op = getOperation(spec, 'info');
      if (!op) throw new Error('info missing');
      expect(() => buildOperationDocument(op, undefined)).toThrow(SelectionRequiredError);
      expect(() => buildOperationDocument(op, [])).toThrow(SelectionRequiredError);
    });

    it('accepts a string selection set', () => {
      const op = getOperation(spec, 'info');
      if (!op) throw new Error('info missing');
      const doc = buildOperationDocument(op, 'os { distro release }');
      expect(doc).toContain('os { distro release }');
    });

    it('declares variables for arguments using their introspected type', () => {
      const opWithArgs = spec.operations.find((o) => o.args.length > 0);
      expect(opWithArgs).toBeDefined();
      if (!opWithArgs) return;
      const doc = buildOperationDocument(
        opWithArgs,
        opWithArgs.returnTypeFields.length > 0
          ? opWithArgs.returnTypeFields.slice(0, 1)
          : undefined,
      );
      // Must mention each arg as a typed variable.
      for (const a of opWithArgs.args) {
        expect(doc).toContain(`$${a.name}`);
      }
    });
  });

  describe('buildUnraidPrelude', () => {
    it('emits the unraid.local namespace when a spec is provided', () => {
      const prelude = buildUnraidPrelude(spec);
      expect(prelude).toContain('var unraid = {}');
      expect(prelude).toContain('unraid.local');
      expect(prelude).toContain('ns.query');
      expect(prelude).toContain('ns.mutation');
      expect(prelude).toContain('graphql:');
      expect(prelude).toContain('request:');
    });

    it('returns a __missing stub when no spec is provided', () => {
      const prelude = buildUnraidPrelude(undefined);
      expect(prelude).toContain('__missing: true');
      expect(prelude).toContain('throw new Error');
    });

    it('produces unique JS identifiers for every query and mutation', () => {
      const prelude = buildUnraidPrelude(spec);
      // Pull out every `ns.query.<name>` and `ns.mutation.<name>` declaration
      // and check none collide.
      const matches = [...prelude.matchAll(/ns\.(query|mutation)\.([a-zA-Z0-9_$]+) = function/g)];
      const queryNames = matches.filter((m) => m[1] === 'query').map((m) => m[2] ?? '');
      const mutationNames = matches.filter((m) => m[1] === 'mutation').map((m) => m[2] ?? '');
      expect(new Set(queryNames).size).toBe(queryNames.length);
      expect(new Set(mutationNames).size).toBe(mutationNames.length);
      expect(queryNames.length).toBe(spec.queryCount);
      expect(mutationNames.length).toBe(spec.mutationCount);
    });
  });
});

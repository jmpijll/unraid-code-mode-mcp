import { describe, expect, it, beforeAll } from 'vitest';
import {
  findOperationsByName,
  getOperation,
  getType,
  searchOperations,
  stringifyTypeRef,
  summarizeOperation,
} from '../spec/index.js';
import { loadFallbackSpec } from '../spec/loader.js';
import type { ProcessedSpec } from '../types/spec.js';

describe('spec index', () => {
  let spec: ProcessedSpec;

  beforeAll(async () => {
    spec = await loadFallbackSpec();
  });

  it('exposes a non-trivial operation set', () => {
    expect(spec.queryCount).toBeGreaterThan(10);
    expect(spec.mutationCount).toBeGreaterThan(10);
    expect(Object.keys(spec.types).length).toBeGreaterThan(50);
  });

  describe('searchOperations', () => {
    it('ranks exact name matches above substring matches', () => {
      const results = searchOperations(spec, 'info', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.name).toBe('info');
    });

    it('returns empty list for nonsense queries', () => {
      const results = searchOperations(spec, 'qweasdzxc-nothing-here-please', 25);
      expect(results).toEqual([]);
    });
  });

  describe('getOperation / findOperationsByName', () => {
    it('finds a known operation by exact name', () => {
      expect(getOperation(spec, 'info')).toBeDefined();
      expect(getOperation(spec, 'definitelyNotAField')).toBeUndefined();
    });

    it('disambiguates query vs mutation when the same name exists for both', () => {
      // `array` exists as both a query (read state) and a mutation (operations
      // such as setState). Without `kind` we get the first match, but with
      // `kind` the lookup is deterministic and returns the right one.
      const arrayQ = getOperation(spec, 'array', 'query');
      const arrayM = getOperation(spec, 'array', 'mutation');
      expect(arrayQ?.kind).toBe('query');
      expect(arrayM?.kind).toBe('mutation');
      // Same goes for `docker`.
      expect(getOperation(spec, 'docker', 'query')?.kind).toBe('query');
      expect(getOperation(spec, 'docker', 'mutation')?.kind).toBe('mutation');
    });

    it('finds operations by substring', () => {
      const matches = findOperationsByName(spec, 'docker');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((o) => o.name.toLowerCase().includes('docker'))).toBe(true);
    });
  });

  describe('getType', () => {
    it('returns a known named type', () => {
      const arrayType = getType(spec, 'UnraidArray');
      expect(arrayType).toBeDefined();
      expect(arrayType?.kind).toBe('OBJECT');
      expect(Array.isArray(arrayType?.fields)).toBe(true);
    });

    it('returns undefined for unknown types', () => {
      expect(getType(spec, 'NopeType_xyz')).toBeUndefined();
    });
  });

  describe('helpers', () => {
    it('stringifyTypeRef preserves NON_NULL/LIST wrappers', () => {
      expect(
        stringifyTypeRef({
          kind: 'NON_NULL',
          ofType: {
            kind: 'LIST',
            ofType: {
              kind: 'NON_NULL',
              ofType: { kind: 'SCALAR', name: 'String' },
            },
          },
        }),
      ).toBe('[String!]!');
    });

    it('summarizeOperation drops large fields', () => {
      const op = getOperation(spec, 'info');
      if (!op) throw new Error('expected info op to exist');
      const summary = summarizeOperation(op);
      expect(summary['name']).toBe('info');
      expect(summary['kind']).toBe('query');
      expect(typeof (summary['returnType'] as string)).toBe('string');
    });
  });
});

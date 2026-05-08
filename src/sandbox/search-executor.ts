/**
 * Search Executor — runs LLM-written JS against the GraphQL operation index.
 *
 * Sync QuickJS context. No network. Exposes:
 *   - `index` — the compact OperationIndex (operations + types).
 *   - `searchOperations(query, limit?)`  — ranked text search.
 *   - `getOperation(name)`               — full operation info.
 *   - `findOperationsByName(substring)`  — substring filter.
 *   - `getType(typeName)`                — full named-type info.
 *   - `console.log()`                    — captured into the tool output.
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core';
import {
  findOperationsByName,
  getOperation,
  getType,
  searchOperations,
  summarizeOperation,
} from '../spec/index.js';
import type { OperationIndex, ProcessedSpec } from '../types/spec.js';
import { BaseSyncExecutor, injectJsonValue } from './executor.js';
import { SEARCH_MAX_MEMORY_BYTES, SEARCH_TIMEOUT_MS } from './limits.js';

export interface SearchExecutorOptions {
  local?: ProcessedSpec;
}

export class SearchExecutor extends BaseSyncExecutor {
  private readonly local?: ProcessedSpec;

  constructor(options: SearchExecutorOptions) {
    super({ timeoutMs: SEARCH_TIMEOUT_MS, maxMemoryBytes: SEARCH_MAX_MEMORY_BYTES });
    this.local = options.local;
  }

  protected setupContext(
    context: QuickJSContext,
    _runtime: QuickJSRuntime,
    _warnings: string[],
  ): void {
    const compactIndex: OperationIndex | null = this.local
      ? {
          namespace: this.local.namespace,
          title: this.local.title,
          version: this.local.version,
          sourceUrl: this.local.sourceUrl,
          operations: this.local.operations,
          types: this.local.types,
        }
      : null;

    injectJsonValue(context, 'index', compactIndex);
    // `unraid` is a friendlier global mirroring the namespace tree the
    // execute tool exposes. In search mode it only carries the index.
    injectJsonValue(context, 'unraid', { local: compactIndex });

    const local = this.local;

    // searchOperations(query, limit?) — ranked text search.
    const searchFn = context.newFunction(
      'searchOperations',
      (qHandle: QuickJSHandle, limitHandle?: QuickJSHandle) => {
        if (!local) return jsonValueToHandle(context, []);
        const q = context.getString(qHandle);
        const limit = limitHandle ? context.getNumber(limitHandle) : 25;
        const ops = searchOperations(local, q, limit).map(summarizeOperation);
        return jsonValueToHandle(context, ops);
      },
    );
    context.setProp(context.global, 'searchOperations', searchFn);
    searchFn.dispose();

    // getOperation(name) — full operation info.
    const getOpFn = context.newFunction('getOperation', (nameHandle: QuickJSHandle) => {
      if (!local) return context.null;
      const name = context.getString(nameHandle);
      const op = getOperation(local, name);
      if (!op) return context.null;
      return jsonValueToHandle(context, op);
    });
    context.setProp(context.global, 'getOperation', getOpFn);
    getOpFn.dispose();

    // findOperationsByName(substring) — substring filter.
    const findByNameFn = context.newFunction('findOperationsByName', (subHandle: QuickJSHandle) => {
      if (!local) return jsonValueToHandle(context, []);
      const sub = context.getString(subHandle);
      const ops = findOperationsByName(local, sub).map(summarizeOperation);
      return jsonValueToHandle(context, ops);
    });
    context.setProp(context.global, 'findOperationsByName', findByNameFn);
    findByNameFn.dispose();

    // getType(typeName) — full named-type info.
    const getTypeFn = context.newFunction('getType', (nameHandle: QuickJSHandle) => {
      if (!local) return context.null;
      const name = context.getString(nameHandle);
      const type = getType(local, name);
      if (!type) return context.null;
      return jsonValueToHandle(context, type);
    });
    context.setProp(context.global, 'getType', getTypeFn);
    getTypeFn.dispose();
  }
}

function jsonValueToHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value);
  const result = context.evalCode(`(${json})`);
  if (result.error) {
    result.error.dispose();
    return context.null;
  }
  return result.value;
}

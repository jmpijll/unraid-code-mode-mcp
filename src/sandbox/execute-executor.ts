/**
 * Execute Executor — runs LLM-written JS that performs real Unraid GraphQL calls.
 *
 * Async QuickJS context. Per-tenant credentials are bound at construction
 * time so each MCP request gets its own short-lived executor.
 *
 * Sandbox surface:
 *   unraid.local.graphql({ query, variables, operationName }) -> Promise<any>
 *   unraid.local.query.<fieldName>({ args, fields }) -> Promise<any>
 *   unraid.local.mutation.<fieldName>({ args, fields }) -> Promise<any>
 *   unraid.local.request({ method, path, body, headers }) -> Promise<{ status, body }>
 *
 * Hosts are responsible for enforcing the per-execute call budget.
 */

import {
  newAsyncContext,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import { createUnraidClient } from '../client/graphql.js';
import type { GraphqlClient } from '../client/graphql.js';
import {
  UnraidGraphqlError,
  UnraidHttpError,
  type GraphqlRequestParams,
  type UnraidRequestParams,
} from '../client/types.js';
import {
  buildUnraidPrelude,
  dispatchGraphql,
  dispatchOperation,
  dispatchRawRequest,
  SelectionRequiredError,
  UnknownOperationError,
} from './dispatch.js';
import { configureRuntimeLimits, formatError, setupConsole } from './executor.js';
import { DEFAULT_LIMITS, type SandboxLimits } from './limits.js';
import type { ExecuteResult, LogEntry } from './types.js';
import { MissingCredentialsError, type TenantContext } from '../tenant/context.js';
import type { ProcessedSpec } from '../types/spec.js';

export interface ExecuteExecutorOptions {
  /** Tenant credentials — sandboxed clients are built from these on demand. */
  tenant: TenantContext;
  /** Local spec (mandatory for any unraid.local.* dispatch). */
  localSpec?: ProcessedSpec;
  /** Lazy client factory — only invoked if the sandbox actually issues a call. */
  buildLocalClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => GraphqlClient;
  /** Sandbox limits (timeout, memory, calls). */
  limits?: Partial<SandboxLimits>;
}

export class ExecuteExecutor {
  private readonly tenant: TenantContext;
  private readonly localSpec?: ProcessedSpec;
  private readonly limits: SandboxLimits;
  private readonly buildLocalClient: NonNullable<ExecuteExecutorOptions['buildLocalClient']>;

  constructor(opts: ExecuteExecutorOptions) {
    this.tenant = opts.tenant;
    this.localSpec = opts.localSpec;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.buildLocalClient = opts.buildLocalClient ?? defaultBuildLocalClient;
  }

  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];
    const warnings: string[] = [];
    let callsMade = 0;

    const context = await newAsyncContext();
    const runtime = context.runtime;

    let localClient: GraphqlClient | undefined;
    const onWarn = (msg: string): void => {
      if (!warnings.includes(msg)) warnings.push(msg);
    };

    try {
      configureRuntimeLimits(runtime, this.limits);
      setupConsole(context, logs);

      const callBudgetGuard = (): void => {
        callsMade += 1;
        if (callsMade > this.limits.maxCallsPerExecute) {
          throw new Error(
            `API call limit exceeded (max ${String(this.limits.maxCallsPerExecute)} calls per execute). ` +
              'Use more targeted queries or batch results.',
          );
        }
      };

      const getClient = (): GraphqlClient => {
        if (!this.tenant.local) throw new MissingCredentialsError('local');
        localClient ??= this.buildLocalClient(this.tenant, onWarn);
        return localClient;
      };

      bindLocalFunctions(context, {
        getClient,
        getSpec: () => this.localSpec,
        callBudgetGuard,
      });

      const prelude = buildUnraidPrelude(this.localSpec);
      const preludeResult = context.evalCode(prelude, 'prelude.js', { type: 'global' });
      if (preludeResult.error) {
        const errValue: unknown = context.dump(preludeResult.error);
        preludeResult.error.dispose();
        throw new Error(`Failed to bootstrap unraid namespace: ${formatError(errValue)}`);
      }
      preludeResult.value.dispose();

      const result = await context.evalCodeAsync(code, 'sandbox.js', { type: 'global' });
      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();
        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      }

      const valueHandle = result.value;
      try {
        if (context.typeof(valueHandle) !== 'object') {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const initial = context.getPromiseState(valueHandle);
        if (initial.type === 'fulfilled' && initial.notAPromise === true) {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const maxDrains = 1000;
        for (let i = 0; i < maxDrains; i += 1) {
          const state = context.getPromiseState(valueHandle);
          if (state.type === 'fulfilled') {
            const dumped: unknown = context.dump(state.value);
            state.value.dispose();
            return {
              ok: true,
              data: dumped,
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          if (state.type === 'rejected') {
            const dumped: unknown = context.dump(state.error);
            state.error.dispose();
            return {
              ok: false,
              error: formatError(dumped),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          const drain = runtime.executePendingJobs(64);
          if (drain.error) {
            const errorValue: unknown = context.dump(drain.error);
            drain.error.dispose();
            return {
              ok: false,
              error: formatError(errorValue),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          await new Promise<void>((r) => setImmediate(r));
        }
        return {
          ok: false,
          error: 'Sandbox promise did not settle within microtask budget',
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      } finally {
        valueHandle.dispose();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        warnings,
        callsMade,
        durationMs: Date.now() - startTime,
      };
    } finally {
      try {
        context.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
      try {
        runtime.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
    }
  }
}

// ─── Bind host functions ────────────────────────────────────────────

interface LocalBinding {
  getClient: () => GraphqlClient;
  getSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindLocalFunctions(context: QuickJSAsyncContext, binding: LocalBinding): void {
  // __unraidCallLocal(operationName, payloadJson)
  const callFn = context.newAsyncifiedFunction(
    '__unraidCallLocal',
    async (opNameHandle: QuickJSHandle, payloadJsonHandle: QuickJSHandle) => {
      const opName = context.getString(opNameHandle);
      const payloadJson = context.getString(payloadJsonHandle);
      try {
        binding.callBudgetGuard();
        const spec = binding.getSpec();
        if (!spec) throw new Error('unraid.local: spec not loaded');
        const payload = parseJson(payloadJson);
        const data = await dispatchOperation(binding.getClient(), spec, 'local', opName, payload);
        return jsonResponseToHandle(context, data);
      } catch (err) {
        throw new Error(formatLocalError(err));
      }
    },
  );
  context.setProp(context.global, '__unraidCallLocal', callFn);
  callFn.dispose();

  // __unraidCallLocalGraphql(payloadJson)
  const graphqlFn = context.newAsyncifiedFunction(
    '__unraidCallLocalGraphql',
    async (payloadJsonHandle: QuickJSHandle) => {
      const payloadJson = context.getString(payloadJsonHandle);
      try {
        binding.callBudgetGuard();
        const payload = parseJson(payloadJson) as unknown as GraphqlRequestParams;
        const data = await dispatchGraphql(binding.getClient(), payload);
        return jsonResponseToHandle(context, data);
      } catch (err) {
        throw new Error(formatLocalError(err));
      }
    },
  );
  context.setProp(context.global, '__unraidCallLocalGraphql', graphqlFn);
  graphqlFn.dispose();

  // __unraidRawLocal(payloadJson)
  const rawFn = context.newAsyncifiedFunction(
    '__unraidRawLocal',
    async (payloadJsonHandle: QuickJSHandle) => {
      const payloadJson = context.getString(payloadJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(payloadJson) as unknown as UnraidRequestParams;
        const response = await dispatchRawRequest(binding.getClient(), args);
        return jsonResponseToHandle(context, {
          status: response.status,
          body: response.body,
          headers: response.headers,
        });
      } catch (err) {
        throw new Error(formatLocalError(err));
      }
    },
  );
  context.setProp(context.global, '__unraidRawLocal', rawFn);
  rawFn.dispose();
}

function formatLocalError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  let tag = 'unraid.local.error';
  if (err instanceof UnraidHttpError) tag = 'unraid.local.http';
  else if (err instanceof UnraidGraphqlError) tag = 'unraid.local.graphql';
  else if (err instanceof MissingCredentialsError) tag = 'unraid.local.missing-credentials';
  else if (err instanceof UnknownOperationError) tag = 'unraid.local.unknown-operation';
  else if (err instanceof SelectionRequiredError) tag = 'unraid.local.graphql';
  return `[${tag}] ${detail}`;
}

function parseJson(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function jsonResponseToHandle(context: QuickJSAsyncContext, data: unknown): QuickJSHandle {
  const json = JSON.stringify(data ?? null);
  const stringHandle = context.newString(json);
  const parseExpr = context.evalCode('JSON.parse');
  if (parseExpr.error) {
    parseExpr.error.dispose();
    stringHandle.dispose();
    return context.null;
  }
  const parsed = context.callFunction(parseExpr.value, context.undefined, stringHandle);
  parseExpr.value.dispose();
  stringHandle.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return context.null;
  }
  return parsed.value;
}

// ─── Default client factory ─────────────────────────────────────────

function defaultBuildLocalClient(
  tenant: TenantContext,
  onWarn: (msg: string) => void,
): GraphqlClient {
  if (!tenant.local) throw new MissingCredentialsError('local');
  return createUnraidClient(tenant.local, { onWarn });
}

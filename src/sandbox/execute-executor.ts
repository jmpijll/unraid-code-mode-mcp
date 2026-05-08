/**
 * Execute Executor — runs LLM-written JS that performs real Unraid GraphQL calls.
 *
 * # Why a sync context with Promise-callback host bridge
 *
 * Earlier iterations used `newAsyncifiedFunction` (the asyncify async-context
 * pattern) to suspend the sandbox while the host issued real HTTP requests.
 * That codepath is broken across both the legacy `quickjs-emscripten` and
 * `quickjs-ng` asyncify variants: any combination of two or more sequential
 * `await` calls in one execute crashes the WASM runtime
 * (`memory access out of bounds`, `gc_decref` / `__JS_AtomToValue`
 * assertions). Tracked upstream as quickjs-emscripten#258, #261, #235.
 *
 * The fix is to NOT use asyncify at all. Instead:
 *
 *   1. Use a SYNC QuickJS context. Sandbox-side `async`/`await` and Promises
 *      work natively — they just queue microtasks.
 *   2. Each host bridge is a synchronous host function that takes a
 *      sandbox-side `(resolve, reject)` pair, captures them, and kicks off
 *      the async work in the host's event loop. When the work finishes the
 *      host invokes `resolve(jsonString)` or `reject(messageString)`,
 *      enqueueing the sandbox `.then` continuation as a microtask.
 *   3. The host's drain loop alternates `runtime.executePendingJobs()` (drain
 *      sandbox microtasks) and `setImmediate` (let the host event loop run
 *      one tick so the actual async work can advance).
 *
 * This is the canonical QuickJS async pattern. It supports any number of
 * sequential awaits, parallel `Promise.all`, mixed call shapes — verified
 * with `scripts/probe-cb.mjs`.
 *
 * Per-tenant credentials are bound at construction time so each MCP request
 * gets its own short-lived executor.
 *
 * Sandbox surface:
 *   unraid.local.graphql({ query, variables, operationName }) -> Promise<any>
 *   unraid.local.query.<fieldName>({ args, fields }) -> Promise<any>
 *   unraid.local.mutation.<fieldName>({ args, fields }) -> Promise<any>
 *   unraid.local.request({ method, path, body, headers }) -> Promise<{ status, body }>
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import { getQuickJSSyncModule } from './module.js';
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

/** Tracks every host-side async work item kicked off by the sandbox. */
interface PendingHostCall {
  /** Resolve/reject handles owned by us until the work settles. */
  resolve: QuickJSHandle;
  reject: QuickJSHandle;
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

    const wasmModule = await getQuickJSSyncModule();
    const context = wasmModule.newContext();
    const runtime = context.runtime;

    let localClient: GraphqlClient | undefined;
    const onWarn = (msg: string): void => {
      if (!warnings.includes(msg)) warnings.push(msg);
    };

    // Track in-flight host calls so we can clean up handles on shutdown and
    // know whether to keep draining the microtask queue.
    const pending = new Set<PendingHostCall>();

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

      bindLocalFunctions(context, pending, {
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

      const result = context.evalCode(code, 'sandbox.js', { type: 'global' });
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

        // Drain loop:
        //   1. Check whether the top-level Promise has settled.
        //   2. Run sandbox microtasks (.then continuations, async stepping).
        //   3. Yield to the host event loop so kicked-off async work can advance.
        //   4. Repeat until settled, no work is left, or the wall-clock
        //      timeout (limits.timeoutMs) trips.
        //
        // We DON'T cap by iteration count: setImmediate is fast (sub-ms) so
        // a count cap would falsely time-out long-running but legitimate
        // host calls (a typed mutation that boots a VM, for example).
        const deadline = startTime + this.limits.timeoutMs;
        // eslint-disable-next-line no-constant-condition, @typescript-eslint/no-unnecessary-condition
        while (true) {
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
          // If sandbox has no microtasks AND no host calls are in flight,
          // the promise will never settle — bail with a deadlock error.
          if (drain.value === 0 && pending.size === 0) {
            return {
              ok: false,
              error:
                'Sandbox promise never settled and no host work is pending — likely a deadlock or unhandled async (did you forget to `await`?).',
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          if (Date.now() > deadline) {
            return {
              ok: false,
              error: `Sandbox timed out after ${String(this.limits.timeoutMs)}ms with ${String(pending.size)} host call(s) still in flight.`,
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          await new Promise<void>((r) => setImmediate(r));
        }
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
      // Drop any handles we still own from never-settled host calls.
      for (const p of pending) {
        try {
          p.resolve.dispose();
        } catch {
          /* swallow */
        }
        try {
          p.reject.dispose();
        } catch {
          /* swallow */
        }
      }
      pending.clear();
      try {
        context.dispose();
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

/**
 * Wire up `__unraidCallLocal`, `__unraidCallLocalGraphql`, `__unraidRawLocal`
 * — the synchronous host bridges the prelude calls into. Each one takes a
 * `(resolve, reject)` pair from a sandbox-side `new Promise(...)` plus the
 * call's input strings, owns the resolve/reject handles, fires the async
 * work in the host event loop, and resolves/rejects the sandbox Promise on
 * completion.
 */
function bindLocalFunctions(
  context: QuickJSContext,
  pending: Set<PendingHostCall>,
  binding: LocalBinding,
): void {
  const settleResolve = (pendingCall: PendingHostCall, payload: string): void => {
    const arg = context.newString(payload);
    try {
      const r = context.callFunction(pendingCall.resolve, context.undefined, arg);
      if (r.error) r.error.dispose();
      else r.value.dispose();
    } finally {
      arg.dispose();
      pendingCall.resolve.dispose();
      pendingCall.reject.dispose();
      pending.delete(pendingCall);
    }
  };

  const settleReject = (pendingCall: PendingHostCall, message: string): void => {
    // Wrap the message in an Error host-side so sandbox sees a real Error.
    const errorObj = context.newError(message);
    try {
      const r = context.callFunction(pendingCall.reject, context.undefined, errorObj);
      if (r.error) r.error.dispose();
      else r.value.dispose();
    } finally {
      errorObj.dispose();
      pendingCall.resolve.dispose();
      pendingCall.reject.dispose();
      pending.delete(pendingCall);
    }
  };

  const startCall = (
    resolveHandle: QuickJSHandle,
    rejectHandle: QuickJSHandle,
    work: () => Promise<unknown>,
  ): void => {
    const pendingCall: PendingHostCall = {
      resolve: resolveHandle.dup(),
      reject: rejectHandle.dup(),
    };
    pending.add(pendingCall);

    let budgetError: Error | undefined;
    try {
      binding.callBudgetGuard();
    } catch (err) {
      budgetError = err as Error;
    }

    if (budgetError) {
      // Reject on next tick so the sandbox sees a normal async rejection.
      queueMicrotask(() => {
        if (!pending.has(pendingCall)) return;
        settleReject(pendingCall, formatLocalError(budgetError));
      });
      return;
    }

    void (async (): Promise<void> => {
      try {
        const data = await work();
        if (!pending.has(pendingCall)) return;
        settleResolve(pendingCall, JSON.stringify(data ?? null));
      } catch (err) {
        if (!pending.has(pendingCall)) return;
        settleReject(pendingCall, formatLocalError(err));
      }
    })();
  };

  // __unraidCallLocal(operationName, kind, payloadJson, resolve, reject)
  const callFn = context.newFunction(
    '__unraidCallLocal',
    (
      opNameHandle: QuickJSHandle,
      kindHandle: QuickJSHandle,
      payloadJsonHandle: QuickJSHandle,
      resolveHandle: QuickJSHandle,
      rejectHandle: QuickJSHandle,
    ) => {
      const opName = context.getString(opNameHandle);
      const kindRaw = context.getString(kindHandle);
      const kind: 'query' | 'mutation' | undefined =
        kindRaw === 'query' || kindRaw === 'mutation' ? kindRaw : undefined;
      const payloadJson = context.getString(payloadJsonHandle);
      startCall(resolveHandle, rejectHandle, async () => {
        const spec = binding.getSpec();
        if (!spec) throw new Error('unraid.local: spec not loaded');
        const payload = parseJson(payloadJson);
        return dispatchOperation(binding.getClient(), spec, 'local', opName, payload, kind);
      });
    },
  );
  context.setProp(context.global, '__unraidCallLocal', callFn);
  callFn.dispose();

  // __unraidCallLocalGraphql(payloadJson, resolve, reject)
  const graphqlFn = context.newFunction(
    '__unraidCallLocalGraphql',
    (
      payloadJsonHandle: QuickJSHandle,
      resolveHandle: QuickJSHandle,
      rejectHandle: QuickJSHandle,
    ) => {
      const payloadJson = context.getString(payloadJsonHandle);
      startCall(resolveHandle, rejectHandle, async () => {
        const payload = parseJson(payloadJson) as unknown as GraphqlRequestParams;
        return dispatchGraphql(binding.getClient(), payload);
      });
    },
  );
  context.setProp(context.global, '__unraidCallLocalGraphql', graphqlFn);
  graphqlFn.dispose();

  // __unraidRawLocal(payloadJson, resolve, reject)
  const rawFn = context.newFunction(
    '__unraidRawLocal',
    (
      payloadJsonHandle: QuickJSHandle,
      resolveHandle: QuickJSHandle,
      rejectHandle: QuickJSHandle,
    ) => {
      const payloadJson = context.getString(payloadJsonHandle);
      startCall(resolveHandle, rejectHandle, async () => {
        const args = parseJson(payloadJson) as unknown as UnraidRequestParams;
        const response = await dispatchRawRequest(binding.getClient(), args);
        return {
          status: response.status,
          body: response.body,
          headers: response.headers,
        };
      });
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

// ─── Default client factory ─────────────────────────────────────────

function defaultBuildLocalClient(
  tenant: TenantContext,
  onWarn: (msg: string) => void,
): GraphqlClient {
  if (!tenant.local) throw new MissingCredentialsError('local');
  return createUnraidClient(tenant.local, { onWarn });
}

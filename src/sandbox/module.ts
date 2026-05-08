/**
 * QuickJS module loader.
 *
 * We only use the **sync** quickjs-ng variant for both the `search` and
 * `execute` tools. The execute path implements async-from-sandbox using a
 * Promise-callback host bridge (see `execute-executor.ts`) instead of
 * `newAsyncifiedFunction`. Asyncify is unusable today because of well-known
 * upstream WASM heap-corruption bugs on multi-await scripts (filed as
 * quickjs-emscripten#258, #261, #235); the sync + Promise-callback pattern is
 * the canonical workaround and supports unlimited sequential and parallel
 * awaits cleanly.
 *
 * `quickjs-ng-wasmfile-release-sync` is the actively maintained sync build of
 * Bellard's `quickjs-ng` fork.
 */
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC_VARIANT from '@jitl/quickjs-ng-wasmfile-release-sync';

let syncModule: QuickJSWASMModule | null = null;

/** Get or initialize the shared sync QuickJS module (singleton). */
export async function getQuickJSSyncModule(): Promise<QuickJSWASMModule> {
  syncModule ??= await newQuickJSWASMModuleFromVariant(RELEASE_SYNC_VARIANT);
  return syncModule;
}

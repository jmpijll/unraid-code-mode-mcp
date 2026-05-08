#!/usr/bin/env node
/**
 * Sandbox smoke test — exercises the QuickJS sync-context + Promise-callback
 * host bridge that the `execute` tool is built on. This is a self-contained
 * regression check for the canonical async pattern: it runs sequential
 * awaits, parallel `Promise.all`, and error propagation against a fake host
 * function and prints PASS/FAIL with a non-zero exit on failure.
 *
 * Use this after upgrading `quickjs-emscripten-core` or any QuickJS variant
 * to verify the runtime still behaves correctly. The integration tests in
 * `src/__tests__/integration/scenarios.test.ts` cover the same ground but
 * this script is a faster local sanity-check that doesn't require a
 * running mock GraphQL server.
 *
 * Usage:
 *   node scripts/sandbox-smoke.mjs
 */

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-ng-wasmfile-release-sync';

const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
const ctx = QuickJS.newContext();

// __schedule(name, resolve, reject) — registers a fake async host fn that
// resolves on next tick with `{ name, ts }`, or rejects if name === 'BOOM'.
const scheduleFn = ctx.newFunction('__schedule', (nameH, resolveH, rejectH) => {
  const name = ctx.getString(nameH);
  const resolve = resolveH.dup();
  const reject = rejectH.dup();
  setImmediate(() => {
    try {
      if (name === 'BOOM') {
        const err = ctx.newError('host failure: BOOM');
        const r = ctx.callFunction(reject, ctx.undefined, err);
        err.dispose();
        if (r.error) r.error.dispose();
        else r.value.dispose();
        return;
      }
      const arg = ctx.newString(JSON.stringify({ name, ts: Date.now() }));
      const r = ctx.callFunction(resolve, ctx.undefined, arg);
      arg.dispose();
      if (r.error) r.error.dispose();
      else r.value.dispose();
    } finally {
      resolve.dispose();
      reject.dispose();
    }
  });
});
ctx.setProp(ctx.global, '__schedule', scheduleFn);
scheduleFn.dispose();

ctx
  .unwrapResult(
    ctx.evalCode(
      `globalThis.host = function(name) { return new Promise((resolve, reject) => __schedule(name, resolve, reject)); };`,
    ),
  )
  .dispose();

let failures = 0;

async function check(label, code, predicate) {
  const result = ctx.evalCode(code, 'test.js', { type: 'global' });
  if (result.error) {
    console.error(`FAIL  ${label}: eval error ${JSON.stringify(ctx.dump(result.error))}`);
    result.error.dispose();
    failures += 1;
    return;
  }
  const handle = result.value;
  let outcome;
  for (let i = 0; i < 5000; i += 1) {
    const s = ctx.getPromiseState(handle);
    if (s.type === 'fulfilled') {
      outcome = { ok: true, value: ctx.dump(s.value) };
      s.value.dispose?.();
      break;
    }
    if (s.type === 'rejected') {
      outcome = { ok: false, value: ctx.dump(s.error) };
      s.error.dispose?.();
      break;
    }
    ctx.runtime.executePendingJobs(64);
    await new Promise((r) => setImmediate(r));
  }
  handle.dispose();
  if (!outcome) {
    console.error(`FAIL  ${label}: never settled`);
    failures += 1;
    return;
  }
  const ok = predicate(outcome);
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(
      `FAIL  ${label}: outcome=${JSON.stringify(outcome).slice(0, 200)}`,
    );
    failures += 1;
  }
}

await check(
  'single await',
  `(async () => JSON.parse(await host('a')))();`,
  (r) => r.ok && r.value?.name === 'a',
);

await check(
  '25 sequential awaits',
  `(async () => {
    const out = [];
    for (let i = 0; i < 25; i++) out.push(JSON.parse(await host('x' + i)));
    return out;
  })();`,
  (r) => r.ok && Array.isArray(r.value) && r.value.length === 25,
);

await check(
  'Promise.all parallel x10',
  `(async () => {
    const xs = await Promise.all(Array.from({length:10},(_,i)=>host('y'+i)));
    return xs.map(JSON.parse);
  })();`,
  (r) => r.ok && Array.isArray(r.value) && r.value.length === 10,
);

await check(
  'mixed sequential then parallel',
  `(async () => {
    const a = JSON.parse(await host('a'));
    const [b, c] = await Promise.all([host('b'), host('c')]);
    return { a, b: JSON.parse(b), c: JSON.parse(c) };
  })();`,
  (r) => r.ok && r.value?.a?.name === 'a' && r.value?.b?.name === 'b' && r.value?.c?.name === 'c',
);

await check(
  'error propagation through await',
  `(async () => {
    try { await host('BOOM'); return 'no throw'; }
    catch (e) { return 'caught:' + (e && e.message); }
  })();`,
  (r) => r.ok && typeof r.value === 'string' && r.value.startsWith('caught:host failure'),
);

ctx.dispose();
if (failures > 0) {
  console.error(`\n${failures} sandbox smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll sandbox smoke checks passed.');

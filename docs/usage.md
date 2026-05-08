# Usage guide

## The two tools

### `search`

Find the operations you want before invoking them. Read-only — no network.

Globals available to your code:

| Global | Type | Description |
| --- | --- | --- |
| `index` | `{ namespace, title, version, sourceUrl, operations[], types } \| null` | Compact operation index |
| `unraid.local` | same shape | Mirror of `index` so the search and execute tools share namespacing |
| `searchOperations(query, limit?)` | function | Ranked text search across name, description, args, and return type |
| `getOperation(name)` | function | Full operation info including args and return-type field hints |
| `findOperationsByName(substring)` | function | Substring match on operation name |
| `getType(typeName)` | function | Full named-type info (fields/values/possibleTypes depending on kind) |
| `console.log()` | function | Captured into tool output |

Each operation in `index.operations` is:

```ts
{
  kind: 'query' | 'mutation';
  namespace: 'local';
  name: string;
  jsName: string;
  description: string;
  args: Array<{ name, type: TypeRef, defaultValue? }>;
  returnType: TypeRef;        // wraps NON_NULL / LIST around a named type
  returnTypeFields: string[]; // top-level fields of the named return type
  tags: string[];
  deprecated: boolean;
}
```

Examples:

```js
// All queries that mention "docker"
searchOperations('docker', 20).map(function (op) { return op.name; });
```

```js
// Full detail (incl. arg types) for the `info` query
getOperation('info');
```

```js
// Inspect the UnraidArray type to find the right selection set
getType('UnraidArray');
```

### `execute`

Run Unraid GraphQL operations inside the sandbox.

| Surface | Auth | Reaches |
| --- | --- | --- |
| `unraid.local.graphql({ query, variables, operationName })` | server API key (`X-Unraid-Api-Key`) | raw POST to `${baseUrl}/graphql` |
| `unraid.local.query.<fieldName>({ args, fields })` | server API key | typed query — host builds the GraphQL document for you |
| `unraid.local.mutation.<fieldName>({ args, fields })` | server API key | typed mutation |
| `unraid.local.request({ method, path, body, headers })` | server API key | raw HTTP escape hatch for non-GraphQL endpoints |

> **Idiomatic async.** Calls return real Promises and you can use `await` and `Promise.all` freely. Sequential `await`, parallel batching, and mixed query/mutation/raw chains all work in a single `execute`. The script's last expression (or top-level `return` from an IIAFE) is the tool result.

Surface:

```ts
unraid.local.graphql(args)            // raw POST — args = { query, variables?, operationName? }
unraid.local.query.<fieldName>(args)  // args = { args?: <vars>, fields?: string | string[] }
unraid.local.mutation.<fieldName>(args)
unraid.local.request(args)            // args = { method, path, body?, headers? }
unraid.local.spec                     // { title, version, sourceUrl, queryCount, mutationCount }
```

`fields` rules:

- For scalar/enum return types, `fields` is optional and ignored.
- For object/interface/union return types, `fields` is **required** and may be:
  - a GraphQL selection-set string (without the wrapping `{ ... }`), or
  - a shorthand array of leaf field names that get joined with spaces.
- The host throws `[unraid.local.graphql] Operation "<name>" returns "<Type>" — pass a `fields` selection …` if it can't infer one.

The dispatched call returns the **field's value** rather than the wrapping `{ data: { <fieldName>: ... } }` envelope, which is usually what you want.

## Examples

```js
// Read system info
const info = await unraid.local.query.info({
  fields: ['os { distro release }', 'versions { unraid api }', 'cpu { manufacturer cores }'].join(' '),
});
return info;
```

```js
// List Docker containers, filter and reshape.
const containers = await unraid.local.query.dockerContainers({
  fields: ['id', 'names', 'state', 'status', 'image'],
});
return containers.map(function (c) { return { name: c.names[0], state: c.state }; });
```

```js
// Raw GraphQL document — useful when you need fragments or aliases.
const data = await unraid.local.graphql({
  query: 'query { array { state capacity { kilobytes { free total } } } }',
});
return data;
```

```js
// Mutation with args.
return await unraid.local.mutation.archiveAll({});
```

## Choosing between `search` and `execute`

- Start in `search` to discover the right field name and selection set.
- Move to `execute` once you know what you want.
- Both tools accept the same `code` input so the LLM can copy a query body straight from one to the other.

## Multi-step scripts: sequential awaits and `Promise.all` both work

The sandbox uses a sync QuickJS context with a Promise-callback host bridge (see `src/sandbox/execute-executor.ts` for the full rationale). That means **all** standard JS async control flow is supported inside `execute`:

```js
// Sequential — fine, the next await waits on the previous one as expected.
const info = await unraid.local.query.info({ fields: 'os { distro }' });
const arr = await unraid.local.query.array({ fields: 'state' });
const shares = await unraid.local.query.shares({ fields: 'name free used size' });
return { info, arr, shares };
```

```js
// Parallel — faster when calls are independent.
const [info, arr, online] = await Promise.all([
  unraid.local.graphql({ query: 'query { info { os { distro } } }' }),
  unraid.local.graphql({ query: 'query { array { state } }' }),
  unraid.local.graphql({ query: 'query { online }' }),
]);
return { info, arr, online };
```

Errors inside any `await` propagate normally — wrap with `try/catch` if you want to keep going on failure.

There is a per-execute call budget (default 50, see [Limits](#limits)) and a wall-clock timeout — neither pattern bypasses those.

> Earlier versions of this server documented a "use `Promise.all`, not sequential `await`" caveat. That was a workaround for an upstream `quickjs-emscripten` asyncify bug ([#258](https://github.com/justjake/quickjs-emscripten/issues/258), [#261](https://github.com/justjake/quickjs-emscripten/issues/261)). The current sandbox sidesteps the bug entirely by not using asyncify; both call patterns work.

## When introspection is disabled on the live server

Unraid's GraphQL endpoint disables introspection unless you toggle `Settings → Management Access → Developer Options → GraphQL Sandbox` (or run `unraid-api developer --sandbox true`). When introspection is off, the loader falls back to the bundled SDL (`src/spec/local-fallback.graphql`, fetched from a **pinned `unraid/api` release tag**).

The current pin is recorded in `scripts/update-spec.ts` (`PINNED_UNRAID_TAG`) and stamped into the bundled SDL header so `unraid.local.spec.version` looks like `fallback@vX.Y.Z`. To bump it: edit the constant, run `npm run update-spec`, run `npm test`, and re-verify against a real box.

If your Unraid version is newer or older than the pin, a few specific fields may not exist on your server. The HTTP layer surfaces the live server's `GRAPHQL_VALIDATION_FAILED` messages so you can correct the selection — pick the supported subset (`info { os { … } cpu { … } }`, `array { state }`, `shares { name free used size }`, `online`, etc.) and the typed dispatch path will work without any local changes.

## Limits

- `MAX_CODE_SIZE` per call: 100 000 chars
- `MAX_RESULT_SIZE` per call: 100 000 chars (truncated with a tip)
- Sandbox timeout: 30 s for `execute`, 10 s for `search`
- Sandbox memory: 64 MiB for `execute`, 32 MiB for `search`
- API call ceiling per `execute`: 50 (configurable via `UNRAID_MAX_CALLS_PER_EXECUTE`)

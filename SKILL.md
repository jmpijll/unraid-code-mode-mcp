---
name: unraid-code-mode-mcp
description: Code-mode MCP server skill for the Unraid 7.2+ GraphQL API. Use when an LLM agent needs to query or mutate Unraid via the `search` and `execute` MCP tools.
---

# unraid-code-mode-mcp

This skill describes how to use the **unraid-code-mode-mcp** server effectively. The server exposes exactly **two tools** to the agent:

1. `search` — sandboxed read-only JS that introspects the Unraid GraphQL schema. No network. Use first.
2. `execute` — sandboxed JS that calls the live Unraid GraphQL API. Has a budget of 50 API calls per invocation and a 30-second wall clock.

## When to use this skill

Any time the user wants to:
- Inspect Unraid system state (array status, Docker containers, VMs, shares, disks, parity, plugins, …)
- Mutate Unraid state (start/stop arrays, manage Docker, manipulate users, …)
- Issue raw GraphQL against the Unraid API

If you're not sure whether the API supports something, run `search` first.

## Workflow

### Step 1 — discover with `search`

```js
// search tool
const matches = searchOperations('docker', 12);
return matches.map(function (op) {
  return { name: op.name, kind: op.kind, returns: op.returnType.name, summary: op.description };
});
```

Useful globals (all sync, all read-only):

- `searchOperations(query, limit?)` — ranked text search across name, description, args, return type.
- `getOperation(name)` — full `IndexedOperation` for a field.
- `findOperationsByName(substring)` — case-insensitive substring match on field name.
- `getType(typeName)` — full type record, including its own fields.

### Step 2 — execute the call

```js
// execute tool
const docker = await unraid.local.query.docker({
  fields: 'containers { id names state status image }',
});
return docker;
```

The execute tool exposes the `unraid` global with these surfaces:

- `unraid.local.graphql({ query, variables, operationName })` — raw GraphQL, returns the unwrapped `data`.
- `unraid.local.query.<fieldName>({ args, fields })` — typed query helper.
- `unraid.local.mutation.<fieldName>({ args, fields })` — typed mutation helper.
- `unraid.local.request({ method, path, body, headers })` — raw HTTP escape hatch.

### `fields` rules

- **Scalar return types** (Boolean, Int, String, …): `fields` is optional and ignored.
- **Object/interface return types**: `fields` is **required**. Pass either:
  - a GraphQL selection-set string: `'os { distro release } cpu { brand cores }'`
  - or a flat array of leaf field names: `['id', 'name', 'state']` (joined inside `{ ... }`).

If `fields` is missing on an object return, the call throws an error tagged `[unraid.local.graphql]` so the agent can fix the prompt and retry.

## Calls appear synchronous

Inside the sandbox, every `unraid.local.*` call is awaited transparently. You can use `await` and it works, but you don't have to — `const x = unraid.local.query.info({ fields: 'os { distro }' });` returns the value directly.

## Limits

- 30 s wall clock per `execute`.
- 50 API calls per `execute` (configurable server-side via `UNRAID_MAX_CALLS_PER_EXECUTE`).
- 64 MiB heap.
- 2 MiB result size; 256 KiB log buffer.

If your script has a 51st call, it throws "API call budget exceeded". Batch with `Promise.all` to stay within the budget.

## Errors

Errors from the host are tagged so you can distinguish them in the agent flow:

- `[unraid.local.graphql] errors: …` — GraphQL errors returned by the server.
- `[unraid.local.graphql] field "X" returns object … and requires a "fields" selection` — missing selection set.
- `[unraid.local.graphql] no live spec; cannot synthesise document` — server booted from bundled SDL only.
- `[unraid.local.request] HTTP 4xx/5xx: …` — raw HTTP failures.
- `API call budget exceeded` — too many calls in one execute.

## Multi-tenant note

If your MCP client is configured with `X-Unraid-*` headers, those are scoped to the request and override env defaults. The agent code doesn't care — it always sees one `unraid.local` namespace.

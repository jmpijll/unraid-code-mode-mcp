# Usage guide

> **Beta.** This server is in public beta. The two-tool surface, the
> sandbox bridge, and the typed dispatcher are stable enough to use
> day-to-day, but only one Unraid 7.2 box has been live-verified so
> far and only the `search` / `execute` reads + the VM start/stop
> mutation cycle have been exercised end-to-end. See the
> [README's project status](../README.md#project-status) for the full
> verified-vs-not breakdown.

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


---

# Setup and verification reference

The following details were moved from the README during repository harmonization.
Historical verification records describe the maintainer's earlier runs; they are not
claims that live services or clients were retested in this change.

## Creating an Unraid API key

The API key is what authenticates the MCP server's calls to your Unraid box. Two ways to mint one:

**Option A — Web UI.** Go to **Settings → Management Access → API Keys** and create a key with the `ADMIN` role (or scope it down to whatever you actually want the agent to do). Copy the value into `UNRAID_API_KEY`.

**Option B — CLI on the Unraid box.** SSH in and run:

```bash
unraid-api apikey --create --name "mcp" --roles ADMIN --json
```

The JSON output contains a `key` field; that's `UNRAID_API_KEY`.

`UNRAID_BASE_URL` should be the URL you'd visit in a browser to reach the web UI (no path, no trailing slash) — e.g. `https://tower.local` or `https://192.168.1.10`.

## TLS on Unraid

Unraid 7.2+ usually serves over HTTPS using a self-signed `*.unraid.net` certificate fronted by the LAN proxy. The MCP server has three options:

1. **Recommended:** install the Unraid root CA on the host, or fetch it and pass `UNRAID_CA_CERT_PATH=/path/to/ca.pem`.
2. **Lab use:** `UNRAID_INSECURE=true` skips verification. Logged on every request.
3. **Multi-tenant:** clients can supply `X-Unraid-Ca-Cert` and/or `X-Unraid-Insecure: true` per request.

See [docs/security.md](../docs/security.md) for the full picture.

## Sample interactions

**Discover the schema:**

```js
// search tool
searchOperations('docker', 10).map(function (op) { return op.name + ' (' + op.kind + ')'; });
```

```js
// search tool — drill into a single op
getOperation('info');
```

**Run a query (verified live on Unraid 7.2):**

```js
// execute tool
const info = await unraid.local.query.info({
  fields: ['os { distro release kernel uptime }', 'cpu { manufacturer brand cores threads }'].join(' '),
});
return info;
```

**Read multiple things — sequential `await` and `Promise.all` both work:**

```js
// execute tool — sequential awaits (fine; full canonical async)
const info = await unraid.local.query.info({ fields: 'os { distro }' });
const arr = await unraid.local.query.array({ fields: 'state' });
const shares = await unraid.local.query.shares({ fields: 'name free used size' });
return { info, arr, shares };
```

```js
// execute tool — parallel batch (faster when calls are independent)
const [info, arr, shares, online] = await Promise.all([
  unraid.local.graphql({ query: 'query { info { os { distro release kernel } cpu { brand cores threads } } }' }),
  unraid.local.graphql({ query: 'query { array { state } }' }),
  unraid.local.graphql({ query: 'query { shares { name free used size } }' }),
  unraid.local.graphql({ query: 'query { online }' }),
]);
return { info, arr, shares, online };
```

**Run a mutation:**

```js
// execute tool
return await unraid.local.mutation.archiveAll({});
```

**Fall back to raw GraphQL:**

```js
// execute tool
const data = await unraid.local.graphql({
  query: 'query { array { state capacity { kilobytes { free total } } } }',
});
return data;
```

## Multi-user / multi-tenant

Run with `MCP_TRANSPORT=http` and **without** env credentials. The MCP HTTP transport listens on `POST /mcp` + `GET /health`, and every request must carry:

- `X-Unraid-Api-Key`
- `X-Unraid-Base-Url`
- `X-Unraid-Insecure` (optional, `true` to skip TLS verification)
- `X-Unraid-Ca-Cert` (optional, PEM-encoded CA bundle)

Origin allowlist defaults to localhost; tune via `MCP_HTTP_ALLOWED_ORIGINS`. See [docs/multi-tenant.md](../docs/multi-tenant.md).

## Verification status

What we have **directly verified** so far:

| Layer | How | Result |
|---|---|---|
| Unit tests | Vitest, 56 specs across spec loader, dispatcher, sandbox, HTTP client, multi-tenant context, and server transports | ✅ all green |
| Integration tests | In-process `node:http` GraphQL mock + `InMemoryTransport` against `createMcpServer`; covers sequential awaits, `Promise.all`, mixed query/mutation/raw GraphQL, error propagation, and the per-execute call budget | ✅ green |
| QuickJS host-bridge stress | `npm run test:sandbox` — 25 sequential awaits, 10-way `Promise.all`, mixed patterns, rejection propagation through `await` | ✅ green; this is the regression bar after the asyncify → sync + Promise-callback rewrite |
| SDL fallback (introspection disabled) | Server boots without an Unraid box, parses bundled `src/spec/local-fallback.graphql` (pinned to `unraid/api@v4.33.0`), `search` is immediately usable; runtime fallback path also exercised by unit tests against a mock that returns `INTROSPECTION_DISABLED` | ✅ green; the `INTROSPECTION_DISABLED` error returns a human-readable diagnostic with a remediation hint (`unraid-api developer --sandbox true`) instead of `HTTP 400` |
| Live read sweep on a real Unraid 7.2 box | `scripts/mcp-call.mjs` driving stdio transport against the maintainer's homelab: `info`, `array`, `shares`, `vms`, `docker`, `online` | ✅ all queries returned real data; sequential awaits and `Promise.all` both worked end-to-end with real GraphQL latency |
| Live mutation round-trip on the same box | VM `SHUTOFF → RUNNING → SHUTOFF` cycle via `vmStart` / `vmStop` mutations, with state polled via `vms.domain.state` between transitions | ✅ full cycle completed; error propagation verified by attempting `vmStart` on an already-running VM (returns `Failed to set VM state: Invalid state transition from RUNNING to RUNNING` cleanly through `await`) |
| Linter + formatter + typecheck | `npm run lint` / `npm run format:check` / `npm run typecheck` | ✅ clean |

What is **not yet verified** (and where help is welcome):

- **Any agent / IDE client.** All live verification so far has been through `scripts/mcp-call.mjs` driving the stdio transport directly. Cursor (chat panel), Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI, Continue, Cline, opencode, Aider, Zed, the MCP Inspector (CLI and UI) — all wired but **NOT verified by us**. End-to-end LLM-mediated invocation is the most useful thing testers can report on.
- **Streamable HTTP transport in multi-tenant mode.** The transport is wired and unit-tested; a real multi-tenant deployment behind a reverse proxy with header-based credentials is not.
- **Cloudflare Workers entry.** `cf-worker/` is scaffolded against `@cloudflare/codemode` but the Web `Request`/`Response` ↔ MCP SDK Node-stream adapter is not implemented, and the Worker is not deployed anywhere. Tracked in [`cf-worker/README.md`](../cf-worker/README.md).
- **Mutations beyond VM start/stop.** Docker container `start` / `stop`, parity check `start` / `cancel`, share / disk operations, user / API-key management, and the full mutation surface are wired through the typed dispatcher but **not live-verified**. Probing them blindly against live hardware is unsafe; we want testers with redundant homelabs.
- **Unraid Connect cloud surface.** `unraid.connect.*` is reserved in `TenantContext` and not yet implemented. The current server only talks to a controller you can reach over the LAN.
- **Real Unraid boxes other than the maintainer's homelab.** A single Unraid 7.2 box is not enough to generalise resilience claims — different array configs, plugin sets, network topologies, and Unraid versions will all surface different edge cases.
- **Long-running soak / stability under sustained load.**

## Roadmap

**Done in `v0.1.0-beta.2` and `v0.1.0-beta.3`:**

- ✅ **Expose the sandbox wall-clock deadline as `UNRAID_EXECUTE_TIMEOUT_MS`** (1 s – 10 min, default 30 s). Useful for slow-booting VMs and for very large `Promise.all` batches against a controller under load. _(beta.2)_
- ✅ **CSRF-aware error decoration** — when an Unraid box returns `extensions.code: UNAUTHENTICATED` + `Invalid CSRF token`, the MCP server adds a remediation hint pointing at API key re-mint, the curl sanity check, and the box-side log path. See [`docs/security.md`](../docs/security.md#unraid-72-csrf-behaviour). _(beta.2)_
- ✅ **MCP `serverInfo.version` reads from `package.json` at runtime** — no more hand-stamped version drift between releases. _(beta.2)_
- ✅ **End-to-end LLM-mediated invocation verification** through `cursor-agent` (Claude Sonnet 4.6) and `opencode` (DeepSeek v4 Flash). See the verification matrix above. _(beta.2)_
- ✅ **Auto-bump bundled SDL pin** — `.github/workflows/update-spec.yml` runs weekly, detects new [`unraid/api`](https://github.com/unraid/api/releases) releases, regenerates `src/spec/local-fallback.graphql`, and opens a PR with a release-notes link for human review. _(beta.3)_
- ✅ **`npm run smoke:inspector`** — local mirror of the CI MCP Inspector smoke. Boots the built `dist/index.js` server, requests `tools/list`, asserts both tools are exposed. CI now uses the same script. _(beta.3)_

**Still open (rough order, highest-leverage first):**

- **More LLM clients verified** — Claude Code CLI, Claude Desktop, MCP Inspector UI (CLI smoke is in CI), VS Code + Copilot. Roadmap item, gating for `1.0.0`.
- **Streamable HTTP multi-tenant deployment** verified against a real reverse proxy with rotating per-tenant credentials.
- **Mutation verification matrix** beyond VM start/stop — Docker container lifecycle, parity checks, share/disk ops — once we have testers with redundant hardware.
- **`unraid.connect.*`** namespace for the Unraid Connect cloud API. Reserved in `TenantContext` today, not yet implemented.
- **Cloudflare Workers transport adapter** (the bridge from Web `Request`/`Response` to the MCP SDK's Node `IncomingMessage`/`ServerResponse`). Tracked in [`cf-worker/README.md`](../cf-worker/README.md).
- **NPM publish** — reserved for `1.0.0`. The package is `"private": true` until then.


## Historical client verification

The original README recorded the following client-specific evidence.

## Project status

**This is a public beta. Install from source. Not on npm yet.**

The server boots, both tools work, and the test suite is green
(56/56 unit + integration tests across spec loader, dispatcher,
sandbox, HTTP client, multi-tenant context, and server transports).
A standalone `npm run test:sandbox` script exercises the QuickJS
sync + Promise-callback host bridge with 25 sequential awaits, a
10-way `Promise.all`, mixed sequential/parallel patterns, and error
propagation — these are the patterns LLMs actually emit, and they
are the regression bar for the bridge.

**Verified live against a single real Unraid 7.2 box** (the
maintainer's homelab) via `scripts/mcp-call.mjs` driving the stdio
transport directly: `info`, `array`, `shares`, `vms`, `docker`, and
`online` reads succeed; the VM `SHUTOFF → RUNNING → SHUTOFF` cycle
via `vmStart` / `vmStop` mutations succeeds; sequential awaits and
`Promise.all` both work end-to-end with real GraphQL latency; and
the bundled SDL fallback path (introspection disabled) returns a
human-readable diagnostic with a remediation hint instead of an
opaque `HTTP 400`. The bundled SDL is pinned to a tagged
[`unraid/api`](https://github.com/unraid/api) release
(currently `v4.33.0`, no `main`-drift) and the introspection-disabled
fallback is exercised by unit tests.

**End-to-end LLM-mediated invocation is verified through two clients
against the same Unraid 7.2 box:**

| Client | Model | Status | Transcript |
|---|---|---|---|
| `cursor-agent` v2026.05.05 | Claude Sonnet 4.6 (`claude-4.6-sonnet-medium`) | **VERIFIED** — 3 prompts including a full live `info`/`array`/`shares`/`vms`/`docker`/`online` overview rendered to a Markdown table; error-path prompt handled correctly without invented recovery | [`out/verification/cursor-agent-sonnet-mcp-call.txt`](../out/verification/cursor-agent-sonnet-mcp-call.txt) |
| `opencode` v1.14.30 | DeepSeek v4 Flash via `opencode-go/deepseek-v4-flash` | **VERIFIED on schema-only path; live execute hit a mid-test upstream CSRF flip** — schema smoke (102 ops) green; the live overview produced valid `Promise.all` typed-query code on the first try and the model handled the upstream `Invalid CSRF token / 401` gracefully (explained, suggested re-auth, did not flail) | [`out/verification/opencode-deepseek-mcp-call.txt`](../out/verification/opencode-deepseek-mcp-call.txt) |

See [`examples/unraid-expert-agent/`](../examples/unraid-expert-agent/) for
the persona ([`AGENTS.md`](../examples/unraid-expert-agent/AGENTS.md)),
a vetted set of [sample prompts](../examples/unraid-expert-agent/SAMPLE_PROMPTS.md),
and [cross-platform install snippets](../examples/unraid-expert-agent/install.md).

**NOT verified by us** (and where help is welcome): every
agent / IDE client beyond cursor-agent CLI and opencode — Cursor IDE
chat panel, Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI,
Continue, Cline, Aider, Zed, MCP Inspector (CLI + UI); the Streamable
HTTP transport in multi-tenant mode; the Cloudflare Workers entry
(scaffolded but not deployed); any non-VM mutation
(Docker container start/stop, share/disk operations, parity ops);
any Unraid box other than the maintainer's. We need testers — please
file [verification reports](../.github/ISSUE_TEMPLATE/verification_report.yml)
and [bug reports](../.github/ISSUE_TEMPLATE/bug_report.yml) with whatever
you find. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the rules.


## Verifying your install

```bash
npm run check
npm run test:sandbox
npm run smoke:inspector
```

These checks exercise the mocked suite, build, sandbox host bridge and MCP tool registration.
They do not establish compatibility with every client or validate live upstream operations.

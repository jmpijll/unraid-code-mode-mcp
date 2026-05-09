# unraid-code-mode-mcp

[![CI](https://github.com/jmpijll/unraid-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unraid-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)](#project-status)
[![Version: v0.1.0-beta.2](https://img.shields.io/badge/version-v0.1.0--beta.2-blue.svg)](CHANGELOG.md)

A code-mode MCP server for the **[Unraid](https://unraid.net) 7.2+ GraphQL API**. Exposes two MCP tools — `search` and `execute` — that let an LLM agent introspect and call any Unraid GraphQL field by writing JavaScript that runs inside a sandboxed QuickJS WASM context.

Built as the GraphQL-flavoured sibling of [unifi-code-mode-mcp](https://github.com/jmpijll/unifi-code-mode-mcp) and [fortimanager-code-mode-mcp](https://github.com/jmpijll/fortimanager-code-mode-mcp). Same architecture, same sandbox model, adapted to GraphQL introspection instead of OpenAPI.

> ## Project status
>
> **This is a public beta. Install from source. Not on npm yet.**
>
> The server boots, both tools work, and the test suite is green
> (56/56 unit + integration tests across spec loader, dispatcher,
> sandbox, HTTP client, multi-tenant context, and server transports).
> A standalone `npm run test:sandbox` script exercises the QuickJS
> sync + Promise-callback host bridge with 25 sequential awaits, a
> 10-way `Promise.all`, mixed sequential/parallel patterns, and error
> propagation — these are the patterns LLMs actually emit, and they
> are the regression bar for the bridge.
>
> **Verified live against a single real Unraid 7.2 box** (the
> maintainer's homelab) via `scripts/mcp-call.mjs` driving the stdio
> transport directly: `info`, `array`, `shares`, `vms`, `docker`, and
> `online` reads succeed; the VM `SHUTOFF → RUNNING → SHUTOFF` cycle
> via `vmStart` / `vmStop` mutations succeeds; sequential awaits and
> `Promise.all` both work end-to-end with real GraphQL latency; and
> the bundled SDL fallback path (introspection disabled) returns a
> human-readable diagnostic with a remediation hint instead of an
> opaque `HTTP 400`. The bundled SDL is pinned to a tagged
> [`unraid/api`](https://github.com/unraid/api) release
> (currently `v4.33.0`, no `main`-drift) and the introspection-disabled
> fallback is exercised by unit tests.
>
> **End-to-end LLM-mediated invocation is verified through two clients
> against the same Unraid 7.2 box:**
>
> | Client | Model | Status | Transcript |
> |---|---|---|---|
> | `cursor-agent` v2026.05.05 | Claude Sonnet 4.6 (`claude-4.6-sonnet-medium`) | **VERIFIED** — 3 prompts including a full live `info`/`array`/`shares`/`vms`/`docker`/`online` overview rendered to a Markdown table; error-path prompt handled correctly without invented recovery | [`out/verification/cursor-agent-sonnet-mcp-call.txt`](out/verification/cursor-agent-sonnet-mcp-call.txt) |
> | `opencode` v1.14.30 | DeepSeek v4 Flash via `opencode-go/deepseek-v4-flash` | **VERIFIED on schema-only path; live execute hit a mid-test upstream CSRF flip** — schema smoke (102 ops) green; the live overview produced valid `Promise.all` typed-query code on the first try and the model handled the upstream `Invalid CSRF token / 401` gracefully (explained, suggested re-auth, did not flail) | [`out/verification/opencode-deepseek-mcp-call.txt`](out/verification/opencode-deepseek-mcp-call.txt) |
>
> See [`examples/unraid-expert-agent/`](examples/unraid-expert-agent/) for
> the persona ([`AGENTS.md`](examples/unraid-expert-agent/AGENTS.md)),
> a vetted set of [sample prompts](examples/unraid-expert-agent/SAMPLE_PROMPTS.md),
> and [cross-platform install snippets](examples/unraid-expert-agent/install.md).
>
> **NOT verified by us** (and where help is welcome): every
> agent / IDE client beyond cursor-agent CLI and opencode — Cursor IDE
> chat panel, Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI,
> Continue, Cline, Aider, Zed, MCP Inspector (CLI + UI); the Streamable
> HTTP transport in multi-tenant mode; the Cloudflare Workers entry
> (scaffolded but not deployed); any non-VM mutation
> (Docker container start/stop, share/disk operations, parity ops);
> any Unraid box other than the maintainer's. We need testers — please
> file [verification reports](.github/ISSUE_TEMPLATE/verification_report.yml)
> and [bug reports](.github/ISSUE_TEMPLATE/bug_report.yml) with whatever
> you find. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules.

## Why "code mode"?

The default MCP pattern is _one tool per API operation_. A typical Unraid 7.2 schema has ~57 queries and ~45 mutations across 240+ types — registering all of those as discrete MCP tools blows past every commercial agent's tool-list cap.

Code mode flips that: instead of a hundred tools, you get **two**. The LLM uses `search` to figure out what to call (no network), then writes a tiny JS snippet for `execute` that talks to the live API. See Cloudflare's [code mode post](https://blog.cloudflare.com/code-mode/) for the full pattern, or the [architecture doc](docs/architecture.md) for the per-module breakdown.

## Highlights

- **Two tools.** `search` is read-only; `execute` runs sandboxed JS that calls real Unraid GraphQL.
- **Typed convenience calls.** `unraid.local.query.<fieldName>({ args, fields })` and `unraid.local.mutation.<fieldName>({ args, fields })` synthesise the GraphQL document for you using introspected arg types.
- **Raw escape hatch.** `unraid.local.graphql({ query, variables })` posts any document; `unraid.local.request({ method, path, body })` covers the rare non-GraphQL endpoints.
- **Single- and multi-user modes.** Single-user via env vars (stdio), multi-user via `X-Unraid-Api-Key` HTTP headers.
- **Per-tenant TLS.** Custom CA bundles or `insecure` mode survive into a per-request undici dispatcher.
- **Bundled SDL fallback.** Server can boot without an Unraid server — it parses the latest committed `src/spec/local-fallback.graphql` so `search` is immediately useful.
- **Cloudflare Workers entry.** A scaffold using `@cloudflare/codemode` ships in `cf-worker/`. See [cf-worker/README.md](cf-worker/README.md).

## Quick start

```bash
git clone https://github.com/jmpijll/unraid-code-mode-mcp
cd unraid-code-mode-mcp
npm install --legacy-peer-deps
cp .env.example .env
# edit .env — set UNRAID_BASE_URL + UNRAID_API_KEY
npm run dev
```

Wire it into your MCP client. For Cursor, add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unraid": {
      "command": "node",
      "args": ["/absolute/path/to/unraid-code-mode-mcp/dist/index.js"]
    }
  }
}
```

(Run `npm run build` first if you point at `dist/`. Or use `npx tsx` against `src/index.ts` for live development.)

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

See [docs/security.md](docs/security.md) for the full picture.

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

## Documentation

- [Usage guide](docs/usage.md) — the search/execute API in detail.
- [Architecture](docs/architecture.md) — per-module breakdown, request lifecycle.
- [Multi-tenant deployment](docs/multi-tenant.md) — HTTP transport + headers.
- [Deployment](docs/deployment.md) — Node / Docker / Cloudflare.
- [Security](docs/security.md) — sandbox properties, TLS, threat model.
- [Cursor coupling guide](docs/cursor-skill.md) — `.cursor/mcp.json` shapes, `cursor-agent` quirks, smoke commands.
- [opencode coupling guide](docs/opencode-skill.md) — `opencode.json` shape, permissions, headless verification.
- [Verification transcripts](out/verification/README.md) — sanitized records of every live end-to-end run we have.

## Multi-user / multi-tenant

Run with `MCP_TRANSPORT=http` and **without** env credentials. The MCP HTTP transport listens on `POST /mcp` + `GET /health`, and every request must carry:

- `X-Unraid-Api-Key`
- `X-Unraid-Base-Url`
- `X-Unraid-Insecure` (optional, `true` to skip TLS verification)
- `X-Unraid-Ca-Cert` (optional, PEM-encoded CA bundle)

Origin allowlist defaults to localhost; tune via `MCP_HTTP_ALLOWED_ORIGINS`. See [docs/multi-tenant.md](docs/multi-tenant.md).

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
- **Cloudflare Workers entry.** `cf-worker/` is scaffolded against `@cloudflare/codemode` but the Web `Request`/`Response` ↔ MCP SDK Node-stream adapter is not implemented, and the Worker is not deployed anywhere. Tracked in [`cf-worker/README.md`](cf-worker/README.md).
- **Mutations beyond VM start/stop.** Docker container `start` / `stop`, parity check `start` / `cancel`, share / disk operations, user / API-key management, and the full mutation surface are wired through the typed dispatcher but **not live-verified**. Probing them blindly against live hardware is unsafe; we want testers with redundant homelabs.
- **Unraid Connect cloud surface.** `unraid.connect.*` is reserved in `TenantContext` and not yet implemented. The current server only talks to a controller you can reach over the LAN.
- **Real Unraid boxes other than the maintainer's homelab.** A single Unraid 7.2 box is not enough to generalise resilience claims — different array configs, plugin sets, network topologies, and Unraid versions will all surface different edge cases.
- **Long-running soak / stability under sustained load.**

## Roadmap

**Done in `v0.1.0-beta.2`:**

- ✅ **Expose the sandbox wall-clock deadline as `UNRAID_EXECUTE_TIMEOUT_MS`** (1 s – 10 min, default 30 s). Useful for slow-booting VMs and for very large `Promise.all` batches against a controller under load.
- ✅ **CSRF-aware error decoration** — when an Unraid box returns `extensions.code: UNAUTHENTICATED` + `Invalid CSRF token`, the MCP server adds a remediation hint pointing at API key re-mint, the curl sanity check, and the box-side log path. See [`docs/security.md`](docs/security.md#unraid-72-csrf-behaviour).
- ✅ **MCP `serverInfo.version` reads from `package.json` at runtime** — no more hand-stamped version drift between releases.
- ✅ **End-to-end LLM-mediated invocation verification** through `cursor-agent` (Claude Sonnet 4.6) and `opencode` (DeepSeek v4 Flash). See the verification matrix above.

**Still open (rough order, highest-leverage first):**

- **More LLM clients verified** — Claude Code CLI, Claude Desktop, MCP Inspector (CLI smoke runs in CI but UI is unverified), VS Code + Copilot. Roadmap item, gating for `1.0.0`.
- **Auto-bump the bundled SDL pin** via Dependabot-style PRs as new `unraid/api` releases ship. Foundational dependency hygiene.
- **Streamable HTTP multi-tenant deployment** verified against a real reverse proxy with rotating per-tenant credentials.
- **Mutation verification matrix** beyond VM start/stop — Docker container lifecycle, parity checks, share/disk ops — once we have testers with redundant hardware.
- **`unraid.connect.*`** namespace for the Unraid Connect cloud API. Reserved in `TenantContext` today, not yet implemented.
- **Cloudflare Workers transport adapter** (the bridge from Web `Request`/`Response` to the MCP SDK's Node `IncomingMessage`/`ServerResponse`). Tracked in [`cf-worker/README.md`](cf-worker/README.md).
- **NPM publish** — reserved for `1.0.0`. The package is `"private": true` until then.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`).

## License

MIT — see [LICENSE](LICENSE).

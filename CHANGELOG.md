# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **End-to-end LLM-mediated MCP verification** through two clients against a real Unraid 7.2 box:
  - `cursor-agent` v2026.05.05 + Claude Sonnet 4.6 — VERIFIED with 3 prompts (schema smoke, full live `info`/`array`/`shares`/`vms`/`docker`/`online` overview rendered to a Markdown table, and an error-path prompt where the agent surfaces a sandbox `TypeError` and stops without inventing a workaround). Transcript: [`out/verification/cursor-agent-sonnet-mcp-call.txt`](out/verification/cursor-agent-sonnet-mcp-call.txt).
  - `opencode` v1.14.30 + DeepSeek v4 Flash via `opencode-go/deepseek-v4-flash` — VERIFIED on the schema-only smoke (102 ops); the live overview's `Promise.all` execute call hit a mid-test upstream `Invalid CSRF token / 401` flip on the box. The model handled the upstream auth failure correctly (explained, suggested re-auth, did not flail) — useful evidence of behaviour under unexpected upstream changes. Transcript: [`out/verification/opencode-deepseek-mcp-call.txt`](out/verification/opencode-deepseek-mcp-call.txt).
- **`examples/unraid-expert-agent/`** — drop-in persona for any agent platform connected to this MCP server. Includes [`AGENTS.md`](examples/unraid-expert-agent/AGENTS.md) (the persona itself), [`SAMPLE_PROMPTS.md`](examples/unraid-expert-agent/SAMPLE_PROMPTS.md) (10 vetted prompts annotated with expected behaviour), [`install.md`](examples/unraid-expert-agent/install.md) (cross-platform install snippets for Cursor, opencode, Claude Code, Claude Desktop, VS Code + Copilot, MCP Inspector — with a per-platform VERIFIED / NOT-VERIFIED legend), and [`README.md`](examples/unraid-expert-agent/README.md) (intro + verification status).
- **Repo-rooted `.cursor/mcp.json`, `.cursor/cli.json`, and `opencode.json`** — env-var-interpolated, committed to the repo as both documentation and a one-step starting point for users + the maintainer's own verification runs.

### Notes for testers

- opencode v1.14.30 in `--pure run` mode hangs on stdin if you don't redirect from `/dev/null`. Append `< /dev/null` to every headless invocation.
- opencode persists per-model variant choices in `~/.local/state/opencode/model.json`. If a previous TUI session set `variant.opencode-go/deepseek-v4-flash` to `"max"`, every subsequent `--pure run` inherits it and runs with the max-reasoning budget. Reset by editing the JSON to set `"variant": {}` (or by toggling the variant back to default in the TUI).
- cursor-agent leaves new MCP servers as `not loaded (needs approval)` until you run `cursor-agent mcp enable unraid` once. The project-scoped `.cursor/cli.json` here pre-allows the `Mcp(unraid:search)` and `Mcp(unraid:execute)` tool grants so the per-call approval prompt also doesn't fire.

## [0.1.0-beta.1] — 2026-05-08

First public beta. Install from source. Not on npm yet.

### Added

- **Code-mode MCP server** for the Unraid 7.2+ GraphQL API. Two tools (`search` + `execute`) compatible with Cloudflare's Code Mode pattern. The LLM uses `search` (read-only, no network) to inspect the schema and writes JavaScript for `execute` to talk to the live API.
- **Five sandbox surfaces** under `unraid.local.*`:
  - `unraid.local.query.<fieldName>({ args, fields })` — typed query dispatch synthesised from introspected arg types.
  - `unraid.local.mutation.<fieldName>({ args, fields })` — typed mutation dispatch.
  - `unraid.local.graphql({ query, variables, operationName })` — raw GraphQL escape hatch.
  - `unraid.local.request({ method, path, body, headers })` — raw HTTP escape hatch for non-GraphQL Unraid endpoints.
  - `unraid.local.fields(typeName)` — surface the introspected field list of a type.
- **Single-user (env vars) and multi-user (per-request `X-Unraid-*` HTTP headers) modes**, with `AsyncLocalStorage`-scoped credentials so concurrent multi-tenant requests can't bleed.
- **Per-tenant TLS** — custom CA bundles or explicit `insecure` opt-in survive into a per-request `undici` dispatcher. The Cloudflare Worker variant rejects insecure mode entirely.
- **Bundled SDL fallback** — server boots without an Unraid box, parsing the latest committed `src/spec/local-fallback.graphql`; `search` is immediately usable. The bundled SDL is **pinned to a tagged `unraid/api` release** (currently `v4.33.0`) — no `main`-drift. `scripts/update-spec.ts` refreshes it from the pinned tag and stamps a header with the source URL, pinned tag, and fetch timestamp.
- **Cloudflare Workers scaffold** under `cf-worker/` using `@cloudflare/codemode`. Web `Request`/`Response` ↔ MCP SDK Node-stream adapter is not yet implemented.
- **Sandbox limits** — memory (64 MiB), wall-clock timeout (30 s), and per-execute API call budget (default 50; configurable via `UNRAID_MAX_CALLS_PER_EXECUTE`).
- **Operational scripts** — `scripts/sandbox-smoke.mjs` (standalone QuickJS bridge regression suite, runnable via `npm run test:sandbox`), `scripts/mcp-call.mjs` (ad-hoc stdio harness), `scripts/update-spec.ts` (refresh the pinned SDL).
- **CI** — GitHub Actions running `lint`, `typecheck`, `test`, and `build` on Node 20 + Node 22, plus an MCP Inspector smoke test that confirms `tools/list` exposes both `search` and `execute`.
- **Documentation** — [`docs/usage.md`](docs/usage.md), [`docs/architecture.md`](docs/architecture.md), [`docs/multi-tenant.md`](docs/multi-tenant.md), [`docs/deployment.md`](docs/deployment.md), [`docs/security.md`](docs/security.md), and [`SKILL.md`](SKILL.md) (LLM-facing operating manual).

### Sandbox / async architecture

- **QuickJS sync + Promise-callback host bridge** (instead of asyncify). Synchronous host functions accept sandbox-side `resolve` / `reject` handles, kick off Node.js async work, and invoke the sandbox callbacks on completion. The host's drain loop alternates `executePendingJobs()` with `setImmediate` and uses a wall-clock deadline. This pattern supports unlimited sequential and parallel `await` cleanly. The earlier asyncify-based implementation hit known upstream `quickjs-emscripten` heap-corruption bugs (filed as #258, #261, #235) on multi-await scripts; the sync + Promise-callback bridge is the canonical workaround. Verified by 25 sequential awaits, 10-way `Promise.all`, and mixed sequential/parallel patterns in `npm run test:sandbox` and the integration suite.

### Verification

- **Unit + integration tests** — 56 specs across spec loader, dispatcher, sandbox, HTTP client, multi-tenant context, and server transports — all green.
- **Live read sweep on a real Unraid 7.2 box** — `info`, `array`, `shares`, `vms`, `docker`, `online` queries all return real data through `scripts/mcp-call.mjs` driving the stdio transport. Sequential awaits and `Promise.all` both work end-to-end with real GraphQL latency.
- **Live mutation round-trip on the same box** — VM `SHUTOFF → RUNNING → SHUTOFF` cycle via `vmStart` / `vmStop`, with state polled between transitions. Error propagation verified by attempting `vmStart` on an already-running VM (returns a clean `Failed to set VM state: Invalid state transition from RUNNING to RUNNING` through `await`).
- **Introspection-disabled diagnostic** — when the Unraid `developer` flag is off, the loader returns a human-readable `INTROSPECTION_DISABLED` error with a remediation hint (`unraid-api developer --sandbox true`) instead of an opaque `HTTP 400`.

### Privacy / repo hygiene

- Working tree and full git history scanned for secrets, internal IPs, personal `/Users/...` paths, 1Password vault references, test VM UUIDs, and high-entropy tokens — all clean. Author email uses GitHub's `@users.noreply.github.com` form. The only IPs in tracked content are `192.168.1.10` (README docs example), `192.168.1.100` (UPS network address example, copied verbatim from the upstream Unraid SDL), and `127.0.0.1` (default origin allowlist for the HTTP transport).

### Known limitations

- No agent / IDE client has been live-verified end-to-end yet — only the raw stdio harness.
- The Streamable HTTP transport works in tests but has not been deployed multi-tenant behind a real reverse proxy.
- The Cloudflare Worker entry is scaffolded; the transport adapter is not implemented.
- Mutations beyond VM start/stop are wired but not live-verified.
- Single-box verification only — different array configs, plugin sets, and Unraid versions will surface different edge cases.

[Unreleased]: https://github.com/jmpijll/unraid-code-mode-mcp/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/jmpijll/unraid-code-mode-mcp/releases/tag/v0.1.0-beta.1

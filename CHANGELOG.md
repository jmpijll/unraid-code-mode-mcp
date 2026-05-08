# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

# AGENTS.md

Guidance for AI coding agents working on **unraid-code-mode-mcp**. This file is consumed by Cursor, Claude Code, and similar tools to set repo conventions.

## Project shape

- TypeScript ESM, Node ≥ 20.
- Source under `src/`. Tests under `src/__tests__/`. Scripts under `scripts/`. Cloudflare scaffold under `cf-worker/`.
- The MCP server exposes exactly two tools: `search` and `execute`. Don't add more without an architectural discussion — the whole point of "code mode" is the small surface.
- Two namespaces are reserved in the type system: `local` (the LAN GraphQL API) and `connect` (the future Unraid Connect cloud API). v0.1 only implements `local`. New code that needs a credential map should accept `'local' | 'connect'` even if it only handles `local` today.

## House style

- Match the conventions in [`unifi-code-mode-mcp`](https://github.com/jmpijll/unifi-code-mode-mcp). When in doubt, look there first.
- Prefer `import type` for type-only imports (ESLint enforces this).
- No `console.log` in production code. Use `console.error`/`console.warn` for diagnostics; the lint config allows those.
- Avoid `as` casts in test files — write tiny type-narrowing helpers instead.
- Don't add comments that narrate the code ("// loop over items"). Comment when the code's intent isn't obvious.
- Don't proactively add new docs files. Extend `README.md` or the existing `docs/*.md`.

## Required workflow

Before declaring work "done":

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

All four must pass. The MCP Inspector smoke test in CI greps for `search` and `execute` in `tools/list` output — if you rename either tool, update the workflow.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). When committing AI-assisted work, include a `Co-authored-by:` trailer. Example:

```
feat(sandbox): expose findOperationsByName in search executor

Co-authored-by: Cursor <noreply@cursor.com>
```

## Areas that bite

- **QuickJS asyncify.** Host functions exposed via `newAsyncifiedFunction` _appear synchronous_ inside the sandbox even though they're real promises in Node. Don't accidentally turn them into pure host promises in the prelude — the sandbox would deadlock.
- **GraphQL document synthesis.** `dispatchOperation` builds the `query opName($a: A!) { field(a: $a) { selection } }` string from introspected arg types. If you change `IndexedOperation`, double-check `buildOperationDocument` and the `dispatch.test.ts` snapshots.
- **TLS.** A custom `Dispatcher` passed to `undici` bypasses `MockAgent`. Tests that need the mock agent must not trigger the custom-dispatcher path. Unit-test the dispatcher builder in isolation instead.
- **SDL fallback.** `src/spec/local-fallback.graphql` is committed and refreshed by `scripts/update-spec.ts`. The Unraid SDL contains custom directives like `@usePermissions` — `buildSchema` is called with `assumeValidSDL: true`. Don't strip that flag.

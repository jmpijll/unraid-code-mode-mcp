# Contributing

Thanks for considering a contribution. This project is small and the contributor flow is intentionally lightweight.

## Development setup

```bash
git clone https://github.com/jmpijll/unraid-code-mode-mcp
cd unraid-code-mode-mcp
npm install --legacy-peer-deps
cp .env.example .env
# (optional) edit .env to point at a real Unraid box for live testing
npm run dev
```

## Useful scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the server via `tsx` (live TypeScript) |
| `npm run build` | Type-check + emit to `dist/` |
| `npm run lint` | ESLint over `src/`, `scripts/`, `cf-worker/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run format:check` | Prettier check (advisory in CI) |
| `npm test` | Vitest in CI mode |
| `npm run test:watch` | Vitest watch mode |
| `npm run update-spec` | Refresh `src/spec/local-fallback.graphql` from upstream |

CI runs `lint`, `typecheck`, `test`, and `build` on Node 20 + Node 22, plus an MCP Inspector smoke test that confirms `tools/list` exposes both `search` and `execute`. Keep them green.

## Style

- TypeScript everywhere, ESM modules.
- `prettier` defaults from `.prettierrc` (single quotes, semicolons, trailing commas, 100-char width).
- Follow the existing layout: features grow under the right `src/<area>/` folder and re-export via `src/<area>/index.ts`.
- Avoid trivial comments. Comments should explain "why", not narrate the code.
- Don't create new top-level docs unless asked — extend the existing files.

## Tests

- Unit tests live under `src/__tests__/`. Add one when you change behavior, refactor a non-trivial helper, or fix a bug.
- Integration tests use a tiny in-process `node:http` GraphQL mock (`src/__tests__/integration/mock-server.ts`) — extend it instead of spinning up new harnesses.
- Live-against-real-Unraid tests are gated behind the `UNRAID_LIVE_TEST=1` env var (no live tests committed yet — feel free to add them when you have hardware).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new behavior the user can observe
- `fix:` — bug fix
- `chore:` — internals, deps, lint, type-noise
- `docs:` — markdown / README only
- `test:` — only test files
- `ci:` — workflows / GH Actions

If working with an LLM coding assistant, include a `Co-authored-by:` trailer.

## Pull requests

Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Keep diffs focused — one concern per PR. Pre-existing Prettier drift on untouched lines is fine to leave alone.

## Security

Do not file security issues publicly. Use the [private security advisory form](https://github.com/jmpijll/unraid-code-mode-mcp/security/advisories/new). See [SECURITY.md](SECURITY.md).

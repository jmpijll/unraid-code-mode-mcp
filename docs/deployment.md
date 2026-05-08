# Deployment

> **Beta.** Of the deployment paths described below, only **local
> stdio** has been live-verified against a real Unraid box. The
> Streamable HTTP transport works in tests but has not been exercised
> behind a real reverse proxy with rotating per-tenant credentials.
> The Cloudflare Workers entry is **scaffolded but not deployed** —
> the Web `Request`/`Response` ↔ MCP SDK Node-stream adapter is the
> open work. Verification reports for any of these paths are very
> welcome (see the [README's project status](../README.md#project-status)).

## Local (development)

```bash
git clone https://github.com/jmpijll/unraid-code-mode-mcp
cd unraid-code-mode-mcp
npm install --legacy-peer-deps
cp .env.example .env
# edit .env — set UNRAID_BASE_URL + UNRAID_API_KEY
npm run dev
```

`npm run dev` runs the TypeScript entry directly via `tsx` and listens on
stdio by default. Connect any MCP client (Cursor, Claude Desktop, etc.) to
the resulting binary.

## Production (Node)

```bash
npm ci --legacy-peer-deps
npm run build
node dist/index.js
```

Set `MCP_TRANSPORT=http` and `MCP_HTTP_PORT=8000` (or your choice) to expose
the HTTP transport for multi-tenant deployments.

## Docker

```bash
docker compose up --build
```

Or pull/build manually:

```bash
docker build -t unraid-code-mode-mcp .
docker run --rm \
  -p 8000:8000 \
  -e MCP_TRANSPORT=http \
  -e UNRAID_BASE_URL=https://tower.local \
  -e UNRAID_API_KEY=*** \
  unraid-code-mode-mcp
```

The image runs as a non-root `mcp` user and includes a healthcheck that pings
`/health`.

## Cloudflare Workers (scaffold)

`cf-worker/` contains a Worker variant that uses `@cloudflare/codemode` and a
Worker Loader sandbox. It's currently a scaffold — see
[cf-worker/README.md](../cf-worker/README.md). Use the Node deployment for
fully-working multi-tenant HTTP today.

## Environment variables

See [.env.example](../.env.example) for the canonical list. Brief reference:

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `8000` | HTTP transport port |
| `MCP_HTTP_ALLOWED_ORIGINS` | `http://localhost,http://127.0.0.1` | Comma-separated; `*` disables |
| `UNRAID_BASE_URL` | — | e.g. `https://tower.local` |
| `UNRAID_API_KEY` | — | minted via `unraid-api apikey` |
| `UNRAID_CA_CERT_PATH` | — | path to PEM CA bundle |
| `UNRAID_INSECURE` | `false` | skip TLS verification |
| `UNRAID_SPEC_CACHE_DIR` | `~/.cache/unraid-code-mode-mcp` | introspection cache |
| `UNRAID_MAX_CALLS_PER_EXECUTE` | `50` | per-`execute` call budget |

## Refreshing the bundled SDL

```bash
npm run update-spec
```

Fetches the latest schema from `unraid/api` and writes it to
`src/spec/local-fallback.graphql`. Commit the result.

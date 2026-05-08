# unraid-code-mode-mcp

A code-mode MCP server for the **[Unraid](https://unraid.net) 7.2+ GraphQL API**. Exposes two MCP tools — `search` and `execute` — that let an LLM agent introspect and call any Unraid GraphQL field by writing JavaScript that runs inside a sandboxed QuickJS WASM context.

Built as the GraphQL-flavoured sibling of [unifi-code-mode-mcp](https://github.com/jmpijll/unifi-code-mode-mcp) and [fortimanager-code-mode-mcp](https://github.com/jmpijll/fortimanager-code-mode-mcp). Same architecture, same sandbox model, adapted to GraphQL introspection instead of OpenAPI.

> **Status: v0.1.** All 49 unit + integration tests pass and the server has been smoke-tested end-to-end against a real Unraid 7.2 box (`info`, `array`, `shares`, `vms`, `docker`, `online`, plus parallel `Promise.all` reads). The introspection-disabled fallback path and the bundled-SDL drift handling are both exercised. See [docs/usage.md](docs/usage.md#multiple-calls-per-execute-use-promiseall-not-sequential-await) for one upstream caveat (sequential `await` inside one `execute` is broken in `quickjs-emscripten`; use `Promise.all` instead).

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

**Read multiple things in parallel (preferred over sequential `await`):**

```js
// execute tool
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

## Multi-user / multi-tenant

Run with `MCP_TRANSPORT=http` and **without** env credentials. The MCP HTTP transport listens on `POST /mcp` + `GET /health`, and every request must carry:

- `X-Unraid-Api-Key`
- `X-Unraid-Base-Url`
- `X-Unraid-Insecure` (optional, `true` to skip TLS verification)
- `X-Unraid-Ca-Cert` (optional, PEM-encoded CA bundle)

Origin allowlist defaults to localhost; tune via `MCP_HTTP_ALLOWED_ORIGINS`. See [docs/multi-tenant.md](docs/multi-tenant.md).

## Roadmap

- Future `unraid.connect.*` namespace for the Unraid Connect cloud API. Reserved in `TenantContext` today, not yet implemented.
- Cloudflare Workers transport adapter (the bridge from Web `Request`/`Response` to the MCP SDK's Node `IncomingMessage`/`ServerResponse`). Tracked in `cf-worker/README.md`.
- Track [quickjs-emscripten#258](https://github.com/justjake/quickjs-emscripten/issues/258) so we can drop the "use `Promise.all`" caveat when the asyncify host-ref fix lands upstream.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`).

## License

MIT — see [LICENSE](LICENSE).

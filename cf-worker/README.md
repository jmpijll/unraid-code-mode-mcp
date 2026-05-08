# Cloudflare Workers entry

This directory contains a thin, Cloudflare-native deployment of the Unraid code-mode MCP server using the official [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) package and a [Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) sandbox.

## Status

**Scaffold.** The MCP server, schema loader, and host `request()` function are wired up against `openApiMcpServer` + `DynamicWorkerExecutor`. The HTTP-to-MCP transport adapter is intentionally a stub and returns 501.

For a fully-working multi-tenant HTTP MCP server, use the Node entry (`npm start` from the repo root).

## Why a stub?

The MCP TypeScript SDK's `StreamableHTTPServerTransport` is built on top of `node:http`'s `IncomingMessage` / `ServerResponse`. Workers exposes Web `Request` / `Response` instead. Bridging the two requires either:

1. The MCP SDK shipping a web-streams transport (tracked upstream)
2. A small shim that adapts Web `Request` to the SDK's expected shape

We'll ship that shim once the upstream story is clear; the rest of this Worker (auth, schema loading, sandbox) is already in place.

## Architecture

- **Tools:** the canonical Cloudflare `search` + `execute` pair (from `openApiMcpServer`).
- **Sandbox:** `DynamicWorkerExecutor` — a per-execution Worker isolate via the `LOADER` binding. `globalOutbound: null` blocks any direct fetch from the sandbox.
- **Auth:** per-request HTTP headers (`X-Unraid-*`), same contract as the Node HTTP transport — see [../docs/multi-tenant.md](../docs/multi-tenant.md).
- **Namespace:** v0 only ships `local`. The `connect` namespace is reserved.

## Deploy

```bash
npm run cf:dev      # local wrangler dev
npm run cf:deploy   # deploy to Cloudflare
```

## Limitations

- `X-Unraid-Insecure` is rejected — Workers can't skip TLS verification. Put a publicly trusted certificate on the Unraid server (or use the Node deployment behind a reverse proxy).
- No persistent on-disk schema cache; introspection results are cached in module memory per Worker instance.

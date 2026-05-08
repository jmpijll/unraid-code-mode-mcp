# Security

## Sandbox properties

- The `execute` tool runs LLM-written JavaScript inside a [QuickJS WASM](https://github.com/justjake/quickjs-emscripten) context. The sandbox **cannot** open sockets, read or write files, or load Node modules.
- All Unraid HTTP traffic happens on the host side. The sandbox calls `__unraidCallLocal(...)` / `__unraidCallLocalGraphql(...)` / `__unraidRawLocal(...)` shims that the host wraps via `newAsyncifiedFunction`.
- API keys, CA certs, and TLS settings live exclusively in the host's `TenantContext`; they're never injected into the sandbox.
- Per-execute call budget (default 50) prevents runaway loops from hammering the Unraid server.
- Per-execute time / memory caps (30 s / 64 MiB by default; 10 s / 32 MiB for `search`) bound CPU and memory.

## TLS

Unraid 7.2+ commonly serves the GraphQL API behind a self-signed `*.unraid.net` LAN certificate. The recommended order of operations:

1. **Best:** install the Unraid root CA on the machine running this MCP server, or fetch the cert from the Unraid box and supply it via `UNRAID_CA_CERT_PATH=/path/to/ca.pem`.
2. **OK for lab:** `UNRAID_INSECURE=true`. Logged loudly on every request.
3. **Multi-tenant:** clients can pass `X-Unraid-Ca-Cert` (PEM) and/or `X-Unraid-Insecure: true` per request.

The Cloudflare Worker variant rejects `X-Unraid-Insecure` because Workers cannot disable TLS verification.

## Reporting vulnerabilities

Don't open a public GitHub issue for security problems. Use the [private security advisory form](https://github.com/jmpijll/unraid-code-mode-mcp/security/advisories/new). See [SECURITY.md](../SECURITY.md) for the policy.

## What this server is **not** designed to do

- Run untrusted multi-tenant LLMs against the same Unraid server. The MCP server is single-trust; if you wouldn't give the LLM your API key, don't put it behind this server.
- Expose Unraid to the public internet. Sit behind a VPN or zero-trust proxy if you need remote access.
- Replace `unraid-api` access controls. The API key's roles still gate what the call can actually do.

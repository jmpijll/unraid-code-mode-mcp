# Security

## Sandbox properties

- The `execute` tool runs LLM-written JavaScript inside a [QuickJS WASM](https://github.com/justjake/quickjs-emscripten) context. The sandbox **cannot** open sockets, read or write files, or load Node modules.
- All Unraid HTTP traffic happens on the host side. The sandbox calls `__unraidCallLocal(...)` / `__unraidCallLocalGraphql(...)` / `__unraidRawLocal(...)` shims that the host wraps via `newAsyncifiedFunction`.
- API keys, CA certs, and TLS settings live exclusively in the host's `TenantContext`; they're never injected into the sandbox.
- Per-execute call budget (default 50, override via `UNRAID_MAX_CALLS_PER_EXECUTE`) prevents runaway loops from hammering the Unraid server.
- Per-execute time / memory caps (30 s default for `execute` — override via `UNRAID_EXECUTE_TIMEOUT_MS`, hard-capped at 10 minutes; 64 MiB memory; 10 s / 32 MiB for `search`) bound CPU and memory.

## TLS

Unraid 7.2+ commonly serves the GraphQL API behind a self-signed `*.unraid.net` LAN certificate. The recommended order of operations:

1. **Best:** install the Unraid root CA on the machine running this MCP server, or fetch the cert from the Unraid box and supply it via `UNRAID_CA_CERT_PATH=/path/to/ca.pem`.
2. **OK for lab:** `UNRAID_INSECURE=true`. Logged loudly on every request.
3. **Multi-tenant:** clients can pass `X-Unraid-Ca-Cert` (PEM) and/or `X-Unraid-Insecure: true` per request.

The Cloudflare Worker variant rejects `X-Unraid-Insecure` because Workers cannot disable TLS verification.

## Unraid 7.2 CSRF behaviour

The default contract for the Unraid GraphQL API is **`x-api-key` is sufficient** — an API key minted with the right roles authenticates the request, no CSRF token required. The MCP server's HTTP path treats it that way: every `/graphql` POST is sent with `x-api-key` and a JSON body, no cookie negotiation, no separate CSRF handshake.

In practice we have observed Unraid 7.2.x boxes return `extensions.code: UNAUTHENTICATED` + `originalError.message: "Invalid CSRF token"` (HTTP 401 wrapped inside a structured GraphQL error body) **even for `x-api-key`-authenticated calls** — including for trivial reads like `{ online }`. We've seen the policy flip mid-session on a single box, suggesting it's a server-side toggle rather than a client-side correctness bug.

**The MCP server detects this case** (CSRF text in the upstream message, or `extensions.code: UNAUTHENTICATED` with a CSRF-shaped `originalError`) and decorates the error returned to the agent with a remediation hint (`src/client/graphql.ts → decorateUnraidError`). The unit-tested shape:

```text
GraphQL error: Invalid CSRF token. Hint: this Unraid box rejected an
`x-api-key`-authenticated request with a CSRF / UNAUTHENTICATED error.
Most Unraid 7.2 boxes accept the API key without a CSRF token; if yours
does not, re-create the API key (Settings → Management Access → API Keys),
confirm `x-api-key` works with `curl -H "x-api-key: <key>" -d
'{"query":"{ online }"}' <BASE_URL>/graphql`, and check the box's
`unraid-api` logs for the CSRF middleware decision.
```

**What we don't yet do automatically:** fetch a CSRF token and replay the request. We considered it, but every documented Unraid auth path treats `x-api-key` as terminal; auto-negotiating CSRF tokens would mask a server-side configuration problem the operator should fix. If you have a deployment where CSRF negotiation is required *by design*, please [file a verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml) — we'd want to understand the setup before adding a code path that papers over it.

**Operator runbook when you hit this:**

1. SSH into the Unraid box. Confirm with `unraid-api status` that the API server is running.
2. Check `unraid-api logs` (or the GUI's Settings → Management Access → API Keys → audit log) for the CSRF rejection — it'll tell you which middleware decided to reject.
3. Re-mint the key with `unraid-api apikey --create --name "mcp" --roles ADMIN --json` and try again. If a fresh key with the same role passes, the previous key was carrying stale session state.
4. Sanity-check from the host running the MCP server with the curl one-liner above. If curl works and the MCP server still fails, please file a bug report.
5. If even a fresh key fails curl, the box is configured to require CSRF for everything — this is currently outside the MCP server's contract.

## Reporting vulnerabilities

Don't open a public GitHub issue for security problems. Use the [private security advisory form](https://github.com/jmpijll/unraid-code-mode-mcp/security/advisories/new). See [SECURITY.md](../SECURITY.md) for the policy.

## What this server is **not** designed to do

- Run untrusted multi-tenant LLMs against the same Unraid server. The MCP server is single-trust; if you wouldn't give the LLM your API key, don't put it behind this server.
- Expose Unraid to the public internet. Sit behind a VPN or zero-trust proxy if you need remote access.
- Replace `unraid-api` access controls. The API key's roles still gate what the call can actually do.

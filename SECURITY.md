# Security policy

## Supported versions

This project is in public **beta**. Only the latest tagged version
(currently `v0.1.0-beta.2`) receives security fixes.

| Version | Supported |
|---|---|
| `0.1.0-beta.x` | yes |
| `0.0.x` and earlier | no |

When `1.0.0` ships, we'll narrow this to "current minor + previous minor".

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's private security advisories:

1. Go to https://github.com/jmpijll/unraid-code-mode-mcp/security/advisories
2. Click **"Report a vulnerability"**
3. Fill in the form

Include:

- A description of the vulnerability and its impact
- Steps to reproduce (or a PoC)
- Affected commit / tag
- Suggested fix if you have one

We aim to acknowledge within 7 days and have a fix or mitigation within
30 days for confirmed issues. We'll coordinate disclosure with you.

## Scope

In scope:

- The MCP server (stdio + Streamable HTTP transports)
- The QuickJS sandbox host bridge (escape paths, header smuggling, prototype pollution between sandbox and host, secret leakage)
- The credential-resolution path (env vs HTTP headers, multi-tenant `AsyncLocalStorage` isolation)
- TLS handling, including any `UNRAID_INSECURE` / `X-Unraid-Insecure` overrides
- The Cloudflare Workers entry (`cf-worker/`)
- The GraphQL spec loader and its caching/network behaviour
- Anything in the published source that could mishandle a customer's Unraid API key or CA bundle

Out of scope (please report to Lime Technology / the Unraid project, not us):

- Vulnerabilities in the upstream [`unraid/api`](https://github.com/unraid/api) GraphQL server
- Vulnerabilities in the Unraid OS itself or in any plugin / Docker container running on it
- Vulnerabilities in `quickjs-emscripten-core`, `@modelcontextprotocol/sdk`, `undici`, `graphql`, or any other upstream dependency (please file with them; we'll bump once a fix lands)

## Threat model

This MCP server is a development / homelab tool, not a hardened multi-tenant SaaS:

- The `execute` tool runs **LLM-written JavaScript** against your Unraid server. Treat your MCP client config the way you'd treat your `unraid-api` key — anyone who can talk to your MCP server can issue mutations against your Unraid box.
- The QuickJS sandbox isolates the LLM's code from the host; API keys, CA bundles, and TLS settings never enter the sandbox. The sandbox cannot open sockets, files, or load Node modules.
- The host enforces a per-execute API call budget (default 50; configurable via `UNRAID_MAX_CALLS_PER_EXECUTE`) and a 30 s / 64 MiB sandbox cap to bound runaway loops.
- Multi-tenant deployments are gated by an origin allowlist (`MCP_HTTP_ALLOWED_ORIGINS`) and a 60 req/min/IP rate limiter. Sit it behind a reverse proxy with auth before exposing it to the public internet.

## TLS

`UNRAID_INSECURE=true` is supported as an explicit opt-in for lab use, with a noisy warning logged on every request. Production deployments should provide a CA bundle via `UNRAID_CA_CERT_PATH` (or `X-Unraid-Ca-Cert` per request in multi-tenant mode). The Cloudflare Worker variant rejects insecure mode entirely.

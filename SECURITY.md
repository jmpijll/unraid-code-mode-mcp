# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Use GitHub's [private security advisory form](https://github.com/jmpijll/unraid-code-mode-mcp/security/advisories/new) instead. We aim to acknowledge reports within 72 hours.

## Threat model

This MCP server is a development / homelab tool, not a hardened multi-tenant SaaS:

- The `execute` tool runs **LLM-written JavaScript** against your Unraid server. Treat your MCP client config the way you'd treat your `unraid-api` key — anyone who can talk to your MCP server can issue mutations against your Unraid box.
- The QuickJS sandbox isolates the LLM's code from the host; API keys, CA bundles, and TLS settings never enter the sandbox. The sandbox cannot open sockets, files, or load Node modules.
- The host enforces a per-execute API call budget (default 50; configurable via `UNRAID_MAX_CALLS_PER_EXECUTE`) and a 30 s / 64 MiB sandbox cap to bound runaway loops.
- Multi-tenant deployments are gated by an origin allowlist (`MCP_HTTP_ALLOWED_ORIGINS`) and a 60 req/min/IP rate limiter. Sit it behind a reverse proxy with auth before exposing it to the public internet.

## TLS

`UNRAID_INSECURE=true` is supported as an explicit opt-in for lab use, with a noisy warning logged on every request. Production deployments should provide a CA bundle via `UNRAID_CA_CERT_PATH` (or `X-Unraid-Ca-Cert` per request in multi-tenant mode). The Cloudflare Worker variant rejects insecure mode entirely.

## Supported versions

`main` is the only supported branch today. Once we cut tagged releases, this section will list which minor versions still receive security updates.

# Multi-tenant deployment

This document describes how to run a single MCP server instance that brokers
calls to many independent Unraid 7.2+ servers.

## Two modes

| Mode | Trigger | Credentials |
| --- | --- | --- |
| **Single-user** | env vars set at launch | `UNRAID_BASE_URL` + `UNRAID_API_KEY` from `.env` |
| **Multi-user** | `MCP_TRANSPORT=http` and env vars unset | per-request HTTP headers |

The server uses the same `TenantContext` everywhere — the only difference is the
source of the credentials.

## HTTP contract

The MCP HTTP transport listens on `POST /mcp` and `GET /health`. Every MCP
request must carry the headers below.

| Header | Required | Notes |
| --- | --- | --- |
| `X-Unraid-Api-Key` | yes | API key minted via `unraid-api apikey --create --name "mcp" --roles ADMIN --json` |
| `X-Unraid-Base-Url` | yes | Origin of the Unraid server, e.g. `https://tower.local`. The server appends `/graphql` |
| `X-Unraid-Insecure` | no | `true` to disable TLS verification (lab use only) |
| `X-Unraid-Ca-Cert` | no | PEM-encoded CA bundle for self-signed certs |

Origin allowlist: `MCP_HTTP_ALLOWED_ORIGINS` (defaults to localhost only). Set
to `*` to disable, or supply a comma-separated list. Non-browser clients
typically omit `Origin` and pass through.

## Why use it

- **One server, many homes.** A team or family running multiple Unraid servers can hit a single MCP endpoint with per-server credentials per request.
- **No long-lived secrets in the agent's config.** The agent itself just speaks MCP; the credentials live in the calling client.
- **Per-request TLS settings.** Every server can have its own CA bundle / insecure flag.

## Example client config

Cursor `mcp.json` snippet for the multi-tenant case:

```json
{
  "mcpServers": {
    "unraid": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Unraid-Base-Url": "https://tower.lan",
        "X-Unraid-Api-Key": "***"
      }
    }
  }
}
```

## Health check

`GET /health` returns:

```json
{
  "status": "ok",
  "uptimeSec": 1234,
  "stats": {
    "totalRequests": 50,
    "mcpRequests": 47,
    "rateLimited": 0,
    "errors": 0
  }
}
```

## Rate limiting

Default: 60 requests/minute per client IP. The HTTP transport pulls the IP
from `x-forwarded-for` if present, otherwise the socket's remote address.

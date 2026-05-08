# Architecture

This MCP server follows the [code-mode](https://blog.cloudflare.com/code-mode/) pattern popularised by Cloudflare and adapted by the [unifi-code-mode-mcp](https://github.com/jmpijll/unifi-code-mode-mcp) and [fortimanager-code-mode-mcp](https://github.com/jmpijll/fortimanager-code-mode-mcp) sister projects.

The promise of code mode is simple: instead of registering hundreds of MCP tools (one per API operation), the server exposes **two** tools — `search` and `execute` — and lets the LLM write JavaScript that runs inside a sandboxed QuickJS WASM context. The sandbox calls real Unraid GraphQL operations through host-provided functions.

## Module map

```
src/
├── index.ts                # Entry point; wires together config, spec, server, transport
├── config.ts               # Zod-validated env config
├── tenant/context.ts       # Per-request credential resolution (env or HTTP headers)
├── client/
│   ├── http.ts             # undici HttpClient with per-tenant TLS dispatcher
│   ├── graphql.ts          # GraphqlClient wrapper that POSTs to /graphql
│   ├── types.ts            # Shared client types (UnraidHttpError, GraphqlResponse, …)
│   └── index.ts            # Re-exports
├── spec/
│   ├── loader.ts           # Live introspection + bundled SDL fallback
│   ├── index-builder.ts    # Walks introspection JSON → IndexedOperation[]
│   ├── index.ts            # Search / lookup helpers (searchOperations, getOperation, getType)
│   └── local-fallback.graphql  # Bundled Unraid SDL (refreshed via npm run update-spec)
├── sandbox/
│   ├── executor.ts         # BaseSyncExecutor + console capture + runtime limits
│   ├── search-executor.ts  # Read-only sync sandbox for the `search` tool
│   ├── execute-executor.ts # Async QuickJS sandbox for the `execute` tool
│   ├── dispatch.ts         # Builds GraphQL documents + emits the unraid.* prelude
│   ├── limits.ts           # Time/memory/calls limits
│   └── types.ts            # ExecuteResult / LogEntry
├── server/
│   ├── server.ts           # MCP server factory; registers `search` + `execute`
│   ├── transport.ts        # stdio + Streamable HTTP transports
│   └── request-context.ts  # AsyncLocalStorage scope for HTTP headers
└── types/spec.ts           # Shared spec types (IndexedOperation, ProcessedSpec, TypeRef, …)
```

## Request lifecycle

```
LLM agent ──► MCP tool call (search|execute, { code })
              │
              ▼
       MCP transport (stdio | HTTP)
              │
              ▼
       AsyncLocalStorage scope holds HTTP headers
              │
              ▼
       Tool handler resolves a TenantContext (env or headers)
              │
              ▼
       Constructs an executor (Search or Execute)
              │
              ▼
       QuickJS sandbox runs the LLM's JS
              │
              ▼  (only for `execute`)
       Sandbox calls __unraidCallLocal('opName', argsJson)
              │
              ▼
       Host: dispatchOperation(client, spec, 'local', opName, payload)
              │
              ▼
       GraphqlClient → undici fetch → ${baseUrl}/graphql
              │
              ▼
       JSON response → unwrap data.<fieldName> → return to sandbox
              │
              ▼
       Final expression → ExecuteResult → MCP tool content
```

## Key design choices

### GraphQL, not OpenAPI

Unraid 7.2+ ships a single GraphQL endpoint at `/graphql` rather than the REST surface UniFi uses. We ingest the schema via standard introspection at startup, walk every `Query` and `Mutation` field, and partition the operations by namespace. The compact index is JSON-serialisable so we can inject it into the sandbox alongside the search helpers.

### Bundled SDL fallback

The bundled `src/spec/local-fallback.graphql` is fetched from the upstream `unraid/api` repo so the server can boot even when no Unraid instance is reachable (e.g. multi-tenant deployments waiting for the first request). `loadFallbackSpec` parses it via `graphql.buildSchema` + `introspectionFromSchema`.

### Reserved `connect` namespace

The tenant-context credential map is keyed by namespace (`local | connect`). v0 only ships `local`; the `connect` slot is wired in everywhere — context type, error messages, fallback paths — so that adding the future Unraid Connect cloud surface won't require a context-shape change.

### `args` + `fields` instead of GraphQL by hand

Typed calls accept a flat `{ args, fields }` payload. The host builds a parameterised GraphQL document on the fly using the introspected arg types, which means the LLM doesn't have to reason about variable typing or rebuild query strings. The dispatcher unwraps the `data.<fieldName>` envelope so the call returns just the field's value.

### Sandbox isolation

- Sandbox cannot reach the network directly — it talks to the host via `newAsyncifiedFunction` shims.
- TLS settings (CA cert path, insecure flag) live on the host and are applied to the undici dispatcher per tenant.
- API keys never enter the sandbox; the host injects them in headers before fetching.
- Per-execute call budget capped at 50 by default (`UNRAID_MAX_CALLS_PER_EXECUTE`).

## Multi-tenant mode

When the server is launched without env credentials and `MCP_TRANSPORT=http`, every MCP request must carry `X-Unraid-Api-Key` + `X-Unraid-Base-Url` headers (plus optional `X-Unraid-Insecure`, `X-Unraid-Ca-Cert`). See [multi-tenant.md](multi-tenant.md) for the full HTTP contract.

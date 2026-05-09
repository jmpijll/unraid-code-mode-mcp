# Coupling unraid-code-mode-mcp with Cursor

This guide is for users who want a Cursor IDE or Cursor CLI agent to drive
this MCP server. For a vendor-neutral guide on the server's two tools and
the JavaScript surface, read [`../SKILL.md`](../SKILL.md) first.

> **Verification status.** None of the agent-platform integrations
> described below have been live-verified by the maintainer for this
> Unraid server. The protocol-level smoke (`cursor-agent mcp list-tools
> unraid` returning `search` + `execute`) and the Vitest integration
> suite are green; an end-to-end LLM-mediated session through Cursor
> against a real Unraid box has not been recorded yet. The Cursor
> mechanics described here are sourced from the Cursor docs and from
> the sibling `unifi-code-mode-mcp` repo where the equivalent flow
> *has* been verified — every gotcha that's truly Cursor-level (not
> UniFi-specific) is reproduced here verbatim. If you try this against
> a real Unraid box, please file a [verification report](../.github/ISSUE_TEMPLATE/verification_report.yml).

## 1. Where MCP servers are configured in Cursor

Cursor reads MCP server entries from a JSON file called `mcp.json`:

| Scope | Path | Wins on name conflict |
|---|---|---|
| **Project** | `<repo>/.cursor/mcp.json` | yes |
| **Global (macOS / Linux)** | `~/.cursor/mcp.json` | no |

The same file is read by both Cursor IDE and the `cursor-agent` CLI. If
you add a project-scoped entry with the same name as a global one, the
project entry wins.

> Source: <https://cursor.com/docs/mcp.md>

## 2. Recommended: stdio entry (single tenant, IDE)

Most users want a single deployment per Cursor profile. Drop a
project-scoped `.cursor/mcp.json` next to the cloned repo:

```json
{
  "mcpServers": {
    "unraid": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "UNRAID_BASE_URL": "${env:UNRAID_BASE_URL}",
        "UNRAID_API_KEY": "${env:UNRAID_API_KEY}",
        "UNRAID_INSECURE": "${env:UNRAID_INSECURE}",
        "UNRAID_CA_CERT_PATH": "${env:UNRAID_CA_CERT_PATH}"
      }
    }
  }
}
```

> **Path note**: We use a workspace-relative path (`dist/index.js`) rather
> than `${workspaceFolder}/dist/index.js`. The
> `cursor-agent mcp list-tools <name>` subcommand does not expand
> `${workspaceFolder}`, which causes it to spawn `node /dist/index.js`
> and fail with `Connection closed`. Relative paths work in both the
> IDE and all `cursor-agent` subcommands.

Or, if you `npm link` the server globally so the binary is on `PATH`:

```json
{
  "mcpServers": {
    "unraid": {
      "command": "unraid-mcp",
      "env": {
        "UNRAID_BASE_URL": "${env:UNRAID_BASE_URL}",
        "UNRAID_API_KEY": "${env:UNRAID_API_KEY}"
      }
    }
  }
}
```

Cursor resolves `${env:NAME}` at config-load time against the **shell
environment that launched Cursor**. On macOS, that means setting them in
`~/.zshenv` (or letting them flow from 1Password's CLI shim) — env vars
set only in `.zshrc` may not be seen by GUI Cursor.

> "MCP servers use environment variables for authentication. Pass API
> keys and tokens through the config." — <https://cursor.com/docs/mcp.md>

> "`envFile` is only available for STDIO servers. Remote servers
> (HTTP/SSE) do not support `envFile`. For remote servers, use config
> interpolation with environment variables set in your shell profile or
> system environment instead." — <https://cursor.com/docs/mcp.md>

## 3. Streamable HTTP entry (remote / shared deployment)

If you run the server as a service (e.g. on a homelab box), point Cursor
at the HTTP endpoint:

```json
{
  "mcpServers": {
    "unraid": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:UNRAID_MCP_TOKEN}",
        "X-Unraid-Api-Key": "${env:UNRAID_API_KEY}",
        "X-Unraid-Base-Url": "${env:UNRAID_BASE_URL}",
        "X-Unraid-Insecure": "${env:UNRAID_INSECURE}"
      }
    }
  }
}
```

`${env:VAR}` interpolation is supported in `url` and `headers`.

## 4. Multi-tenant: register one entry per tenant

Cursor's MCP configuration schema only documents a static `headers` map
per remote server entry; values are resolved at config load via
`${env:…}` interpolation. The docs describe **no mechanism for
per-request or per-tenant header injection at the protocol layer**.

That means: if you operate two Unraid boxes from a single Cursor
session, register two MCP servers — one per tenant — each with its
own headers:

```json
{
  "mcpServers": {
    "unraid-home": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Unraid-Api-Key": "${env:UNRAID_HOME_KEY}",
        "X-Unraid-Base-Url": "https://tower.home.example"
      }
    },
    "unraid-customer-acme": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Unraid-Api-Key": "${env:UNRAID_ACME_KEY}",
        "X-Unraid-Base-Url": "https://nas.acme.example"
      }
    }
  }
}
```

The agent then picks the right server by name (`unraid-home` vs
`unraid-customer-acme`). The two entries hit the same backend; only
the headers (and therefore the destination Unraid box) differ.

## 5. Headless / CI invocation with cursor-agent

Run the agent non-interactively with auto-approval of MCP tool calls and
JSON output suitable for parsing:

```bash
cursor-agent \
  --workspace "$PWD" \
  --print \
  --output-format json \
  --approve-mcps \
  --force \
  "Use unraid to list every share and its free / used split, then return a markdown table."
```

There is **no `--mcp-config` flag** — the agent reads `.cursor/mcp.json`
in the workspace it was launched against. To use a different config,
either swap files or set the workspace.

> Sources: <https://cursor.com/docs/cli/headless.md>,
> <https://cursor.com/docs/cli/reference/parameters.md>

## 6. Coupling the agent with the SKILL

Cursor auto-discovers `SKILL.md` files in:

- `~/.cursor/skills/<name>/SKILL.md` (personal)
- `<repo>/.cursor/skills/<name>/SKILL.md` (project)

This repo's [`../SKILL.md`](../SKILL.md) sits at the **repo root** so it
ships with the source. To make the agent pick it up automatically when
working in another project, copy or symlink it into a skills directory:

```bash
mkdir -p ~/.cursor/skills/unraid-code-mode-mcp
ln -s "$PWD/SKILL.md" ~/.cursor/skills/unraid-code-mode-mcp/SKILL.md
```

The skill's frontmatter omits `disable-model-invocation`, so the agent
will reach for it whenever it sees Unraid-shaped queries.

If you'd rather keep things explicit, point the agent at the skill in
your prompt:

```bash
cursor-agent --print "Use the unraid-code-mode-mcp skill to give me a health summary of my home NAS."
```

## 7. End-to-end smoke test

A single command to verify the wiring once the env vars are set and
`npm run build` has populated `dist/`:

```bash
cursor-agent --print --output-format json --approve-mcps --force \
  "Use unraid to call search('shares', 5) and then execute one operation that returns shares: name, free, used. Return the operationId you used and the count of shares." \
  | tee out/cursor-smoke.json
```

If you only need to verify the protocol-level behaviour (not the IDE
client), the project's Vitest integration suite does exactly that
without depending on the CLI:

```bash
npm test -- src/__tests__/integration
```

It spins up the real `createMcpServer` factory against an in-process
`node:http` GraphQL mock and exercises both the in-memory MCP transport
(stdio-equivalent) and the Streamable HTTP transport.

For a hardware-free protocol smoke that doesn't even need an Unraid
box, `npm run build` then `cursor-agent mcp list-tools unraid` should
print both `search` and `execute` — the bundled SDL fallback path
boots without any GraphQL endpoint reachable.

If the smoke fails, check in this order:

1. Is the server actually registered? Run `cursor-agent --list-mcps` (or
   the IDE's *MCP* settings panel) and confirm `unraid` appears.
2. Are credentials reaching the server? Hit `/health` if you're on the
   HTTP transport, or run `npm run dev` directly and tail logs.
3. Is the controller reachable from where Cursor is running? Try
   `curl -k "$UNRAID_BASE_URL/graphql" -X POST -H 'Content-Type: application/json' -H "x-api-key: $UNRAID_API_KEY" -d '{"query":"{ online }"}'`.
4. Is GraphQL introspection enabled on the Unraid box? If you get an
   `INTROSPECTION_DISABLED` diagnostic from the server, run
   `unraid-api developer --sandbox true` on the Unraid box; otherwise
   the server falls back to the bundled SDL pinned at
   `unraid/api@v4.33.0`.

## 8. Known limitations specific to Cursor

- **No per-request headers.** Confirmed via the docs (see §4 above).
  Workaround: one MCP entry per tenant.
- **`envFile` doesn't apply to remote servers.** All credentials for an
  HTTP entry must come from `${env:…}` or be hard-coded in `headers`.
- **Cursor IDE caches MCP server connections.** After editing
  `mcp.json`, reload the window (`Cmd+Shift+P → Developer: Reload Window`)
  or the new headers won't take effect.
- **`cursor-agent --force` bypasses the per-tool approval prompt.** Use
  it in CI; avoid it in interactive sessions where you want a human
  approval gate on mutating Unraid calls (VM start/stop, share/disk
  ops, container restarts).
- **`${workspaceFolder}` is not always interpolated.** The
  `cursor-agent mcp list-tools <name>` subcommand specifically does not
  expand it (the server fails to spawn with `Connection closed`). Use a
  workspace-relative path like `"args": ["dist/index.js"]` instead — it
  works for both the IDE and the CLI subcommands. Verified against
  cursor-agent v2026.05.05 in the sibling unifi-code-mode-mcp repo.
- **`cursor-agent` does not auto-inject custom MCPs as model tools.**
  This is the most important caveat for cursor-agent. Across both
  `--print` (headless) and interactive (TUI) sessions, against
  `composer-2-fast`, `gpt-5.3-codex`, and `claude-4.6-sonnet-medium`,
  with `cursor-agent mcp list` reporting the server as `ready` and
  `--approve-mcps --force` set, custom MCP servers configured in
  `.cursor/mcp.json` are **not** added to the model's tool list. The
  model has access only to Cursor's built-ins (`codebase_search`,
  `run_terminal_cmd`, `grep`, `read_file`, plus a `listMcpResources`
  tool that returns `[]` for project-scoped servers). There is no
  `mcp__<server>__<tool>` entry exposed to the model.

  Sufficiently capable models (Sonnet 4.6, Codex 5.3) work around this
  on their own: they read `.cursor/mcp.json` from the workspace, find
  the server's command, and drive it over stdio by writing a raw
  JSON-RPC message into `node dist/index.js` via `run_terminal_cmd`.
  The result is correct — verified end-to-end in the sibling
  unifi-code-mode-mcp repo against cursor-agent v2026.05.05 — but the
  workaround is slow, costs extra tokens, and depends on the model's
  willingness to read the workspace config. The same workaround
  *should* work for this Unraid server but is **not yet verified by
  us** — please file a [verification report](../.github/ISSUE_TEMPLATE/verification_report.yml)
  if you confirm or refute it.

  **Reliable smokes** (in order of weakest → strongest evidence):

  1. **Protocol-level (no LLM, no auth):**
     `cursor-agent mcp list-tools unraid` should print both `search`
     and `execute`. This proves the registration is correct and is
     the only smoke that works without an Unraid box.
  2. **Functional (no LLM):** the Vitest integration suite —
     `npm test -- src/__tests__/integration` — speaks the same MCP
     wire protocol as Cursor would, via the in-memory MCP transport
     and `StreamableHTTPClientTransport`.
  3. **End-to-end LLM-mediated:** drive `cursor-agent --print` with a
     prompt that asks for a real Unraid query (e.g. `online`) and
     confirm the model returns the live value. **Not yet recorded for
     this server** — testers wanted.

  **Permissions tip** (for interactive `cursor-agent` sessions): if
  the global `~/.cursor/cli-config.json` uses
  `"approvalMode": "allowlist"`, add a project-scoped
  `.cursor/cli.json` to pre-allow this server's tools without
  prompting:

  ```json
  {
    "permissions": {
      "allow": [
        "Mcp(unraid:search)",
        "Mcp(unraid:execute)"
      ]
    }
  }
  ```

## 9. Reference

| Item | URL |
|---|---|
| Cursor MCP configuration | <https://cursor.com/docs/mcp.md> |
| `cursor-agent` headless mode | <https://cursor.com/docs/cli/headless.md> |
| `cursor-agent` parameters | <https://cursor.com/docs/cli/reference/parameters.md> |
| This server's two-tool surface | [`../SKILL.md`](../SKILL.md) |
| Server installation | [`./usage.md`](./usage.md) |
| Multi-tenant transport details | [`./multi-tenant.md`](./multi-tenant.md) |

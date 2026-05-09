# Cross-platform install guide — Unraid expert agent

How to wire `unraid-code-mode-mcp` into different agent platforms,
with the `unraid-expert-agent` persona loaded as the system prompt.
Each section is self-contained.

## Verification legend

- **VERIFIED** — The maintainer has run a real LLM through this client and watched it call the MCP tools end-to-end. Configurations below are known to work.
- **NOT-VERIFIED** — The configuration follows the platform's documented MCP support and *should* work, but we haven't tested it. Please file a [verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml) if you do.
- **PROTOCOL-ONLY** — The MCP handshake works, but the platform's particular client mode doesn't expose custom tools to the LLM in the current release. See notes per platform.

> **Surface verification (independent of agent platform).** All live verification recorded so far is against a single Unraid 7.2 box (the maintainer's homelab) — read sweep across `info` / `array` / `shares` / `vms` / `docker` / `online`, plus a VM `SHUTOFF → RUNNING → SHUTOFF` mutation cycle via `vmStart` / `vmStop`. End-to-end LLM-mediated invocation is verified through `cursor-agent` (Claude Sonnet 4.6) and `opencode` (DeepSeek v4 Flash via `opencode-go`). All other agent / IDE clients are wired but **NOT verified by us**. See the [project status](https://github.com/jmpijll/unraid-code-mode-mcp#project-status) callout in the README.

## Prerequisites (every platform)

```bash
git clone https://github.com/jmpijll/unraid-code-mode-mcp.git
cd unraid-code-mode-mcp
npm install --legacy-peer-deps
cp .env.example .env
# Set UNRAID_BASE_URL and UNRAID_API_KEY
npm run build
# Sanity check (boots the stdio server, prints help / version):
node dist/index.js --help 2>/dev/null || echo "stdio server is fine"
```

The server's stdio entry is `node dist/index.js`. The HTTP transport
entry is the same binary with `MCP_TRANSPORT=http` set.

The full path to use in absolute-path snippets below:

```bash
echo "$(pwd)/dist/index.js"
# e.g. /Users/you/code/unraid-code-mode-mcp/dist/index.js
```

We use `/absolute/path/to/unraid-code-mode-mcp/dist/index.js` as a
placeholder.

---

## Cursor IDE / `cursor-agent` CLI — VERIFIED (`cursor-agent` only)

> The Cursor IDE chat panel is **PROTOCOL-ONLY** with cursor-agent v2026.05.05 — the IDE's MCP client does register the server (you'll see it in the IDE's MCP settings panel), but the model in chat may not auto-call the tools. The CLI (`cursor-agent --print`) is verified end-to-end with Claude Sonnet 4.6 (see `out/verification/cursor-agent-sonnet-mcp-call.txt`).

Add to `.cursor/mcp.json` at your project root, **or** to the global config at `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unraid": {
      "command": "node",
      "args": ["/absolute/path/to/unraid-code-mode-mcp/dist/index.js"],
      "env": {
        "UNRAID_BASE_URL": "https://tower.local",
        "UNRAID_API_KEY": "...",
        "UNRAID_INSECURE": "true"
      }
    }
  }
}
```

Or, with the credentials forwarded from the parent shell (recommended — keeps the JSON committable):

```json
{
  "mcpServers": {
    "unraid": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "UNRAID_BASE_URL": "${env:UNRAID_BASE_URL}",
        "UNRAID_API_KEY": "${env:UNRAID_API_KEY}",
        "UNRAID_INSECURE": "${env:UNRAID_INSECURE}"
      }
    }
  }
}
```

Then drop the persona at the project root as `AGENTS.md`:

```bash
cp examples/unraid-expert-agent/AGENTS.md AGENTS.md
```

(Cursor reads project-root `AGENTS.md` automatically.)

Headless run:

```bash
export UNRAID_BASE_URL=https://tower.local
export UNRAID_API_KEY=...
export UNRAID_INSECURE=true

cursor-agent --print --output-format json --approve-mcps --force \
  --model claude-4.6-sonnet-medium \
  "Use the unraid MCP search tool with the code field set to: spec.local.operations.length . Return only the integer it produces."
```

See [`docs/cursor-skill.md`](../../docs/cursor-skill.md) for the full Cursor coupling guide including the `${workspaceFolder}`-not-expanded gotcha and the IDE chat-panel caveat.

---

## opencode (CLI) — VERIFIED

Tested with `opencode` v1.14.30 + `opencode-go/deepseek-v4-flash`.

Project-scoped `opencode.json` at the repo root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "unraid": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "enabled": true,
      "environment": {
        "UNRAID_BASE_URL": "{env:UNRAID_BASE_URL}",
        "UNRAID_API_KEY": "{env:UNRAID_API_KEY}",
        "UNRAID_INSECURE": "{env:UNRAID_INSECURE}"
      }
    }
  },
  "permission": {
    "unraid_*": "allow"
  }
}
```

Notes:

- Top-level key is `mcp` (not `mcpServers`). Per-server `type: "local"` for stdio. `command` is a single argv array. Environment vars under `environment` (not `env`).
- The `permission` block uses opencode's auto-generated `<server>_<tool>` names — opencode automatically prefixes every tool with the server key, so `search` becomes `unraid_search`. **For shared sessions, do not use `"unraid_*": "allow"` if you want a human approval gate on mutations.**

Drop the persona at the project root as `AGENTS.md`:

```bash
cp examples/unraid-expert-agent/AGENTS.md AGENTS.md
```

(opencode reads project-root `AGENTS.md` as the agent system prompt.)

Smoke test (no LLM):

```bash
opencode mcp list
# expected:
# ●  ✓ unraid connected
#        node dist/index.js
# └  1 server(s)
```

Headless run:

```bash
export UNRAID_BASE_URL=https://tower.local
export UNRAID_API_KEY=...
export UNRAID_INSECURE=true

opencode --pure run --model opencode-go/deepseek-v4-flash \
  "Use the unraid_search tool with code='spec.local.operations.length'. Reply with only the number."
```

`--pure` skips opencode's `plugin.copilot` bootstrap, which has a known Zod-validation crash that can hang in v1.14.30. See [`docs/opencode-skill.md`](../../docs/opencode-skill.md) for the full opencode coupling guide.

---

## Claude Code CLI — NOT-VERIFIED

Documented to work via the bundled MCP client. Add the server with:

```bash
claude mcp add unraid \
  --transport stdio \
  -- node /absolute/path/to/unraid-code-mode-mcp/dist/index.js \
  --env UNRAID_BASE_URL=https://tower.local \
  --env UNRAID_API_KEY=... \
  --env UNRAID_INSECURE=true
```

Verify with:

```bash
claude mcp list
claude mcp get unraid
```

Adopt the persona by dropping it as `CLAUDE.md` at your project root:

```bash
cp examples/unraid-expert-agent/AGENTS.md CLAUDE.md
```

End-to-end LLM call: needs `ANTHROPIC_API_KEY` in your environment (or interactive auth). **Verification report welcome.**

---

## Claude Desktop — NOT-VERIFIED

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (similar paths on Linux / Windows — see Claude Desktop docs):

```json
{
  "mcpServers": {
    "unraid": {
      "command": "node",
      "args": ["/absolute/path/to/unraid-code-mode-mcp/dist/index.js"],
      "env": {
        "UNRAID_BASE_URL": "https://tower.local",
        "UNRAID_API_KEY": "...",
        "UNRAID_INSECURE": "true"
      }
    }
  }
}
```

Reload Claude Desktop. The persona can't be loaded as a system prompt the same way — paste it into a project's instructions or the conversation's system prompt slot. **Verification report welcome.**

---

## VS Code + GitHub Copilot Chat — NOT-VERIFIED

Recent Copilot Chat versions read MCP servers from `.vscode/mcp.json` (workspace) or VS Code user settings (`mcp.servers`). Workspace example:

```json
{
  "servers": {
    "unraid": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unraid-code-mode-mcp/dist/index.js"],
      "env": {
        "UNRAID_BASE_URL": "https://tower.local",
        "UNRAID_API_KEY": "...",
        "UNRAID_INSECURE": "true"
      }
    }
  }
}
```

**Verification report welcome.**

---

## MCP Inspector (CLI) — NOT-VERIFIED for this server

The CI workflow runs an MCP Inspector CLI smoke that confirms `tools/list` exposes both `search` and `execute`. Manual interactive use:

```bash
npx -y @modelcontextprotocol/inspector \
  --cli node /absolute/path/to/unraid-code-mode-mcp/dist/index.js \
  --method tools/list

npx -y @modelcontextprotocol/inspector \
  --cli node /absolute/path/to/unraid-code-mode-mcp/dist/index.js \
  --method tools/call \
  --tool-name search \
  --tool-arg code='spec.local.operations.length'
```

UI mode (browser-based): `npx -y @modelcontextprotocol/inspector` then connect via stdio to `node /absolute/path/to/unraid-code-mode-mcp/dist/index.js`. **Verification report welcome.**

---

## Continue / Cline / Aider / Zed / Codex CLI — NOT-VERIFIED

All have documented MCP support of varying maturity. Configurations follow the same `command + args + env` shape as Claude Desktop. **Verification report on any of these is high-leverage.**

---

## Per-platform persona file mapping

| Platform | Persona file |
|---|---|
| Cursor | `AGENTS.md` at project root |
| `cursor-agent` CLI | `AGENTS.md` at project root + `--print` prompt |
| opencode | `AGENTS.md` at project root |
| Claude Code CLI | `CLAUDE.md` at project root |
| Claude Desktop | Paste into project / conversation system prompt |
| VS Code + Copilot | `.github/copilot-instructions.md` (workspace) |
| Continue | `~/.continue/config.json` `systemMessage` |
| MCP Inspector | N/A (no LLM in the loop) |

When in doubt, copy [`AGENTS.md`](AGENTS.md) into whatever the platform calls "system prompt" or "persona" or "agent definition file". The content is platform-agnostic.

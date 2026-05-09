# Coupling unraid-code-mode-mcp with opencode

This guide is for users who want the [opencode](https://opencode.ai) AI
agent CLI to drive this MCP server. For a vendor-neutral guide on the
two-tool surface, read [`../SKILL.md`](../SKILL.md) first.

> **Verification status.** Not yet live-verified by the maintainer for
> this Unraid server. The opencode mechanics described here are sourced
> from the opencode docs and from the sibling `unifi-code-mode-mcp`
> repo where the equivalent flow *has* been verified end-to-end against
> a real device. If you try this against a real Unraid box, please
> file a [verification report](../.github/ISSUE_TEMPLATE/verification_report.yml).

## 1. Where MCP servers are configured in opencode

opencode reads MCP server entries from a JSON config file:

| Scope | Path | Wins on name conflict |
|---|---|---|
| **Project** | `<repo>/opencode.json` (or `.jsonc`) | yes |
| **Global** | `~/.config/opencode/opencode.json` (or `.jsonc`) | no |

> Source: <https://opencode.ai/docs/config/> and <https://opencode.ai/docs/mcp-servers/>

## 2. Recommended: project-scoped stdio entry

Drop an `opencode.json` next to the cloned repo (the project-scoped
file wins over the global one, so this is the safest place to put it):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "unraid": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "enabled": true
    }
  },
  "permission": {
    "unraid_*": "allow"
  }
}
```

Key differences from Cursor's `mcp.json`:

- Top-level key is `mcp` (not `mcpServers`).
- Per-server: `type: "local"` for stdio, `command` is a single argv array
  (binary + args combined — there is no separate `args` field).
- Environment variables go under `environment` (not `env`).
- The `permission` block at the top level uses the auto-generated
  `<server>_<tool>` names — opencode automatically prefixes every tool
  with the server key, so `search` becomes `unraid_search`.

opencode auto-injects MCP tools into the model's tool list (verified
against the sibling unifi server with `opencode-go/deepseek-v4-flash`),
so there's nothing to wire up on the prompt side — just ask the model
to use `unraid_search` or `unraid_execute`.

## 3. Credentials

opencode forwards the parent-process environment to the MCP child.
Set the env vars in your shell before running opencode:

```bash
export UNRAID_BASE_URL=https://tower.local
export UNRAID_API_KEY=…
export UNRAID_INSECURE=true   # only if you don't have the LAN CA installed
opencode run --model opencode-go/deepseek-v4-flash "Use unraid_search to find queries about shares, then use unraid_execute to list every share with its free / used split."
```

Or pin them in `opencode.json` for that profile:

```json
{
  "mcp": {
    "unraid": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "environment": {
        "UNRAID_BASE_URL": "https://tower.local",
        "UNRAID_API_KEY": "…"
      },
      "enabled": true
    }
  }
}
```

## 4. Smoke-test with `opencode mcp list`

Before involving any model, confirm opencode picks up the entry:

```bash
opencode mcp list
```

Expected:

```
●  ✓ unraid connected
       node dist/index.js
└  1 server(s)
```

If it says `failed`, run `opencode mcp list` once more — the first
start spawns the server and discovers tools; the second start will
show the final `connected` state. **Not yet recorded against this
server** — please file a verification report if you confirm or refute
the same behaviour you'd see against a healthy Node MCP server.

## 5. Headless run for verification

```bash
opencode --pure run --model opencode-go/deepseek-v4-flash \
  "Use the unraid_search tool with code='spec.local.operations.length'. Reply with only the number."
```

Expected: opencode prints the operation count from the bundled SDL
fallback (around 100 — `unraid/api@v4.33.0` exposes ~57 queries +
~45 mutations). The `--pure` flag is documented below as a workaround
for an opencode 1.14.30 plugin-bootstrap hang.

## 6. Known limitations specific to opencode (v1.14.30)

These are reproduced from the sibling unifi-code-mode-mcp repo where
they were verified live; they're opencode-level, not vendor-specific,
so they apply identically here.

- **`plugin.copilot` Zod-validation crash hangs bootstrap.** The
  bundled GitHub Copilot provider plugin in opencode 1.14.30 fails to
  parse `models.json` from `models.dev` for a handful of capability
  fields. The error is logged but the run hangs in `kevent64` waiting
  for I/O that never arrives. **Workaround**: pass `--pure` (skips
  plugins). All `github-copilot/*` and Anthropic models still work
  this way; only the auto-discovery of new copilot models is
  disabled.
- **Persisted model variants are silent.** opencode keeps per-model
  reasoning-effort overrides in `~/.local/state/opencode/model.json`
  under the `variant` key. If you ever ran a model with a high
  reasoning variant (e.g. via the TUI), every subsequent CLI
  invocation inherits it — and `opencode run` does not echo this. The
  unifi maintainer hit an 8.5-minute wait on `deepseek-v4-flash`
  because of a stuck `variant: "max"`. To clear: edit the file or run
  with `--variant default` on the next invocation.
- **Permissions allowlist syntax differs from Cursor.** opencode uses
  permission keys like `"unraid_*": "allow"` at the top level
  `permission` block — Cursor uses `"Mcp(unraid:search)"` patterns
  inside `.cursor/cli.json`. They are not interchangeable.
- **`opencode run` is silent until completion** (no streaming progress
  on stdout) — point the watcher at the rolling log file under
  `~/.local/share/opencode/log/` instead.
- **Mutating tools should not be on `allow`** in shared sessions. The
  example in §2 uses `"unraid_*": "allow"` for convenience; for any
  session where the agent might call `vmStop`, `dockerStop`, parity
  ops, or share/disk operations and you want a human approval gate,
  switch to per-tool permissions instead.

## 7. Reference

| Item | URL |
|---|---|
| opencode config | <https://opencode.ai/docs/config/> |
| opencode MCP servers | <https://opencode.ai/docs/mcp-servers/> |
| opencode CLI | <https://opencode.ai/docs/cli/> |
| opencode permissions | <https://opencode.ai/docs/permissions/> |
| This server's two-tool surface | [`../SKILL.md`](../SKILL.md) |
| Server installation | [`./usage.md`](./usage.md) |
| Multi-tenant transport details | [`./multi-tenant.md`](./multi-tenant.md) |

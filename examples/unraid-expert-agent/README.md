# Unraid expert agent — example persona + prompts

A drop-in persona that turns any LLM agent connected to the
[`unraid-code-mode-mcp`](https://github.com/jmpijll/unraid-code-mode-mcp)
server into a **senior Unraid administrator**: deeply familiar with the
array, ZFS / btrfs / xfs pools, Docker containers, KVM/QEMU VMs, shares,
parity protection, plugins, the Unraid Connect cloud surface, and the
realities of homelab operation on Lime Technology's Unraid OS.

## What's in here

| File | Purpose |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The persona itself. Drop into any system-prompt slot or per-agent config (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.opencode/agent/<name>.md`, etc.) |
| [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md) | Vetted prompts to validate the wiring end-to-end. Each one is annotated with what we expect the agent to do |
| [`install.md`](install.md) | Cross-platform install snippets — Cursor IDE, `cursor-agent` CLI, opencode, Claude Code, Claude Desktop, VS Code + Copilot, MCP Inspector |

## Who this is for

- **Operators** who run an Unraid box (or several) and want a chat-style ops console grounded in real GraphQL.
- **Hosters** running this MCP server multi-tenant for friends / family / clients and want a consistent agent identity across deployments.
- **Testers** who want to drop a vetted persona into a fresh agent platform and file a [verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml) about whether end-to-end LLM-mediated invocation works.

## Verification status

The persona has been smoke-tested against:

- **`cursor-agent` v2026.05.05 + Claude Sonnet 4.6** (`claude-4.6-sonnet-medium`)
- **`opencode` v1.14.30 + DeepSeek v4 Flash** via the `opencode-go/deepseek-v4-flash` model

Transcripts under [`out/verification/`](../../out/verification/).

If you test it elsewhere, please file a [verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml) — that's the single most useful contribution to this project right now.

## License

Same as the parent repo: MIT.

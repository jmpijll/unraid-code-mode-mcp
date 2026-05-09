#!/usr/bin/env bash
# Local mirror of the CI MCP Inspector smoke.
#
# Boots the built `dist/index.js` server via the MCP Inspector CLI,
# requests `tools/list`, and asserts both `search` and `execute` are
# exposed. Exits non-zero on any deviation. No Unraid box required —
# the bundled SDL fallback is used when no env credentials are set.
#
# Usage:
#   npm run build && npm run smoke:inspector
#
# Env (all optional):
#   MCP_INSPECTOR_VERSION   pin a different Inspector version (default 0.20.0)
#   UNRAID_BASE_URL / *_API_KEY    forwarded so the smoke also touches the
#                                  live introspection path if you want it to

set -euo pipefail

VERSION="${MCP_INSPECTOR_VERSION:-0.20.0}"

if [[ ! -f dist/index.js ]]; then
  echo "[smoke-inspector] dist/index.js missing — run 'npm run build' first" >&2
  exit 2
fi

echo "[smoke-inspector] using @modelcontextprotocol/inspector@${VERSION}"
echo "[smoke-inspector] booting node dist/index.js, requesting tools/list…"

OUT=$(npx -y "@modelcontextprotocol/inspector@${VERSION}" \
  --cli node dist/index.js --method tools/list)

echo "$OUT" | head -c 4000
echo

if ! echo "$OUT" | grep -q '"name": "search"'; then
  echo "FAIL: 'search' tool not in tools/list" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q '"name": "execute"'; then
  echo "FAIL: 'execute' tool not in tools/list" >&2
  exit 1
fi
echo "OK: both 'search' and 'execute' tools exposed by dist/index.js"

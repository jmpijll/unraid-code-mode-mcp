#!/usr/bin/env bash
# Apply repo-level settings via the GitHub API.
#
# Usage:
#   bash scripts/post-flip-repo-settings.sh
#
# This script is idempotent — it can be re-run safely. Any setting
# that's already in the desired state will return a no-op response.
# It codifies the settings applied to jmpijll/unraid-code-mode-mcp at
# v0.1.0-beta.1; rerun after a fork / repo recreate to get parity.
#
# Requires: gh CLI authenticated (`gh auth status`).

set -euo pipefail

REPO="${REPO:-jmpijll/unraid-code-mode-mcp}"

if ! command -v gh >/dev/null 2>&1; then
  echo "[post-flip] gh CLI not found — install from https://cli.github.com/" >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "[post-flip] gh CLI not authenticated — run 'gh auth login' first" >&2
  exit 2
fi

echo "[post-flip] target repo: $REPO"
echo "[post-flip] visibility check…"
gh repo view "$REPO" --json visibility,isPrivate

# 1. Topics — make the repo discoverable.
echo "[post-flip] adding topics…"
gh repo edit "$REPO" \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic unraid \
  --add-topic lime-technology \
  --add-topic code-mode \
  --add-topic quickjs \
  --add-topic cloudflare \
  --add-topic graphql \
  --add-topic homelab \
  --add-topic nas

# 2. Issues + Discussions on, Wiki off, Projects off, Squash-merge only.
echo "[post-flip] toggling features…"
gh repo edit "$REPO" \
  --enable-issues \
  --enable-discussions \
  --enable-squash-merge \
  --enable-rebase-merge=false \
  --enable-merge-commit=false \
  --enable-wiki=false \
  --enable-projects=false \
  --delete-branch-on-merge

# 3. Custom labels (idempotent via --force).
echo "[post-flip] creating custom labels…"
gh label create verification \
  --repo "$REPO" \
  --color "FBCA04" \
  --description "Verification report against an agent platform / Unraid version we haven't tested" \
  --force
gh label create needs-triage \
  --repo "$REPO" \
  --color "EDEDED" \
  --description "Needs maintainer triage before being actionable" \
  --force
gh label create live-verified \
  --repo "$REPO" \
  --color "0E8A16" \
  --description "Behaviour live-verified against a real Unraid box" \
  --force
gh label create not-yet-verified \
  --repo "$REPO" \
  --color "F9D0C4" \
  --description "Wired but not yet live-verified — testers welcome" \
  --force

# 4. Private vulnerability reporting (private security advisories).
echo "[post-flip] enabling private vulnerability reporting…"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" || \
  echo "[post-flip] WARN: private-vulnerability-reporting toggle failed — enable manually in Security settings"

# 5. Branch protection on main: require PR review, require build status, linear history.
echo "[post-flip] applying main branch protection…"
gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build (20.x)", "build (22.x)"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON

echo "[post-flip] DONE"
echo "[post-flip] verify in browser:"
echo "  https://github.com/$REPO/settings"
echo "  https://github.com/$REPO/settings/security_analysis"
echo "  https://github.com/$REPO/settings/branches"
echo "  https://github.com/$REPO/labels"

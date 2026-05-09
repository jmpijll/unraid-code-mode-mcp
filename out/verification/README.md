# Verification artefacts

This directory contains sanitized records of every live end-to-end
verification we have run against real hardware. Each `*.txt` file is
a self-contained record of one verification — what it proves, what
it does not prove, the verbatim command, the sandbox code that ran,
and probe metadata.

> **Honesty about provenance.** The verifications recorded here were
> driven from the maintainer's terminal during pre-tag iteration on
> v0.1.0-beta.1. Raw stdout transcripts were captured in scratch
> scripts that were deleted after each session, so the files below
> document **the exact code that ran and the observed response
> shape** rather than pasting the literal stdout. Where claims about
> response *values* appear (e.g. "VM transitioned to RUNNING"), they
> are paraphrases of what the maintainer observed, not stdout
> archeology. Future verification runs should `tee` to a
> sanitization-safe file *before* deletion so the literal stdout can
> be committed alongside the structured record.

## Naming convention

| File | What it records |
|---|---|
| `local-read-sweep-live-smoke.txt` | Read-only sweep through `unraid.local.query.*`: `info`, `array`, `shares`, `vms`, `docker`, `online` |
| `vm-cycle-mutation-live-smoke.txt` | VM `SHUTOFF → RUNNING → SHUTOFF` round-trip via `unraid.local.mutation.vmStart` / `vmStop`, with state polled between transitions |
| `sandbox-multi-await-stress.txt` | Standalone `npm run test:sandbox` regression for the sync + Promise-callback host bridge — 25 sequential awaits, 10-way `Promise.all`, mixed patterns, error propagation. Hardware-free. |

## What sanitization means here

These records are written to be safe for a public repo while still
being useful for reproducibility. Concretely:

### Always redacted

- The Unraid API key (`UNRAID_API_KEY`) — replaced with `<redacted>`.
- The maintainer's Unraid base URL (`UNRAID_BASE_URL`) — replaced
  with `https://tower.local` (a documentation-grade placeholder).
- VM UUIDs (`vms.domain.uuid`) — replaced with `<vm-uuid>`.
- Share names that look identifying (e.g. real usernames) —
  replaced with the generic `<share-N>` placeholder.
- Absolute home-directory paths (`/Users/<name>/…`) — replaced with
  `/path/to/unraid-code-mode-mcp`.
- Docker container names that look identifying — replaced with
  `<container-N>` placeholders.

### Never redacted

- **Tool arguments** other than secrets — they're in the SDL anyway.
- **GraphQL operation names and field selections** — they're public
  schema.
- **Counts** (number of shares, number of containers, number of
  VMs) — they say nothing identifying.
- **Error shapes** (`message`, `extensions.code`, HTTP status,
  GraphQL `path`) — these are documentation.
- **Timings** (latency in milliseconds) — useful for reasoning about
  performance, identify nothing.

### Will be added if the maintainer can re-run

The unifi sibling repo's transcripts include a literal `EXACT
RESPONSE (truncated)` section under each phase. This Unraid set
currently does not because the original stdout wasn't preserved.
Re-running with `tee out/verification/<name>.txt` plus a
post-processing `sed` to redact the items above is the path forward;
PRs welcome.

## Reproducing locally

Every transcript has an `EXACT COMMAND` section near the top. Set
`UNRAID_BASE_URL` and `UNRAID_API_KEY` in the environment, then run
the command verbatim. The standalone sandbox stress (`npm run
test:sandbox`) needs no hardware at all and can be verified by anyone
with the repo cloned.

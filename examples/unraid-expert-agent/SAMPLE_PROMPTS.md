# Sample prompts for the Unraid expert agent

Vetted prompts to validate that your agent + the MCP server + the
persona are all wired up correctly. Each one is annotated with what
we expect the agent to do, so you can compare with what your agent
actually did.

> **Tip:** Run them in order. Each one builds on what the previous one
> exercised. **All prompts below are read-only and safe** — no
> mutations.

## How to use these

1. Install the server and wire it into your agent (see [`install.md`](install.md)).
2. Adopt the persona — copy [`AGENTS.md`](AGENTS.md) into whichever per-platform persona slot applies.
3. Paste a prompt below. Most prompts have no placeholders. The few that mention specific shares / VMs / containers will work whatever your environment looks like, because the agent will list what's actually there.
4. **File a [verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml)** with the agent, model, prompt(s) you tried, and what happened. The final prompt below is **specifically designed** to elicit a verification report.

---

## 1. Smoke test — just count operations (read-only, no Unraid box needed)

```text
Use the unraid MCP search tool with the code field set to:
  spec.local.operations.length
Return only the integer it produces.
```

**Expected behaviour:**

1. Calls `unraid_search` (opencode) or `search` (Cursor / others) with `{ "code": "spec.local.operations.length" }`.
2. Reports a single number (around 100 — `unraid/api@v4.33.0` exposes ~57 queries + ~45 mutations against a typical 7.2 box; the bundled SDL fallback yields the same count).

This prompt does not require a real Unraid box because `search` is a hardware-free schema introspection tool. It's the lowest-effort way to confirm the MCP wiring is correct end-to-end.

---

## 2. One-screen overview (read-only, real Unraid box required)

```text
Give me a one-screen overview of my Unraid box: OS distro / version,
CPU model and core/thread count, current array state, share count,
VM count (and how many running), container count (and how many
running), and the boolean `online` field. Return as a small Markdown
table.
```

**Expected behaviour:**

1. One or more `search` calls to confirm `info`, `array`, `shares`, `vms`, `docker`, and `online` are the right operations (the persona instructs to confirm-before-call).
2. **One** `execute` call with a `Promise.all` of typed queries, returning a structured object the agent can render as a table.
3. Final answer: a clean Markdown table with the listed columns.

**Anti-pattern to look for:** the agent making one `execute` call per field instead of one combined script — fine functionally, but indicates the persona's "synthesise client-side" instruction didn't land.

---

## 3. Container inventory (read-only)

```text
List every Docker container on my Unraid box. For each container,
show its name(s), image, current state (RUNNING / EXITED / etc.),
and a short status string if available. Group running and stopped
containers separately and include a one-line summary at the top
(e.g. "12 containers — 8 running, 4 stopped").
```

**Expected behaviour:**

1. `search` for `docker` — find the `docker` query and inspect the `Containers` type's fields.
2. **One** `execute` with `unraid.local.query.docker({ fields: 'containers { id names image state status }' })`.
3. Group client-side and render two Markdown tables (or one with a `state` column) plus the summary line.

---

## 4. VM inventory (read-only)

```text
List every VM defined on my Unraid box. For each one, show its name,
UUID, and current state (SHUTOFF / RUNNING / PAUSED / …). Tell me how
many are running vs how many are defined.
```

**Expected behaviour:**

1. `search` for `vms` — confirm the `vms` query returns `domain[]` with `uuid`, `name`, `state`.
2. **One** `execute` with `unraid.local.query.vms({ fields: 'domain { uuid name state }' })`.
3. Markdown table + the running-vs-defined summary.

---

## 5. Share storage breakdown (read-only)

```text
Give me a per-share storage breakdown: name, free, used, total. Round
to GiB. Sort by used descending. Note that Unraid emits these as
strings to avoid JS-number precision loss, so use BigInt arithmetic
in the sandbox if you need to compute totals.
```

**Expected behaviour:**

1. `search` for `shares` — confirm `name`, `free`, `used`, `size` are scalars.
2. **One** `execute` with `unraid.local.query.shares({ fields: 'name free used size' })`.
3. The agent recognises (from the persona's "Strings, not numbers, for big disk capacities" guidance) that it needs `BigInt` for totals; converts to GiB; sorts; renders a Markdown table.

**Anti-pattern to look for:** the agent treating `free` / `used` / `size` as numbers and producing `NaN` or wrong-precision values for multi-TiB shares.

---

## 6. Schema-only deep dive (read-only, no Unraid box needed)

```text
Without making any network calls, find me every GraphQL mutation in
the Unraid schema whose name starts with "vm". For each one, list
its name, its required arguments (with types), and its return type.
```

**Expected behaviour:**

1. **Only** `search` calls — the persona should NOT issue `execute` here.
2. The agent uses `findOperationsByName('vm')` filtered to `kind === 'mutation'`, or iterates `index.operations`, then for each match calls `getOperation(name, 'mutation')`.
3. A clean list / table with the mutation name, args, and return type.

This prompt verifies the agent reaches for `search` first and recognises that the question is a pure schema question — no live data needed.

---

## 7. Multi-step composition (read-only)

```text
For every container that's currently RUNNING, tell me which Unraid
share (under /mnt/user/<share>) it has bind-mounted, if any. Aggregate
by share so I can see "share X is bind-mounted by N containers" at the
end.
```

**Expected behaviour:**

1. `search` for both `docker` and `shares` — confirm container objects expose mount info (look for fields like `mounts`, `volumes`, `binds`, or similar; the exact field name depends on the Unraid 7.2 schema and the agent should let `search` tell it).
2. One `execute` that fetches running containers + their mount metadata, plus the share list.
3. Aggregates client-side into the requested per-share count.

**Anti-pattern to look for:** the agent guessing field names without `search` confirming them, or running 10 separate `execute` calls when one would do.

---

## 8. Health and warning sweep (read-only)

```text
Look across the whole Unraid box and tell me anything that looks
unhealthy or warrants attention right now. Examples of what counts:
- Array not in STARTED state
- Disks that are spun down for a really long time
- Parity check in progress (or never run)
- Containers in EXITED state that probably shouldn't be
- VMs in PAUSED or CRASHED state
- Anything in the `notifications` query that's `unread` and `severity != INFO`

For each finding, tell me: the layer, the specific item, why it
caught your eye, and the GraphQL operation you used to discover it.
End with an overall traffic-light verdict (GREEN / YELLOW / RED) and
why.
```

**Expected behaviour:**

1. Multiple `search` calls to discover the right operations (`array`, `disks`, `parityHistory` / `parityStatus`, `vms`, `docker`, `notifications`).
2. One or two `execute` invocations that fan out via `Promise.all` and return a structured findings array.
3. Markdown output with sections per layer, then the verdict with a one-line rationale.

This is the persona's headline capability: synthesising across the whole Unraid surface without the user having to point at specific operations.

---

## 9. Error-path handling (read-only)

```text
Try to call the Unraid query `definitelyDoesNotExistOperation123`. I
want to see exactly what error the MCP server returns and how you
handle it. Tell me what kind of error it is, what your next move
would be in a real session, and don't try to "recover" by inventing
a different operation.
```

**Expected behaviour:**

1. Either: the agent's `search` reveals there's no such operation and the agent reports that without hitting `execute` (best case).
2. Or: the agent calls `execute` with `unraid.local.graphql({ query: '{ definitelyDoesNotExistOperation123 }' })`, gets a GraphQL `Cannot query field` error, surfaces it cleanly, and explicitly does not try to "fix" it by guessing.
3. The persona's "**Never** invent a different operation name to 'work around' a 400" rule applies here — the agent should stop, not flail.

---

## 10. Verification report self-prompt (please file one!)

```text
You are an Unraid expert agent connected to the unraid-code-mode-mcp
server. Take whatever model + agent platform combination you're
running on right now, run prompts 1, 2, 3, 4 above against this
server, and at the end produce a filled-in
.github/ISSUE_TEMPLATE/verification_report.yml-shaped Markdown
document I can paste into a GitHub issue. Include: the agent name +
version, the model, the server version (run search with
`spec.local.version`), the transport (stdio), the Unraid version (run
execute against `unraid.local.query.info({ fields: 'os { distro
release } versions { unraid }' })`), the prompts you ran, the
sanitized transcripts (redact API key / hostname / VM UUIDs), and
your assessment of friction points.
```

**Expected behaviour:**

1. Runs prompts 1–4 in sequence, captures the output of each.
2. Drafts a single Markdown document matching the verification-report template.
3. Sanitizes the output before producing it.

If your agent + model combination produces this report cleanly, paste it into a [new verification report](https://github.com/jmpijll/unraid-code-mode-mcp/issues/new?template=verification_report.yml). That single act is the highest-leverage thing any tester can do for this project right now.

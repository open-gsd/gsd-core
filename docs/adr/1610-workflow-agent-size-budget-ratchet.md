# ADR 1610: workflow & agent size-budget ratchet (per-file byte baseline + tier hard caps) [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-22

> **Provenance.** Drafted 2026-06-22 to give an already-shipped architectural governance
> decision its first ADR. The decision landed across three PRs — #1089 (additive per-file
> workflow baseline guard), #1096 (swap enforcement to baseline + loose hard caps), #1097
> (agent-size baseline + line→byte rebase) — under epic #1074, building on #717 (bytes rebase)
> and #683 (LF-normalized byte count) and superseding the #597 tier-max ratchet. Authored by
> the implementer. Verified against `tests/{workflow,agent}-size-budget.test.cjs`,
> `tests/{workflow,agent}-size-baseline.json`, `scripts/workflow-size.cjs`, and
> `scripts/lib/allowlist-ratchet.cjs` on `next`. The rationale here is lifted from those
> tests' own doc comments (the decision was documented in-code but never as an ADR).

## Context

`gsd-core/workflows/*.md` and `agents/*.md` are loaded **verbatim into agent context** every
time the corresponding command/agent runs. Unbounded growth is paid on every invocation across
every session, and — more importantly — degrades quality: larger context erodes recall and
reasoning ("context rot" / finite attention budget). With prompt caching the per-invocation
*cost* premise is weak (cache reads are ~10% of input), so the **caching-independent quality
argument is the load-bearing one**: lean, high-signal instructions produce better plans.

The prior mechanism (#597) was a **tier-max tighten-only ratchet**: it bound only the single
largest file per tier, leaving the other ~85 files free to grow silently. That left the actual
risk — broad, quiet creep across many files — unguarded.

No ADR governs how GSD bounds instruction-document size. The decision currently lives only in
test doc comments, so it is invisible to anyone browsing `docs/adr/` and at risk of being
weakened (e.g. "just bump the baseline") without encountering its rationale.

## Decision

1. **Measure in BYTES, not lines (#717).** Line count is a poor proxy — markdown tables and
   fenced code are token-dense, so a line budget over-penalizes prose and under-catches dense
   additions. Bytes are cheap, deterministic, and need no tokenizer; they are also the unit
   vendors bound on (Codex caps instruction docs at 32,768 bytes, `project_doc_max_bytes`, and
   truncates past it). We adopt the **unit**, not the exact number.

2. **Count LF-normalized bytes (#683).** Normalize CRLF→LF (`content.replace(/\r\n/g, '\n')`)
   before counting so a CRLF (Windows) checkout yields the same byte count as an LF checkout —
   a raw on-disk count would add one byte per line on Windows and make the guard
   platform-dependent.

3. **Two complementary guards, neither a tier-max ceiling (#1074):**
   - **Per-file baseline (the anti-creep).** Every workflow/agent file is pinned to its exact
     byte size in `tests/{workflow,agent}-size-baseline.json`. Any growth fails with the file
     name and delta. A deliberate change is recorded via `npm run size:baseline` as a one-line
     reviewable diff. This is the day-to-day guard and it covers **every** file, not just the
     largest-per-tier.
   - **Tier hard caps (the outer bound).** XL / LARGE / DEFAULT are absolute red lines with
     real headroom (`XL_CAP = 98304` / 96 KiB, `LARGE_CAP = 61440` / 60 KiB,
     `DEFAULT_CAP = 40960` / 40 KiB), a few KB above the largest file in each tier — the largest
     XL orchestrators (`plan-phase.md`, `execute-phase.md`) currently sit in the low-90s KB, a
     few KB under `XL_CAP`. (Exact per-file sizes are not duplicated here: they live in
     `tests/workflow-size-baseline.json`, the enforced source of truth, and an absolute byte
     count quoted in prose drifts with every edit.) Hard caps are never raised in normal work;
     crossing
     one is a signal to do **lazy extraction**, not a `+N` bump. New workflow files default to
     the Codex 32 KiB anchor (`NEW_FILE_CAP = 32768`) unless explicitly tiered in the same PR.

4. **The metric is a proxy for bounded *loaded* context — do not game it.** The real target is
   total context loaded at runtime. Because `@~/.claude/gsd-core/references/...` imports are
   loaded **eagerly**, moving prose into an eagerly @-imported reference shrinks the measured
   file while leaving (or growing) total loaded context — that is gaming the proxy (Goodhart's
   Law: the moment the byte count is the target, the cheapest way to satisfy it is to relocate
   bytes, not remove them). **Legitimate extraction is LAZY**: content `Read` only at the step
   that needs it (the `workflows/discuss-phase/modes/` progressive-disclosure pattern). The
   per-file baseline + tier-cap pair is itself a Goodhart hedge — two guards pulling in
   different directions are harder to game than one.

5. **Shared measurement path.** The guard and the baseline generator both measure via
   `scripts/workflow-size.cjs` (`lfByteCount`/`measureWorkflows`, re-exported to
   `scripts/update-size-baseline.cjs` and asserted via
   `scripts/lib/allowlist-ratchet.cjs` `assertFileBaseline`), so the recorded baseline and the
   enforced size can never drift apart (#1074).

## Alternatives considered (rejected & deferred)

- **Tier-max tighten-only ratchet (#597) — SUPERSEDED.** Bound only the largest file per tier;
  the other ~85 files could grow silently. Replaced by the per-file baseline, which guards
  every file. *Re-open only if* the per-file baseline proves too noisy in practice (it has not).
- **A line-count budget — REJECTED (#717).** Token-dense tables/code make lines a poor proxy;
  bytes are the vendor-bound, tokenizer-free unit. *Re-open only if* a cheap token count
  becomes portably available and measurably better than bytes.
- **Eager `@`-import extraction to "fit" a file — REJECTED as proxy-gaming (#717).** Shrinks the
  measured file without shrinking loaded context. Only **lazy** (Read-at-step) extraction
  counts. Not re-openable — it defeats the goal the metric proxies.
- **Codex 32 KiB as a hard ceiling for the grandfathered orchestrators — REJECTED.** The XL/
  LARGE tiers sit *above* 32 KiB because they are top-level orchestrators loaded by Claude, not
  Codex `AGENTS.md` docs; 32 KiB is the **new-file anchor**, not a universal cap.

## Consequences

- **Positive:** broad, quiet size creep is caught per-file across the whole surface; deliberate
  growth is an explicit, reviewable one-line baseline diff; the byte unit is deterministic and
  cross-platform (LF-normalized); the "bounded loaded context" goal and its anti-gaming rule
  are recorded where a contributor will meet them; the quality (context-rot) rationale is no
  longer caching-dependent hand-waving.
- **Costs:** every legitimate edit to a workflow/agent file must regenerate the baseline
  (`npm run size:baseline`) or the guard reds — intentional friction that makes growth visible.
  The baseline JSON is a merge-conflict surface on concurrent edits (resolved by regenerating).
- **Boundary:** this governs **instruction-document size** (workflow/agent `.md` loaded into
  context). It is distinct from the **install-time skill-surface budget** of ADR-0010/0011
  (how many skills are eagerly registered) — different lever, different file, do not conflate.

## Cross-references

- Epic #1074 (per-file baseline + hard caps); #717 (bytes rebase + rationale); #683 (LF byte
  count); #597 (superseded tier-max ratchet); PRs #1089 / #1096 / #1097.
- Code: `scripts/workflow-size.cjs`, `scripts/update-size-baseline.cjs`,
  `scripts/lib/allowlist-ratchet.cjs` (`assertFileBaseline`),
  `tests/{workflow,agent}-size-budget.test.cjs`, `tests/{workflow,agent}-size-baseline.json`.
- Related but distinct: **ADR-0010/0011** (skill-surface budget — install-time, not file size);
  **ADR-456** (test-rigor architecture — the test these guards are authored under).
- External anchors: Codex `project_doc_max_bytes` (32 KiB); Anthropic "effective context
  engineering for AI agents" (the context-rot / attention-budget argument).

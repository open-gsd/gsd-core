# Plan-vs-codebase drift guard: defaults and symbol-resolver seam

- **Status:** Proposed
- **Date:** 2026-05-29
- **Issue:** open-gsd/gsd-core#22

## Context

The planner regularly cites symbols that do not exist in the codebase — invented decorators, wrong dataclass fields, renamed CLI flags, mismatched signatures. The phenomenon is measured, not anecdotal: the *Practical Code Generation* hallucination taxonomy (arXiv:2409.20550) reports Dependency Conflicts (11.26%) and API Knowledge Conflicts (20.41%), which together describe exactly this failure. Today the drift is caught only at execution time by the executor (ImportError/AttributeError), at roughly 10–15 min/fix, a dozen per multi-wave phase.

`/gsd:plan-review-convergence` does not catch it because planner and reviewer both read the same channel (other plan files); the drift originates in that channel. The fix must introduce an out-of-band source of truth: the project's own source code.

GSD ships `intel.cjs` (`api-map.json` et al.), but: enabling `intel.enabled` populates nothing (the `gsd-intel-updater` LLM agent is never auto-spawned; population is a manual `/gsd:map-codebase --query refresh`); extraction is regex, JS/CJS/ESM only; intel is stale after 24h with no auto-refresh (`intelUpdate()` is a stub); useful intel therefore costs recurring LLM-agent token spend.

The feature has two halves with different dependencies: a **verification pass** that reads live source (needs no intel, works in any language) and a **surface-injection** step that renders `api-map.json` into `API-SURFACE.md` for the planner (needs intel).

## Decision

### Part 1 — Defaults

1. Ship the **verification pass on by default**, behind a new, additive config key `plan_review.source_grounding` (boolean, default `true`, opt-out). Surface it as one question in `/gsd:new-project` (default Y) and as a toggle in `/gsd:settings`. It stays on permanently with an easy off switch.
2. The **`API-SURFACE.md` injection** stays gated on the existing `intel.enabled` (default unchanged). It ships in this release but only activates for projects that opted into intel and populated it. Its planner instruction is a **hint** ("prefer symbols in API-SURFACE.md; it may be incomplete"), never a hard rule.
3. **`intel.enabled` stays opt-in.** Flip its default to `true` only once all three hold: (a) deterministic population (tree-sitter/CJS parse, not an LLM agent); (b) auto-refresh on staleness; (c) multi-language coverage. None of these block the drift guard, because the default-on half does not depend on intel.
4. Only new, additive config keys are introduced. No pre-existing default is changed.

### Part 2 — Symbol-resolver seam

The reviewer pass depends on a resolver seam, not a hardcoded tool:

    resolve(ref) -> VERIFIED{location, exported, signature?} | MISSING | AMBIGUOUS{candidates} | UNCHECKABLE{reason}

Resolution is **three-valued, not boolean**. `UNCHECKABLE` (the adapter cannot analyze this language or symbol kind) never blocks and never falsely blesses; it is recorded as a coverage gap. Only `MISSING` from a *capable* adapter is actionable.

Adapters form an authority ladder, selected by `plan_review.source_grounding_authority` (enum; default `grep`, auto-upgrades to `intel` when `intel.enabled`), with no prompt changes when climbing:

| Rung | Backend | Asserts | This release? |
|------|---------|---------|---------------|
| 0 | ripgrep / Read | name present in source | yes (default) |
| 1 | api-map.json (existing intel) | name in parsed export list | yes (when intel on) |
| 2 | tree-sitter | real declaration + kind | deferred (new dep) |
| 3 | LSP workspace/symbol | + resolved definition, signature | deferred (new dep) |
| 4 | SCIP / GitNexus (#3802) | + exported?, signature, references | deferred (new dep) |

Locked sub-decisions:
- **Severity.** `MISSING` from rung 0–1 -> `needs-acknowledgement` (the plan proceeds if the author confirms the symbol is new/dynamic, logged), not a hard block — because rung 0–1 produce false positives on dynamic dispatch, re-exports, metaprogrammed decorators, and generated code. Hard block (HIGH) is reserved for rung >=3 adapters that can prove absence. `AMBIGUOUS` -> MEDIUM. `UNCHECKABLE` -> INFO.
- **New vs. existing.** Plans declare created symbols in an "Artifacts this phase produces" section. The resolver only checks symbols not in that list, so greenfield work is never flagged MISSING.
- **Extraction contract.** The reviewer enumerates a fixed set of symbol kinds (`@decorators`, `Class.method`, `module.function`, `--cli-flags`, file paths, dataclass/struct fields) and must quote the plan line for each, so coverage is auditable.
- **Signature-drift** can only be asserted at rung >=3; rungs 0–1 return `UNCHECKABLE` for signatures (name-drift only this release).
- **Cadence.** Resolve once per unique symbol per convergence cycle (cache within the cycle); run the pass every cycle so cycle-N fixes are re-verified in cycle N+1.
- **Coverage reporting.** `REVIEWS.md` carries a "Verification coverage" INFO block listing every UNCHECKABLE/skipped symbol and why, so "the guard ran" can never silently mean "nothing was checked."

## Consequences

### Positive
- Every project gets drift protection on day one, in any language, with zero setup and zero token cost (live Grep/Read against ground truth).
- The high-authority, always-fresh check is the default; the low-authority, stale-able cache (intel) stays an explicit, paid opt-in.
- One interface, many backends: raising verification authority (grep -> intel -> tree-sitter -> LSP -> SCIP) is a config change, never a workflow rewrite — the durable lever against worsening hallucination.
- Three-valued resolution refuses the RAG trap where missing context is treated as permission to invent, and cannot be poisoned by stale/partial intel.
- `needs-acknowledgement` keeps the default-on gate tolerable (no blocking valid plans), preserving adoption.
- Honors the issue author's own sequencing ("treat the default flip as a separate proposal") and changes no established default.

### Negative
- Two config surfaces (`plan_review.source_grounding` and `intel.enabled`) instead of one.
- This release's rung 0–1 catch name-drift but not signature-drift; signature coverage waits on a rung >=3 adapter.
- Requires planners to populate the "Artifacts this phase produces" section reliably; a missing list degrades precision (new symbols flagged for acknowledgement).
- The default-on pass adds reviewer tool calls per convergence cycle (bounded by the cadence rule above).

## Alternatives considered

- **Flip `intel.enabled` to default-on and gate the whole feature on it.** Rejected: enabling intel populates nothing, so default-on intel makes `API-SURFACE.md` inject a near-empty surface; combined with a "use only these symbols" instruction it tells the planner the codebase is empty — strictly worse than no surface. Also imposes silent emptiness on non-JS projects, widens the stale-data window, and pulls solo devs toward unrequested agent-token spend.
- **Ship the feature opt-in (default-off).** Rejected: the protection is free in the default (live-source) configuration; opt-in would leave most projects unprotected for no benefit while hallucination worsens.
- **Hardcode Grep/Read in the reviewer prompt.** Rejected: binds the workflow to one tool, over-claims ("found in text" = "verified"), and forces a prompt rewrite to adopt a better backend later.
- **Boolean resolution (verified / not-verified).** Rejected: collapses "couldn't check" into "missing," producing false positives on every unsupported language and silently blessing nothing.
- **Hard-block on any MISSING (as originally proposed).** Rejected for rung 0–1: false positives from dynamic/re-exported/generated symbols would block valid plans and get the default-on guard switched off. Retained only for rung >=3.

## References
- Issue: open-gsd/gsd-core#22 (migrated from gsd-build/get-shit-done#3813)
- Relates to #3802 (GitNexus first-class code intelligence) — rung 4 backend
- arXiv:2409.20550 — hallucination taxonomy + RAG mitigation (modest gains)
- arXiv:2502.05111 — grammar-constrained decoding (soft vs hard constraints)
- SCIP: https://github.com/sourcegraph/scip · LSP 3.17 spec · tree-sitter.github.io

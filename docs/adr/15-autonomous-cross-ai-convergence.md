# Cross-AI Plan Convergence via Existing Orchestration Commands

- **Status:** Accepted — ratified 2026-07-17 (originally Proposed 2026-05-24); see "Ratification" below
- **Date:** 2026-05-24
- **Issue:** #15

Current orchestration commands (`/gsd-autonomous` and `/gsd-progress --next --auto`) route planning through `gsd-plan-phase` and only use local/Claude subagent review paths. The cross-AI convergence path already exists (`/gsd-plan-review-convergence`, `/gsd-review`, `review.default_reviewers`, `review.models.*`) but is not wired into these orchestrators. This creates a gap: users can configure cross-AI reviewers yet still get local-only planning in autonomous/auto-chain execution.

## Ratification (2026-07-17): Proposed → Accepted

Ratified by explicit maintainer directive after the shipped implementation was independently re-verified; the Status field had read "Proposed" for roughly 8 weeks after the underlying decision had already landed.

**Evidence the decision shipped:**

- Primary, parity, and alias surfaces are present verbatim: `commands/gsd/progress.md:4,28` (`--next --converge`, `--cross-ai` alias, reviewer flags, `--max-cycles N`) and `commands/gsd/autonomous.md:4,40-41` (`--converge`, `--cross-ai` alias).
- The `plan_strategy=local|converge` seam is implemented in `gsd-core/workflows/next.md:260-313` (`PLAN_STRATEGY` parsing, `CONVERGENCE_ARGS` build, feature-gate check, Route-3 override) and mirrored in `gsd-core/workflows/autonomous.md:19-90,378-419`.
- Fail-fast-on-disabled-gate behavior matches the ADR's Failure Policy exactly: `next.md:279-292` and the equivalent block in `autonomous.md` check `workflow.plan_review_convergence` via `config-get` and abort with the exact `gsd config-set workflow.plan_review_convergence true` instruction — no silent downgrade to `local`.
- The config contract is shipped: `gsd-core/bin/shared/config-schema.manifest.json:36` (`workflow.plan_review_convergence`), `:54` (`review.default_reviewers`), `:123,141` (`review.models.*`); documented identically in `docs/CONFIGURATION.md:225,316` and `docs/COMMANDS.md:620-622,850-852`.
- Dedicated regression tests exist: `tests/adr-15-progress-converge.test.cjs` (179 lines, describe block titled `'ADR-15: /gsd:progress --next --auto --converge (#1190)'`) and `tests/autonomous-converge.test.cjs` (225 lines, covering the parity surface under `'autonomous --converge flag (#711)'` — this file does not itself reference ADR-15 by name).
- Landing commits: `092340d18` (`fix(#711): wire autonomous convergence flag`, 2026-06-10, parity surface) and `0b3a2e5f9` (`feat(#1190): wire --converge primary surface into /gsd:progress --next (ADR-15) (#1237)`, 2026-06-14) — the latter's commit body states "ADR-15 designates /gsd-progress --next --auto --converge as the PRIMARY plan-convergence surface" and confirms the wiring gap the ADR called out is closed.
- No later ADR references or supersedes ADR-15: `grep -rl 'ADR-15' docs/adr/*.md` returns only `docs/adr/README.md`'s own index row (line 158), which still lists it as "Proposed" — the stale bookkeeping entry this ratification corrects.

**Governance state:** Issue #15 CLOSED — stateReason COMPLETED (closed 2026-05-25T03:12:26Z). Follow-up test-coverage issue #1190 ("test(coverage): fill Proposed-ADR test gaps") also CLOSED — stateReason COMPLETED (closed 2026-06-14T19:52:24Z).

## Decision

Do not add a new command. Add convergence as an orchestration policy in existing commands, with `/gsd-progress` as the primary operator surface.

1. Add a shared **plan strategy seam** for orchestration workflows:
   - `plan_strategy=local|converge`
   - `local` maps to `gsd-plan-phase`
   - `converge` maps to `gsd-plan-review-convergence`
2. Expose the strategy via existing entry points:
   - `/gsd-progress --next --auto --converge` (primary)
   - `/gsd-autonomous --converge` (parity path for users who prefer autonomous directly)
   - keep `--cross-ai` as a compatibility alias for `--converge`
3. Reuse existing reviewer selection semantics from `/gsd-review` and `/gsd-plan-review-convergence`:
   - explicit reviewer flags (`--codex`, `--gemini`, `--claude`, `--opencode`, `--ollama`, `--lm-studio`, `--llama-cpp`)
   - `--all`
   - `review.default_reviewers` and `review.models.*` config
4. Add pass-through flags (no new command surface):
   - `--converge` (primary)
   - `--cross-ai` (alias)
   - reviewer selector flags listed above
   - `--max-cycles N` (forwarded per phase)
5. Keep convergence behind existing feature gate:
   - if `workflow.plan_review_convergence=false` and `--converge` (or alias) is requested, fail fast with actionable enable instructions.
6. Keep post-execution review behavior unchanged in this slice (`gsd-code-review` and `gsd-ui-review` stay as-is). Cross-AI code-review fanout is deferred.
7. Define convergence eligibility and allowed AIs via config (no new command):
   - enable gate: `workflow.plan_review_convergence=true`
   - allowed reviewer set: `review.default_reviewers` (for no-flag converge runs)
   - per-reviewer model selection: `review.models.*`

## Interface Contract

### Existing CLI Surfaces (No New Command)

- `/gsd-progress --next --auto [--converge|--cross-ai] [reviewer flags] [--max-cycles N]`
- `/gsd-autonomous [existing flags] [--converge|--cross-ai] [reviewer flags] [--max-cycles N]`

### Planning Step Routing

- `plan_strategy=local`:
  - orchestrator step uses `gsd-plan-phase` (current behavior).
- `plan_strategy=converge`:
  - orchestrator step uses `gsd-plan-review-convergence`.
  - convergence workflow remains owner of HIGH counting (`CYCLE_SUMMARY`), stall detection, and escalation.

### Failure Policy

- If `--converge` (or `--cross-ai`) is requested but convergence gate is disabled:
  - stop before planning dispatch
  - emit exact enable command:
    - `gsd config-set workflow.plan_review_convergence true`
- no silent downgrade to `local` strategy.

### Configuration Contract (Enable + Allowed AIs)

Convergence is configurable without introducing new config namespaces.

1. Enable convergence:
   - `workflow.plan_review_convergence: true`
2. Define which AIs are allowed by default for convergence runs:
   - `review.default_reviewers: ["codex", "gemini"]` (example)
3. Optionally pin models per allowed reviewer:
   - `review.models.codex`, `review.models.gemini`, etc.

Precedence for reviewer selection in converge mode:

1. Explicit CLI reviewer flags (`--codex`, `--gemini`, `--all`, etc.)
2. `review.default_reviewers`
3. If neither resolves to any reviewer, fail fast with actionable message.

Example config:

```json
{
  "workflow": {
    "plan_review_convergence": true
  },
  "review": {
    "default_reviewers": ["codex", "gemini"],
    "models": {
      "codex": "gpt-5.4",
      "gemini": "gemini-2.5-pro"
    }
  }
}
```

## Flag Naming

Issue #15 asks for a flag such as `--converge` or `--cross-ai` on autonomous execution. `--converge` is the better primary term because it names the behavior (plan-review convergence loop), not the transport (external AI) or mode label (`autonomous`).

1. Primary: `--converge`
2. Alias: `--cross-ai`
3. Avoid: introducing `--autonomous-*` variants (the command already defines that mode)

## Options Considered

1. **Autonomous-only flag (`/gsd-autonomous --cross-ai`)**
   - Files: `commands/gsd/autonomous.md`, `workflows/autonomous.md`
   - Problem: solves issue #15 directly but leaves `/gsd-progress --next --auto` inconsistent.
   - Benefit: smallest blast radius.
   - Drawback: two orchestration modes diverge in behavior.

2. **Progress-primary + autonomous parity (Chosen)**
   - Files: `commands/gsd/progress.md`, `workflows/progress.md`, `workflows/next.md`, plus autonomous wiring
   - Problem: must keep two orchestrators aligned.
   - Solution: one shared plan-strategy seam consumed by both commands.
   - Benefit: better locality; users who already drive from `progress --next --auto` get convergence without switching workflows.

3. **Config-only global toggle (no per-run flag)**
   - Files: config schema + both orchestrators
   - Benefit: minimal CLI syntax expansion.
   - Drawback: less control per run; harder to do targeted high-cost convergence only when needed.
   - Decision: defer; keep explicit runtime flag.

## Rubber-Duck Design Notes

Expected behavior: the two existing orchestration entry points should be able to opt into cross-AI plan convergence without adding another top-level command.

Actual behavior: both orchestration entry points always take the local planning route, so external reviewers are never reached unless the user abandons orchestration flow and runs convergence manually.

Wrong assumptions surfaced:
1. "Enabling `workflow.plan_review_convergence` changes orchestration behavior." It does not unless the convergence command is explicitly routed.
2. "Cross-AI config propagates automatically into autonomous/next flows." It only applies where convergence/review workflows are invoked.
3. "Adding a separate command is required." Existing orchestration commands are sufficient if they expose a strategy seam and clear flag naming.

Root architectural gap: orchestration flows lack a plan strategy seam (`local` vs `converge`).

## Scope

### In scope

- Plan strategy seam shared by existing orchestration commands.
- `--cross-ai` pass-through contract on existing commands.
- `--converge` primary flag naming and `--cross-ai` compatibility alias.
- Feature-gate behavior contract for convergence strategy.
- Config contract for enabling convergence and selecting allowed AIs.
- Documentation updates tied to command/config behavior.

### Out of scope

- New top-level command creation.
- Reworking `gsd-code-review` into cross-AI convergence loop.
- New reviewer config schema (reuse existing `review.*` keys).
- Changing default planning strategy without explicit opt-in.
- Altering `gsd-plan-review-convergence` internal loop semantics.

## Consequences

- No new command tax on docs, routing, and long-term maintenance.
- Existing orchestration habits (`progress --next --auto` and autonomous) can opt into convergence consistently.
- Existing review configuration gets leverage without new schema.
- Backward compatibility is preserved by default.
- Explicit failure on disabled gate avoids silent false-confidence automation.

## References

- Issue: #15
- `commands/gsd/progress.md`
- `gsd-core/workflows/progress.md`
- `gsd-core/workflows/next.md`
- `commands/gsd/autonomous.md`
- `gsd-core/workflows/autonomous.md`
- `commands/gsd/plan-review-convergence.md`
- `gsd-core/workflows/plan-review-convergence.md`
- `commands/gsd/review.md`
- `docs/COMMANDS.md` (`/gsd-plan-review-convergence`, `/gsd-review`)
- `docs/CONFIGURATION.md` (`workflow.plan_review_convergence`, `review.default_reviewers`, `review.models.*`)

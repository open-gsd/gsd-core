# Cross-AI Plan Convergence via Existing Orchestration Commands

- **Status:** Proposed
- **Date:** 2026-05-24
- **Issue:** #15

Current orchestration commands (`/gsd-autonomous` and `/gsd-progress --next --auto`) route planning through `gsd-plan-phase` and only use local/Claude subagent review paths. The cross-AI convergence path already exists (`/gsd-plan-review-convergence`, `/gsd-review`, `review.default_reviewers`, `review.models.*`) but is not wired into these orchestrators. This creates a gap: users can configure cross-AI reviewers yet still get local-only planning in autonomous/auto-chain execution.

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

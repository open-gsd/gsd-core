# Render agent definitions from templates at install/config-change time

**Source:** [#2758](https://github.com/open-gsd/gsd-core/issues/2758)
**Decision:** wontfix — closed on the technical merits
**Date:** 2026-05-02

## Proposal summary

Move config-gated prose out of `agents/*.md` into `agents/templates/*.md.tmpl`,
rendered at install time and after `.planning/config.json` writes via a new
`gsd-sdk agents render` subcommand. Conditional branches resolve at render time
(deterministic code) instead of at inference time (LLM interpretation).

Three named benefits:

1. Token reduction proportional to disabled features.
2. Deterministic feature gating (impossible-by-construction vs. test-for).
3. Single source of truth for contributor-facing gating.

Cites PR #2279 (Codex/OpenCode model embedding at install time) as direct
precedent for compile-time embedding.

## Why GSD does not own this

### 1. The determinism claim is theoretical, not observed

The proposal's strongest argument is that config-gated branches in agent prose
are a determinism failure surface. The actual patterns in the codebase today are
already heavily mitigated:

- The `use_worktrees` branch in `gsd-executor` is resolved deterministically via
  `gsd-sdk query config-get` in bash — it is not LLM-interpreted.
- "Skip if `workflow.X` is `false`" prose patterns are short, stable, and
  follow a uniform "missing key = enabled" convention. There is no documented
  history of LLMs running disabled checks or skipping enabled ones because of
  this prose.

A theoretical failure surface should not be traded for a real, high-risk
patch-migration surface (`gsd-local-patches/` rebase logic, by the reporter's own
admission "the highest-risk piece of the change"). The reporter was asked for
documented evidence; none was provided.

### 2. Token waste is small and bounded

The codebase has roughly 5 `workflow.*` toggle references in agent files and
~20 "Skip if" conditional-prose patterns total — most 1–2 sentences. The
"real spend across multi-phase milestones" claim was not measured against
`gsd-context-monitor` output despite being asked. Without a measured baseline,
the token-savings argument is asserted rather than demonstrated, and the savings
ceiling on ~20 short conditionals is small enough that it does not justify a new
template-and-rendering subsystem with a CI-enforced template/generated split.

### 3. The deterministic-gating need is already served

PR #2279 established orchestrator-time config embedding for the cases that
genuinely need deterministic resolution (model selection, reasoning effort,
worktree mode). That mechanism is the right layer for orchestration-time
decisions and can be extended toggle-by-toggle along the existing path without
introducing a parallel templating subsystem. The proposal's own "Alternative #1"
(continue the orchestrator-embedding pattern) was rejected on the grounds that
agent-internal conditionals belong in the agent layer, but the asks behind the
proposal — determinism, lower token cost — are equally satisfied by extending
PR #2279 incrementally without a second mechanism.

Adding a templating layer alongside orchestrator-embedding means two mechanisms
own the same problem. The proposal does not specify a partition rule, and the
reporter did not respond when asked for one.

### 4. Patch-migration risk is disproportionate to benefit

The `/gsd-reapply-patches` three-way-merge migration for `gsd-local-patches/`
is, in the proposal's own words, the highest-risk piece of the change. It exists
solely to absorb a contributor-workflow shift — the user-facing surface is
unchanged. Risk that flows entirely from internal restructuring, where the
benefit is unmeasured token savings and a theoretical determinism gain, is the
wrong trade.

The reduced-scope variant (Alternative #5: fresh installs only, defer the
migration) avoids that specific risk but still ships a parallel mechanism for
benefits that remain unmeasured and that PR #2279's path can absorb.

## Re-open criteria

This may be revisited if a contributor:

- Provides measured token deltas via `gsd-context-monitor` against a
  representative all-toggles-off config, and the delta is materially larger
  than what extending PR #2279's orchestrator-embedding path one toggle at a
  time would produce.
- Documents a real LLM misinterpretation of an existing toggle conditional
  (executor ignored `workflow.use_worktrees: false`, verifier ran when
  `workflow.verifier: false`, etc.) — not a projected failure mode.
- Proposes a clear partition rule between orchestrator-time embedding (PR #2279)
  and any new install-time templating layer, so the two mechanisms do not
  overlap.

## Related

- PR #2279 — Codex/OpenCode model embedding at install time (the established
  precedent for deterministic compile-time embedding into agent files)
- v1.37.0 release notes — shared-boilerplate extraction (reference files for
  mandatory-initial-read, project-skills-discovery)
- `gsd-core/workflows/` — workflow-level config embedding before subagent
  spawn (the path of least friction for incremental deterministic gating)

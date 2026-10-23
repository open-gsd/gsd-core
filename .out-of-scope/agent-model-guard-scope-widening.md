# Widening the agent model guard (gsd-debugger, spawn-site prose, mapper resolved tier)

**Source:** [#5525](https://github.com/open-gsd/gsd-core/issues/5525)
**Decision:** wontfix — closed as filed (bundled scope); individual pieces may return as separate issues
**Date:** 2026-10-19

## Proposal summary

Follow-up to the agent model guard of [#5328](https://github.com/open-gsd/gsd-core/issues/5328)
(PR [#5413](https://github.com/open-gsd/gsd-core/pull/5413)). One issue asked for three
changes after #5413 lands with its four guarded agents: (1) add `gsd-debugger` to the
guarded agent types; (2) add "copy the resolved value verbatim; never choose a model" prose
at the spawn sites (6 top-level workflows and 11 `steps/`/`detail/` files) and drop example
model names from `execute-phase.md`; (3) resolve a `MAPPER_MODEL` for the drift-gate
`gsd-codebase-mapper` spawn and pass `model=`, so the mapper stops inheriting the
orchestrator's model.

## Why GSD does not own this

- **It bundles unrelated concerns.** The guard list, a 17-file prompt-prose change and a
  mapper cost/behavior change are three different classifications and risk levels, and one
  PR per concern is the repo rule. The ask left the PR split to the maintainer.
- **The prose changes grow emitted prompts.** The issue itself notes the ADR-3942 byte
  budget has to be checked; 17 spawn sites is a large, recurring prompt cost for a
  defence-in-depth hint.
- **The mapper change alters cost and model for drift-gate runs** (inherit to resolved
  tier), and whether the mapper becomes a guarded agent was left as an open design question.
  It was never ruled on, so it is not a side effect to approve inside a guard issue.

## What this does NOT cover

Rejected as filed, not rejected in substance. Still welcome as their own issues: adding a
single agent such as `gsd-debugger` to the guarded list, and a mapper model-resolution
change proposed with its own cost analysis.

## Re-open criteria

File each piece separately, after #5413 is merged, with its own scope, byte-budget
measurement (for any prompt prose) and cost statement (for any model-tier change).

## Related

- [#5328](https://github.com/open-gsd/gsd-core/issues/5328), PR [#5413](https://github.com/open-gsd/gsd-core/pull/5413)
- [#5524](https://github.com/open-gsd/gsd-core/issues/5524) (approved sibling: per-model escalation record)

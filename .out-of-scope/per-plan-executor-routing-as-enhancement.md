# Per-plan executor model and effort routing (as an enhancement)

**Source:** [#5956](https://github.com/open-gsd/gsd-core/issues/5956)
**Decision:** wontfix — closed as filed in the enhancement lane; may return as a feature request
**Date:** 2026-11-07

## Proposal summary

Choose a (model, effort) pair for each executor spawn in `execute-phase`, from an ordered tier
list: explicit plan frontmatter (`executor_model:` / `executor_effort:`), gap-retry (a
`gap_closure` plan whose files overlap an earlier executed gap round, level capped at 2), gap,
fragile (a `files_modified` entry matches a configured glob), then the existing default. The
mechanism was a new `gsd-tools route-executor <plan_path>` verb, a new `executor_routing` config
at both user level (`tiers`) and project level (`tiers` override plus `fragile_paths`), a JSONL
decision log, and an `effort=` slot on the executor `Agent()` spawn.

## Why GSD does not own this

- **It is not an enhancement.** CONTRIBUTING.md defines an enhancement as one that "does not add
  new commands, new workflows, or new concepts". The proposal adds a new `gsd-tools` verb and a
  new user-level configuration layer, so it cannot be approved through the enhancement lane.
- **Project-wide executor routing already exists.** `models.execution` and
  `model_overrides["gsd-executor"]` set the executor model for a project
  (`docs/how-to/configure-model-profiles.md`; #2935 was closed as already implemented on this basis).
- What the proposal got right is not a ground for rejection: today one executor model is resolved
  per phase (`execute-phase.md` reads `executor_model` once), so a docs-only plan and a third
  gap-closure attempt do run on the same model and effort.

## What this does NOT cover

- A **feature request** for per-plan executor routing, filed through `feature_request.yml`, where a
  new verb and config concept get a feature review. That remains welcome.
- Per-plan `executor_model` / `executor_effort` frontmatter alone, proposed with its own scope.
- Changes to how `model_profile`, `models.<phase_type>` or `model_overrides` resolve.

## Re-open criteria

Filed as a feature request (or as a narrower enhancement that adds no verb and no new config layer),
with its own design for keying gap rounds on the planning run rather than the plan's creation commit.

## Related

- [#2935](https://github.com/open-gsd/gsd-core/issues/2935) (per-phase-type routing, already implemented)
- `docs/how-to/configure-model-profiles.md`

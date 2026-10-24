---
type: Fixed
pr: 5673
---
**Assumptions-mode and `--power` discuss now honour a phase `SPEC.md` like the default flow, and "the phase SPEC" has one definition** — both modes never read the SPEC, so `CONTEXT.md` could lock decisions that contradict it, and a phase with only a `UI-SPEC` was treated as having a requirements lock in the default flow. `init phase-op`, `init plan-phase` and `init discuss-phase-assumptions` now report `has_spec` / `spec_path` (a plain `NN-SPEC.md`, never `-AI-SPEC.md` or `-UI-SPEC.md`), the context-drift gate uses the same predicate, and all three discuss flows carry one `check_spec` step that limits gray areas to HOW and writes `<spec_lock>`. (#5629)

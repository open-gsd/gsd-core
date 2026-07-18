---
type: Added
pr: 0
---
**`gsd-debugger` now branches root-cause analysis instead of chaining, guarding against 5-Whys single-cause bias** — before committing `root_cause`, the debugger enumerates candidate causes across ≥2 Ishikawa categories (code / config / environment / data) rather than a single linear "why" chain, and explicitly answers an AND-gate question ("could this failure require more than one contributing condition simultaneously?"). When the AND-gate fires, every contributing cause is recorded — so a multi-cause fix no longer recurs via the unaddressed second cause. `Resolution.root_cause` may now hold one OR a small set of contributing causes (additive; single-cause sessions are byte-identical to today). The Structured Reasoning Checkpoint gains `candidate_causes` + `and_gate` fields, and `debugger-philosophy.md` adds the single-cause-bias trap to its cognitive-bias table. Full rules live in `gsd-core/references/debugger-rca-branching.md`. (#1960)

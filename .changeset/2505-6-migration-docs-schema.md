---
type: Added
pr: 2538
---
<!-- docs-exempt: Phase 6 is a documentation + schema-enum PR — the changeset IS the doc touch (docs/migration/kimi-to-kimi-code.md). -->
**New `docs/migration/kimi-to-kimi-code.md` migration guide + `built-in-only` subagent-toolkit enum value** — users who installed via `--kimi` but are actually on Kimi Code (Node CLI) now have a step-by-step migration path (re-install with `--kimi-code`, remove inert YAMLs, verify skills, verify agent-skills query). The `built-in-only` enum value replaces the `undocumented` sentinel on the kimi-code descriptor's `subagentToolkit` axis, making the descriptor self-documenting: Kimi Code's three built-in subagents (coder/explore/plan) are now a first-class negotiated value rather than an escape hatch. (#2512)

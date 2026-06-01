---
type: Added
pr: 576
---
**Vertical MVP Slice mode shipped** — `/gsd-plan-phase --mvp` organizes tasks as vertical feature slices (UI→API→DB) instead of horizontal layers; `--mvp --tdd` produces slices where every behavior-adding task starts with a failing test; `**Mode:** mvp` in ROADMAP.md auto-applies without the flag; `/gsd-mvp-phase <N>` guides story capture + SPIDR splitting + mode persistence; Walking Skeleton fires on Phase 1 of a new project; `verify-phase` generates user-flow-first UAT for MVP phases; `new-project` offers Vertical MVP vs Horizontal Layers mode choice. Also fixes a silent bug where `--tdd` on the CLI was a no-op (TDD_MODE was config-only; now the flag sets TDD_MODE directly).

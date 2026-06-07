# GSD Core documentation

Documentation is organised into four quadrants: **tutorials** help you learn by doing, **how-to guides** solve specific tasks, **reference** states authoritative facts, and **explanation** explores concepts and design decisions.

Language versions: [English](README.md) · [Português (pt-BR)](pt-BR/README.md) · [日本語](ja-JP/README.md) · [简体中文](zh-CN/README.md)

---

## Tutorials

- [Your first project](tutorials/your-first-project.md) — install to first shipped phase, one guaranteed path
- [Onboarding an existing codebase](tutorials/onboarding-an-existing-codebase.md) — bring GSD Core to a brownfield repo

---

## How-to guides

- [Install on your runtime](how-to/install-on-your-runtime.md) — runtime-specific install steps for all 15 supported runtimes
- [Discuss a phase](how-to/discuss-a-phase.md) — capture implementation decisions before planning begins
- [Plan a phase](how-to/plan-a-phase.md) — run research, decompose work, and verify plan quality
- [Execute a phase](how-to/execute-a-phase.md) — run plans in parallel waves with fresh-context subagents
- [Verify and ship](how-to/verify-and-ship.md) — walk through completed work, diagnose failures, and create the PR
- [Run phases autonomously](how-to/run-phases-autonomously.md) — use autonomous mode for unattended phase execution
- [Handle quick and fast tasks](how-to/handle-quick-and-fast-tasks.md) — use `/gsd-quick` and `/gsd-fast` for ad-hoc work outside the phase loop
- [Configure model profiles](how-to/configure-model-profiles.md) — switch between quality, balanced, and budget model tiers
- [Set up cross-AI review](how-to/set-up-cross-ai-review.md) — configure a second AI to review code produced by the primary agent
- [Work in parallel with workstreams](how-to/work-in-parallel-with-workstreams.md) — run independent lines of work simultaneously using workstreams
- [Isolate work with workspaces](how-to/isolate-work-with-workspaces.md) — use workspaces to sandbox experimental or risky changes
- [Debug a failed execution](how-to/debug-a-failed-execution.md) — diagnose and recover from broken or incomplete phase execution
- [Spike and sketch](how-to/spike-and-sketch.md) — use `/gsd-spike` and `/gsd-sketch` for exploratory work before committing to a plan
- [Design a UI phase](how-to/design-a-ui-phase.md) — use the UI phase loop for frontend and visual work
- [Drive GSD from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md) — start a phase from a GitHub, Linear, or Jira issue
- [Migrate from GSD 2](how-to/migrate-from-gsd-2.md) — upgrade an existing GSD 2 project to GSD Core
- [Update GSD](how-to/update-gsd.md) — re-run the installer to pick up the latest release
- [Clean up get-shit-done-cc](cleanup-get-shit-done-cc.md) — remove leftover old-package artifacts that cause a spurious `⬆ /gsd:update` indicator after migrating to `@opengsd/gsd-core`
- [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md) — resolve the branch-divergence condition that halts parallel phase execution
- [Recover and troubleshoot](how-to/recover-and-troubleshoot.md) — fix common problems, rebuild context, and uninstall

---

## Reference

- [Commands](COMMANDS.md) — every command with flags and examples
- [Configuration](CONFIGURATION.md) — full config schema, model profiles, git branching strategies
- [CLI tools](CLI-TOOLS.md) — `gsd-tools.cjs` programmatic API for workflows and agents
- [Features](FEATURES.md) — complete feature index
- [Inventory](INVENTORY.md) — installed skills and surface map
- [STATE.md schema](reference/state-md.md) — field-by-field reference for `.planning/STATE.md`
- [CONTEXT.md schema](reference/context-md.md) — field-by-field reference for `.planning/phases/<N>/CONTEXT.md`
- [PLAN.md schema](reference/plan-md.md) — field-by-field reference for `.planning/phases/<N>/PLAN.md`
- [Planning artifacts](reference/planning-artifacts.md) — all `.planning/` files and their roles

---

## Explanation

- [Context engineering](explanation/context-engineering.md) — how context rot forms and how GSD Core prevents it
- [The phase loop](explanation/the-phase-loop.md) — design rationale for the Discuss → Plan → Execute → Verify → Ship cycle
- [Multi-agent orchestration](explanation/multi-agent-orchestration.md) — how subagents are spawned, scoped, and coordinated
- [Security model](explanation/security-model.md) — trust boundaries, permissions, and safe automation
- [Architecture](ARCHITECTURE.md) — system architecture, agent model, and data flow
- [Discuss modes](workflow-discuss-mode.md) — assumptions mode vs interview mode for `/gsd-discuss-phase`
- [Context monitoring](context-monitor.md) — context window monitoring hook architecture
- [Issue-driven orchestration](issue-driven-orchestration.md) — recipe for driving GSD from a tracker issue using existing primitives

---

## Related

- [Root README](../README.md) — landing page, quickstart, and documentation overview
- [Changelog](../CHANGELOG.md) — release history

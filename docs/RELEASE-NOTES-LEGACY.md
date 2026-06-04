# Legacy Release Notes

> **Archived history — frozen.** These notes cover the project's first lifecycle under its earlier package names, **`get-shit-done-cc`** and later **`@opengsd/get-shit-done-redux`** (versions `1.0.0` → `1.42.x`, plus pre-release and canary builds up to `1.50.0-canary.1`). The project now ships as **`@opengsd/gsd-core`**, whose version numbering restarts at `1.0.0`. Current release notes live in [`CHANGELOG.md`](../CHANGELOG.md).
>
> Because the `@opengsd/gsd-core` line reuses low version numbers (`1.0.0`, `1.1.0`, `1.2.0`, …), the legacy `1.x` numbers below **will collide** with current ones. Always read a legacy version number as belonging to the retired `get-shit-done-cc` / `get-shit-done-redux` lineage.
>
> **Install commands have been removed.** The retired packages are no longer maintained; historical `npx @opengsd/get-shit-done-redux@…` instructions have been stripped so they cannot be copied by mistake. To install the current tool, see the project README.

## About this archive

This document is a condensed, read-only record of every release published before the project was renamed to `@opengsd/gsd-core`. It exists so that the old version history is preserved without its `1.x` numbers colliding with the current package's release notes.

It rolls up two previously separate sources: the per-version entries that lived in `CHANGELOG.md` under "Legacy Release History", and ten standalone `docs/RELEASE-v*.md` release-note files. Both sources have been removed in favour of this single archive.

Entries are organised newest-first and condensed to their key points. Dates are shown as originally recorded; where a standalone release note carried no date, the date column shows "—". One historical heading appears as **`1.2.0 legacy`** — it was renamed to avoid colliding with the current `@opengsd/gsd-core@1.2.0`.

---

## Version index

Stable and patch releases, newest first. Pre-release and canary builds are listed separately in [Pre-release & canary builds](#pre-release--canary-builds).

| Version | Date | Summary |
| --- | --- | --- |
| 1.42.3 | — | Codex CLI 0.130.0 routability fix and runtime-aware slash formatter |
| 1.42.1 | 2026-05-15 | Phase-dir naming and progress counter fixes |
| 1.41.0 | 2026-05-07 | Hierarchical skill routing, new commands, and extensive bug fixes |
| 1.39.1 | 2026-05-01 | Hotfix: agent-skills output, help accuracy, and Windows SDK shim |
| 1.38.5 | 2026-04-25 | SDK executor writes SUMMARY.md to correct phase directory |
| 1.38.4 | 2026-04-25 | SDK prompt fidelity, plan content, and verification accuracy restored |
| 1.38.2 | 2026-04-19 | SDK ships prebuilt; two new commands added |
| 1.37.1 | 2026-04-17 | UI-phase researcher loads sketch findings to avoid re-asking |
| 1.37.0 | 2026-04-17 | Spike, sketch, and spec commands; SDK Phase 2 caller migration |
| 1.36.0 | 2026-04-14 | SDK query layer Phases 1 & 2; graphify integration and broad fixes |
| 1.35.0 | 2026-04-10 | Cline, CodeBuddy, Qwen runtime support; statusline milestone display |
| 1.34.2 | 2026-04-06 | Node.js minimum restored to 22 |
| 1.34.1 | 2026-04-06 | Catchup publish; v1.33.0 and v1.34.0 now available |
| 1.34.0 | 2026-04-06 | Gates taxonomy, post-merge hunk verification, execution context profiles |
| 1.33.0 | 2026-04-05 | Queryable codebase intel system and typed contribution templates |
| 1.32.0 | 2026-04-04 | Four new runtimes, state commands, autonomous flags, and wide fixes |
| 1.31.0 | 2026-04-01 | Skills migration, docs-update, secure-phase, and worktree fixes |
| 1.30.0 | 2026-03-26 | Headless TypeScript SDK added for autonomous project execution |
| 1.29.0 | 2026-03-25 | Windsurf runtime, skill injection, and multi-language documentation added |
| 1.28.0 | 2026-03-22 | Workstream namespacing and multi-project workspace commands added |
| 1.27.0 | 2026-03-20 | Advisor mode, Cursor runtime, and centralized security hardening added |
| 1.26.0 | 2026-03-18 | Developer profiling pipeline, ship command, and verification debt tracking added |
| 1.25.0 | 2026-03-16 | Antigravity runtime support and new documentation suite added |
| 1.24.0 | 2026-03-15 | Quick research flag, persistent debug knowledge base, and programmatic profile setter added |
| 1.23.0 | 2026-03-15 | UI-phase workflow, stats dashboard, and Copilot CLI runtime added |
| 1.22.4 | 2026-03-03 | Discuss flag for quick mode and Windows temp file resolution fixed |
| 1.22.3 | 2026-03-03 | Cold-start smoke test injection and granularity setting rename |
| 1.22.2 | 2026-03-03 | Extensive state parsing, hook, and multi-runtime installer fixes |
| 1.22.1 | 2026-03-02 | Discuss phase loads prior context before identifying gray areas |
| 1.22.0 | 2026-02-27 | Codex multi-agent support and code-aware discuss phase added |
| 1.21.1 | 2026-02-27 | Test suite, CI pipeline, and cross-platform bug fixes |
| 1.21.0 | 2026-02-25 | YAML frontmatter sync, Codex runtime, and auto-advance improvements |
| 1.20.6 | 2025-02-23 | Context monitor, Nyquist validation, and installer modularization |
| 1.20.5 | 2026-02-19 | Health repair backup and subagent context loading improvements |
| 1.20.4 | 2026-02-17 | Executor now updates ROADMAP and REQUIREMENTS after each plan |
| 1.20.3 | 2026-02-16 | Milestone audit hardened with three-source cross-reference |
| 1.20.2 | 2026-02-16 | Requirements tracking chain and verifier cross-reference fixes |
| 1.20.1 | 2026-02-16 | Auto-mode survives context compaction via persisted config |
| 1.20.0 | 2026-02-15 | Health command, auto-advance chain, and quick-task full flag |
| 1.19.2 | 2026-02-15 | User-level defaults, per-agent model overrides, and phase fixes |
| 1.19.1 | 2026-02-15 | Auto-advance pipeline and deterministic roadmap progress counts |
| 1.19.0 | 2026-02-15 | Brave Search integration, issue templates, and routing fixes |
| 1.18.0 | 2026-02-08 | Auto flag for new-project and Windows hook fixes |
| 1.17.0 | 2026-02-08 | gsd-tools verification suite, frontmatter CRUD, and state progression |
| 1.16.0 | 2026-02-08 | Ten new gsd-tools CLI commands replacing manual AI orchestration |
| 1.15.0 | 2026-02-08 | Token reduction via optimized workflow context loading |
| 1.14.0 | 2026-02-08 | Context-optimizing parse commands and installer JSONC fix |
| 1.13.0 | 2026-02-08 | History digest, phases list, and structured gsd-tools commands |
| 1.12.1 | 2026-02-08 | Consolidated workflow initialization for reduced token usage |
| 1.12.0 | 2026-02-07 | Thin orchestrator pattern and centralized gsd-tools utility |
| 1.11.2 | 2026-02-05 | Security hardening and critical API key commit prevention |
| 1.11.1 | 2026-01-31 | Git branching strategy config and context compliance verification |
| 1.10.1 | 2025-01-30 | Gemini CLI agent loading error fix |
| 1.10.0 | 2026-01-29 | Native Gemini CLI support and context bar scaling fix |
| 1.9.12 | 2025-01-23 | Removed whats-new command, restored auto-release workflow |
| 1.9.11 | 2026-01-23 | Switched to manual npm publish, fixed Discord badge |
| 1.9.10 | 2026-01-23 | Discord community link added to installer completion |
| 1.9.9 | 2026-01-23 | Added join-discord command for community access |
| 1.9.8 | 2025-01-22 | Uninstall flag and context file detection fix |
| 1.9.7 | 2026-01-22 | OpenCode XDG config path and command structure fixes |
| 1.9.6 | 2026-01-22 | Interactive runtime selection and native OpenCode support |
| 1.9.5 | 2025-01-22 | MCP tool access fix and installer cancellation handling |
| 1.9.4 | 2026-01-21 | Checkpoint automation enforces automation-first principle |
| 1.9.2 | 2025-01-21 | Removed overengineered Codebase Intelligence System |
| 1.9.0 | 2025-01-20 | Model profiles and workflow settings command added |
| 1.8.0 | 2026-01-19 | Uncommitted planning mode via config flag |
| 1.7.1 | 2026-01-19 | Fix quick task file naming to use numbered prefix |
| 1.7.0 | 2026-01-19 | Quick Mode for small ad-hoc tasks without optional agents |
| 1.6.4 | 2026-01-17 | Fix WSL2 install, file verification, and orphaned hook cleanup |
| 1.6.3 | 2025-01-17 | Add --gaps-only flag for execute-phase gap closure |
| 1.6.2 | 2025-01-17 | README restructured around clearer six-step workflow |
| 1.6.1 | 2025-01-17 | Installer clean install and update confirmation flow |
| 1.6.0 | 2026-01-17 | Unify new-milestone flow; remove four discrete commands |
| 1.5.30 | 2026-01-17 | Fix output template markdown and next-step routing |
| 1.5.29 | 2025-01-16 | Domain-aware discuss-phase; fix Windows hooks and notifications |
| 1.5.28 | 2026-01-16 | Consolidate milestone workflow; remove execute-plan command |
| 1.5.27 | 2026-01-16 | Fix uncommitted orchestrator corrections between executor waves |
| 1.5.26 | 2026-01-16 | Fix revised plans left uncommitted after checker feedback |
| 1.5.25 | 2026-01-16 | Fix stop-hook stale state and researcher CONTEXT.md loading |
| 1.5.24 | 2026-01-16 | Fix stop-hook STATE.md parsing and planner file loading |
| 1.5.23 | 2025-01-16 | Add cross-platform completion notification; fix phase naming |
| 1.5.22 | 2025-01-16 | Add statusline update indicator; fix planner ROADMAP.md update |
| 1.5.21 | 2026-01-16 | Unified new-project flow with brand system and research synthesizer |
| 1.5.20 | 2026-01-16 | Remove premature research-skip logic from roadmap/planner |
| 1.5.19 | 2026-01-16 | Redesign discuss-phase with intelligent gray area analysis |
| 1.5.18 | 2026-01-16 | Add plan verification loop with planner, checker, and revise cycle |
| 1.5.17 | 2026-01-15 | Add /gsd:update command for in-place version management |
| 1.5.16 | 2026-01-15 | Add researcher, debugger, and codebase-mapper specialist agents |
| 1.5.15 | 2025-01-15 | Fix missing agents/ folder in npm package |
| 1.5.14 | 2025-01-15 | Fix plan-phase routing to execute-phase for single-plan phases |
| 1.5.13 | 2026-01-15 | Fix new-milestone to present research and requirements equally |
| 1.5.12 | 2025-01-15 | Rework milestone cycle for proper requirements flow |
| 1.5.11 | 2025-01-15 | Verifier reuses previous must-haves on re-verification |
| 1.5.10 | 2025-01-15 | Milestone audit reads existing VERIFICATION.md files |
| 1.5.9 | 2025-01-15 | Add milestone audit system with parallel verification agents |
| 1.5.8 | 2025-01-15 | Add verification loop with automatic gap-fix execution |
| 1.5.7 | 2025-01-15 | Add gsd-executor and gsd-verifier goal-backward subagents |
| 1.5.6 | 2025-01-15 | Separate README flow steps; fix phase metadata commit bundling |
| 1.5.5 | 2025-01-15 | Reorganize README commands into seven grouped tables |
| 1.5.4 | 2025-01-15 | Research phase loads REQUIREMENTS.md for focused research |
| 1.5.3 | 2025-01-15 | Add execute-phase narration; offer two new-project paths |
| 1.5.2 | 2026-01-15 | Add requirements traceability with REQ-ID to phase mapping |
| 1.5.1 | 2026-01-14 | Research agents write output files directly instead of returning |
| 1.5.0 | 2026-01-14 | Add research-project and define-requirements pre-roadmap commands |
| 1.4.29 | 2026-01-14 | Deleted obsolete archive and status commands |
| 1.4.28 | 2026-01-14 | Restored checkpoint docs; fixed execute-plan continuation pattern |
| 1.4.27 | 2025-01-14 | Restored next-step routing after plan/phase execution |
| 1.4.26 | 2026-01-14 | Backfilled full changelog history from git |
| 1.4.25 | 2026-01-14 | Added whats-new command and VERSION tracking |
| 1.4.24 | 2026-01-14 | Added USER-SETUP.md; removed ISSUES.md system (breaking) |
| 1.4.23 | 2026-01-14 | Removed dead ISSUES.md system code |
| 1.4.22 | 2026-01-14 | Added subagent isolation for debug; fixed DEBUG_DIR constant |
| 1.4.21 | 2026-01-14 | Fixed SlashCommand tool missing from plan-fix allowed-tools |
| 1.4.20 | 2026-01-14 | Fixed debug file naming and execute-plan invocation |
| 1.4.19 | 2026-01-14 | Auto-diagnose issues instead of prompting choice in plan-fix |
| 1.4.18 | 2026-01-14 | Added parallel diagnosis before plan-fix execution |
| 1.4.17 | 2026-01-14 | Redesigned verify-work as conversational UAT with persistent state |
| 1.4.16 | 2026-01-13 | Added pre-execution summary and pre-computed wave numbers |
| 1.4.15 | 2026-01-13 | Added context rot explanation to README header |
| 1.4.14 | 2026-01-13 | YOLO mode now recommended default in new-project |
| 1.4.13 | 2026-01-13 | Fixed brownfield docs; removed deprecated resume-task references |
| 1.4.12 | 2026-01-13 | execute-phase promoted as primary execution command |
| 1.4.11 | 2026-01-13 | Checkpoints now use fresh continuation agents instead of resume |
| 1.4.10 | 2026-01-13 | execute-plan converted to orchestrator pattern for performance |
| 1.4.9 | 2026-01-13 | Removed subagent-only context; fixed discuss-phase scope question |
| 1.4.8 | 2026-01-13 | Restored TDD reasoning explanation to plan-phase docs |
| 1.4.7 | 2026-01-13 | Added project state loading; parallel execution marked recommended |
| 1.4.6 | 2026-01-13 | Added checkpoint pause/resume and deviation rules to execute-phase |
| 1.4.5 | 2026-01-13 | Added parallel-first planning, checkpoint-resume, and rules directory |
| 1.4.4 | 2026-01-13 | Fixed inline listing for multiple active debug sessions |
| 1.4.3 | 2026-01-13 | Added /gsd:debug command for systematic persistent debugging |
| 1.4.2 | 2026-01-13 | Fixed installation verification step clarification |
| 1.4.1 | 2026-01-13 | Added parallel phase execution, status command, and wave-based planning |
| 1.4.0 | 2026-01-12 | Full parallel phase execution system with dependency scheduling |
| 1.3.34 | 2026-01-11 | Added /gsd:add-todo and /gsd:check-todos for mid-session capture |
| 1.3.33 | 2026-01-11 | Fixed zero-padding for decimal phase numbers; removed .claude-plugin |
| 1.3.32 | 2026-01-10 | Added /gsd:resume-task for resuming interrupted subagent executions |
| 1.3.31 | 2026-01-08 | Added planning principles for security, performance, observability |
| 1.3.30 | 2026-01-08 | verify-work option surfaces after plan execution |
| 1.3.29 | 2026-01-08 | Added /gsd:verify-work, /gsd:plan-fix, and UAT issues template |
| 1.3.28 | 2026-01-07 | Added --config-dir argument and /gsd:remove-phase command |
| 1.3.27 | 2026-01-07 | Added permissions docs; enforced verification before completion routing |
| 1.3.26 | 2026-01-06 | Added marketplace plugin support; fixed phase artifact commits |
| 1.3.25 | 2026-01-06 | Fixed milestone discussion context persisting across /clear |
| 1.3.24 | 2026-01-06 | Added CLAUDE_CONFIG_DIR environment variable support |
| 1.3.23 | 2026-01-06 | Added non-interactive install flags for Docker/CI |
| 1.3.22 | 2026-01-05 | Removed unused auto.md command |
| 1.3.21 | 2026-01-05 | TDD features now use dedicated plans for full context quality |
| 1.3.20 | 2026-01-05 | Added per-task atomic commits for better AI observability |
| 1.3.19 | 2026-01-05 | Clarified create-milestone.md file locations with explicit instructions |
| 1.3.18 | 2026-01-05 | Added YAML frontmatter schema with dependency graph metadata |
| 1.3.17 | 2026-01-04 | Clarified depth controls compression not inflation in planning |
| 1.3.16 | 2026-01-04 | Added depth parameter for planning thoroughness (--depth=1-5) |
| 1.3.15 | 2026-01-01 | Fixed TDD reference loaded directly in commands |
| 1.3.14 | 2025-12-31 | Added TDD integration with detection, annotation, and execution flow |
| 1.3.13 | 2025-12-29 | Restored deterministic bash commands; removed redundant decision_gate |
| 1.3.12 | 2025-12-29 | Restored plan-format.md as output template |
| 1.3.11 | 2025-12-29 | 70% context reduction across plan-phase workflow files |
| 1.3.10 | 2025-12-29 | Fixed explicit plan count check in offer_next step |
| 1.3.9 | 2025-12-27 | Added evolutionary PROJECT.md system with incremental updates |
| 1.3.8 | 2025-12-18 | Added brownfield/existing projects section in README |
| 1.3.7 | 2025-12-18 | Fixed incremental codebase map updates |
| 1.3.6 | 2025-12-18 | Added file paths to codebase mapping output |
| 1.3.5 | 2025-12-17 | Removed arbitrary 100-line limit from codebase mapping |
| 1.3.4 | 2025-12-17 | Fixed inline code for Next Up commands |
| 1.3.3 | 2025-12-17 | Fixed existing project detection to check PROJECT.md |
| 1.3.2 | 2025-12-17 | Added git commit step to map-codebase workflow |
| 1.3.1 | 2025-12-17 | Added /gsd:map-codebase documentation in help and README |
| 1.3.0 | 2025-12-17 | Added /gsd:map-codebase command for brownfield project analysis |
| 1.2.13 | 2025-12-17 | Improved continuation UI with context and visual hierarchy |
| 1.2.12 | 2025-12-17 | Fix first question to use freeform input |
| 1.2.11 | 2025-12-17 | Fix permission errors for non-DSP users |
| 1.2.10 | 2025-12-16 | Replace inline command invocation with clear-then-paste pattern |
| 1.2.9 | 2025-12-16 | Fix git init to run in current directory |
| 1.2.8 | 2025-12-16 | Derive phase count from work scope |
| 1.2.7 | 2025-12-16 | Mandate AskUserQuestion for all exploration questions |
| 1.2.6 | 2025-12-16 | Internal refactoring |
| 1.2.5 | 2025-12-16 | Add if-mode tags for yolo/interactive branching |
| 1.2.4 | 2025-12-16 | Update stale CONTEXT.md references to new vision structure |
| 1.2.3 | 2025-12-16 | Remove enterprise language from help and discuss-milestone |
| 1.2.2 | 2025-12-16 | Fix new-project completion presented inline |
| 1.2.1 | 2025-12-16 | Restore AskUserQuestion for decision gate in questioning flow |
| 1.2.0 legacy | 2025-12-15 | Implement research workflow as Claude Code context injection |
| 1.1.2 | 2025-12-15 | Fix YOLO mode to skip confirmation gates in plan-phase |
| 1.1.1 | 2025-12-15 | Add README documentation for research workflow |
| 1.1.0 | 2025-12-15 | Add pre-roadmap research workflow and new commands |
| 1.0.11 | 2025-12-15 | Add research-phase command for niche domain discovery |
| 1.0.10 | 2025-12-15 | Fix scope creep prevention in discuss-phase |
| 1.0.9 | 2025-12-15 | Add phase CONTEXT.md loading in plan-phase |
| 1.0.8 | 2025-12-15 | Include PLAN.md in phase completion commits |
| 1.0.7 | 2025-12-15 | Add path replacement for local installs |
| 1.0.6 | 2025-12-15 | Internal improvements |
| 1.0.5 | 2025-12-15 | Add global/local install prompt; fix bin path and .DS_Store |
| 1.0.4 | 2025-12-15 | Fix bin name and remove circular dependency |
| 1.0.3 | 2025-12-15 | Add TDD guidance in planning workflow |
| 1.0.2 | 2025-12-15 | Add issue triage system to prevent deferred pile-up |
| 1.0.1 | 2025-12-15 | Initial npm package release |
| 1.0.0 | 2025-12-14 | Initial release of GSD Core meta-prompting system |

---

## Release history

Stable and patch releases, newest first.

### 1.42.3 — —
- Codex CLI 0.130.0 compatibility restored: installer writes `~/.codex/skills/gsd-<name>/SKILL.md` for every command; the previous build left zero routable entrypoints.
- `runtime-slash.cjs` introduced: emits `/gsd-<cmd>` for skills-based runtimes and `$gsd-<cmd>` for Codex; the deprecated colon form is no longer emitted at runtime.
- `check.ship-ready` git and gh probes now use `execFileSync` with argv arrays, closing a shell-injection class through malicious branch names.
- `init.plan-phase` surfaces `phase_status`; plan-phase short-circuits on `Complete` status to prevent accidental re-planning over shipped code.
- W006/W007 health warnings skip archived and future phases; executor agents are forbidden from `git stash` to preserve worktree isolation.

### 1.42.1 — 2026-05-15
- **Fixed:** `/gsd-discuss-phase` and `/gsd-plan-phase` first-touch creation now apply `project_code` prefix consistently, eliminating two-headed phase directory naming. (#3287)
- **Fixed:** `buildStateFrontmatter` counts nested `plans/` files, preventing progress counters from being silently overwritten downward on every state mutation. (#3261)

### 1.41.0 — 2026-05-07
- **Fixed:** Atomic writes in `scripts/build-hooks.js` eliminate a race condition that caused installed shell hooks to be observed empty, blocking release CI. (#3190)
- **Fixed:** Homebrew Cellar node paths normalized to stable symlinks, preventing `dyld: Library not loaded` errors after `brew upgrade node`. (#3181)
- **Added:** Six namespace meta-skills with two-stage hierarchical routing cut cold-start system-prompt token overhead from ~2,150 to ~120. (#2792)
- **Added:** `--minimal` install flag writes only core skills, reducing cold-start overhead to ~700 tokens for constrained-context deployments. (#2762)

### 1.39.1 — 2026-05-01
- **Fixed:** `gsd-sdk query agent-skills` emits the raw `<agent_skills>` block instead of a JSON-quoted string, restoring subagent skill injection. (#2917)
- **Fixed:** `help.md` updated to reflect eight slash commands removed in the #2824 consolidation; unknown-command errors eliminated. (#2954)
- **Fixed:** `--sdk` install on Windows writes callable `gsd-sdk.cmd`, `.ps1`, and Bash shim triples so the binary resolves across all shells. (#2962)

### 1.38.5 — 2026-04-25
- **Fixed:** SDK executor agents write `SUMMARY.md` to `.planning/phases/{phase}/` instead of the project root.

### 1.38.4 — 2026-04-25
- **Fixed:** SDK loads complete installed agent definitions at runtime instead of stripped-down bundled copies (~17% of real content).
- **Fixed:** SDK executor receives actual plan content; verification reads `VERIFICATION.md` status rather than trusting session exit code alone.
- **Removed:** 13 drifted bundled SDK prompt files deleted; SDK now loads installed agents directly.
- **Added:** `/gsd-map-codebase` (arch focus) produces a richer `ARCHITECTURE.md` with ASCII diagrams, component tables, and data-flow traces. (#2500)

### 1.38.2 — 2026-04-19
- **Fixed:** SDK decoupled from build-from-source install; ships as prebuilt `sdk/dist/` inside the parent tarball, eliminating PATH and exec-bit issues. (#2441, #2453)
- **Added:** `/gsd-ingest-docs` command bootstraps or merges a full `.planning/` setup from mixed ADRs, PRDs, SPECs, and DOCs in a single pass. (#2387)
- **Fixed:** `gsd-read-injection-scanner` hook included in the build allowlist and ships to users; was silently omitted since 1.37.0. (#2406)

### 1.37.1 — 2026-04-17
- **Fixed:** UI-phase researcher loads sketch findings skills, preventing repeated questions already answered during `/gsd-sketch`.

### 1.37.0 — 2026-04-17
- **Added:** `/gsd-spike` and `/gsd-sketch` first-class commands for feasibility spiking and UI design sketching with full GSD planning integration.
- **Added:** `/gsd-spec-phase` Socratic spec refinement with ambiguity scoring; produces a SPEC.md with falsifiable requirements before planning begins. (#2213)
- **Added:** `gsd-read-injection-scanner` PostToolUse hook scans for prompt injection in read file contents. (#2201)
- **Fixed:** Shell hooks falsely flagged as stale on every session; version headers now installed and detected in bash comment syntax. (#2136)

### 1.36.0 — 2026-04-14
- **Added:** `@opengsd/gsd-sdk` query layer Phases 1 & 2 — `gsd-sdk query` replaces raw `gsd-tools.cjs` calls with a supported, registry-backed CLI. (#2118, #2122)
- **Added:** `/gsd-graphify` knowledge graph integration for richer context connections between planning artifacts. (#2164)
- **Fixed:** Init ignores archived phases from prior milestones that share a phase number. (#2186)
- **Fixed:** Codex install hardened: strict TOML validation, atomic writes, legacy hook format auto-migration, and `~/.claude/` path elimination. (#2760, #2637)

### 1.35.0 — 2026-04-10
- **Added:** Cline, CodeBuddy, and Qwen Code runtime support via rules-based and skills-based install paths. (#1605)
- **Added:** `/gsd-from-gsd2` reverse migration from GSD-2 `.gsd/` format back to v1 `.planning/` format with `--dry-run` and `--force` flags.
- **Added:** Statusline surfaces GSD milestone, phase, and status when no active todo is present. (#628)
- **Fixed:** `normalizePhaseName` preserves letter suffix case (e.g., `1a`, `2B`). (#1963)

### 1.34.2 — 2026-04-06
- **Changed:** `engines.node` minimum restored to `>=22.0.0`; Node 22 Active LTS support preserved and CI matrix covers both Node 22 and 24.

### 1.34.1 — 2026-04-06
- **Fixed:** Catchup publish — v1.33.0 and v1.34.0 were tagged but never published to npm; all changes now available via the registry.

### 1.34.0 — 2026-04-06
- **Added:** Gates taxonomy reference — four canonical gate types (pre-flight, revision, escalation, abort) wired into plan-checker and verifier agents. (#1781)
- **Added:** Post-merge hunk verification in `reapply-patches` detects silently dropped hunks after three-way merge. (#1775)
- **Fixed:** Shell hooks (`hooks/*.sh`) included in npm tarball; were previously excluded by an overly narrow allowlist. (#1852, #1862)

### 1.33.0 — 2026-04-05
- **Added:** Queryable codebase intelligence system — persistent `.planning/intel/` store with structured JSON; query via `gsd-tools intel` subcommands. (#1688)
- **Added:** Typed contribution templates — separate Bug, Enhancement, and Feature issue/PR templates with approval gates. (#1673)
- **Fixed:** `MODEL_ALIAS_MAP` updated to current Claude model IDs (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`). (#1691)
- **Fixed:** Cross-platform planning lock replaces shell `sleep` with `Atomics.wait` for Windows compatibility. (#1693)

### 1.32.0 — 2026-04-04
- **Added:** Trae, Kilo, Augment, and Cline runtime support; `state validate`, `state sync`, and `state planned-phase` commands. (#1566, #1627)
- **Added:** `--to N` flag for autonomous mode, `--power` flag for discuss-phase, `/gsd-analyze-dependencies`, and research gate blocking planning on unresolved questions. (#1644, #1513, #1607, #1618)
- **Fixed:** Phase resolution prefix collision — `find-phase` uses exact token matching; `1009` no longer matches `1009A`. (#1635)
- **Fixed:** Parallel worktree STATE.md overwrites resolved; orchestrator exclusively owns STATE.md and ROADMAP.md writes. (#1599)

### 1.31.0 — 2026-04-01
- **Added:** Claude Code 2.1.88+ skills migration — commands install as `skills/gsd-*/SKILL.md`; legacy directory auto-cleaned on install.
- **Added:** `/gsd:docs-update`, `/gsd:secure-phase`, `--chain` flag for discuss-phase, and `--only N` flag for autonomous mode.
- **Fixed:** Infinite self-discuss loop in auto/headless mode fixed via `max_discuss_passes` config; three-way merge never-skip invariant enforced for reapply-patches.
- **Fixed:** ROADMAP.md Plans column, decimal phase commit regex, and verifier human-needed status all corrected.

### 1.30.0 — 2026-03-26
- **Added:** Headless TypeScript SDK (`gsd-sdk`) with `init` and `auto` CLI commands for autonomous project execution.
- **Added:** Optional SDK installation via `--sdk` flag during setup.

### 1.29.0 — 2026-03-25
- **Added:** Windsurf runtime support, agent skill injection via `agent_skills` config, and security scanning CI workflows.
- **Added:** Portuguese, Korean, and Japanese documentation.
- **Fixed:** Numerous parser, hook, config, and Windows robustness issues across multiple subsystems.

### 1.28.0 — 2026-03-22
- **Added:** Workstream namespacing for parallel milestone work, multi-project workspace commands, and `/gsd:forensics` post-mortem workflow.
- **Added:** Temp file reaper, `--reviews` flag for plan-phase, and text mode support.
- **Fixed:** Windows 8.3 path failures, worktree isolation, path traversal prevention, and pipe truncation.

### 1.27.0 — 2026-03-20
- **Added:** Advisor mode for discuss-phase, Cursor CLI runtime support, and seven new slash commands including `/gsd:fast`, `/gsd:review`, and `/gsd:pr-branch`.
- **Added:** Centralized `security.cjs` module with path traversal prevention, prompt injection detection, and safe JSON parsing.
- **Fixed:** Path traversal in `readTextArgOrFile`, Codex config corruption, STATE.md parsing regressions, and Windows HOME sandboxing.

### 1.26.0 — 2026-03-18
- **Added:** Developer profiling pipeline via `/gsd:profile-user` generating `USER-PROFILE.md` and `CLAUDE.md` profile sections.
- **Added:** `/gsd:ship` for PR creation from verified phase work, `/gsd:next` for automatic workflow advancement, and structured session handoff via `HANDOFF.json`.
- **Added:** Verification debt tracking with cross-phase health checks, `status: partial`, `result: blocked`, and persistent `HUMAN-UAT.md` files.
- **Fixed:** Phantom `/gsd:transition` command replaced, PROJECT.md drift corrected, and hook lifecycle issues resolved.

### 1.25.0 — 2026-03-16
- **Added:** Antigravity AI runtime support, `/gsd:do` natural language router, and `/gsd:note` for zero-friction idea capture.
- **Added:** New `docs/` directory with feature, architecture, agent, command, CLI, and configuration guides.
- **Fixed:** Antigravity `processAttribution` missing from skill copy, health check CWD guard, and stats command reporting.

### 1.24.0 — 2026-03-15
- **Added:** `--research` flag for `/gsd:quick`, `inherit` model profile for OpenCode, and persistent debug knowledge base appended to `.planning/debug/knowledge-base.md`.
- **Fixed:** ROADMAP searches scoped to current milestone, OpenCode agent frontmatter conversion, Windows installer EPERM crash, and absolute paths in `gsd-tools.cjs`.

### 1.23.0 — 2026-03-15
- **Added:** `/gsd:ui-phase` and `/gsd:ui-review` for UI design contracts and visual audits; `/gsd:stats` project statistics dashboard; Copilot CLI runtime support.
- **Added:** Node repair operator for autonomous recovery on task verification failure, configurable via `workflow.node_repair_budget`.
- **Fixed:** Auto-advance no longer triggers without `--auto`, decimal phase number padding, and WSL/Windows Node.js mismatch detection.

### 1.22.4 — 2026-03-03
- **Added:** `--discuss` flag for `/gsd:quick` to gather context before quick tasks.
- **Fixed:** Windows `@file:` protocol resolution for large init payloads exceeding 50 KB.

### 1.22.3 — 2026-03-03
- **Added:** Verify-work auto-injects a cold-start smoke test for phases modifying server, database, or startup files.
- **Changed:** `depth` setting renamed to `granularity` with `coarse`/`standard`/`fine` values; existing config auto-migrated.
- **Fixed:** Installer replaces `$HOME/.claude/` paths correctly for non-Claude runtimes.

### 1.22.2 — 2026-03-03
- **Fixed:** Codex installer no longer duplicates `[features]` and `[agents]` sections on re-install.
- **Fixed:** State parsing, hook lifecycle, phase counting, multi-runtime config detection, and regex escaping corrected across numerous subsystems.
- **Changed:** Anti-heredoc instruction extended to all file-writing agents; agent definitions include skills frontmatter.

### 1.22.1 — 2026-03-02
- **Added:** Discuss phase loads PROJECT.md, REQUIREMENTS.md, STATE.md, and prior CONTEXT.md files before identifying gray areas.
- **Fixed:** Shell snippets use `printf` instead of `echo` to prevent jq parse errors with special characters.

### 1.22.0 — 2026-02-27
- **Added:** Codex multi-agent support with `request_user_input` mapping and agent role generation.
- **Added:** Code-aware discuss phase — `/gsd:discuss-phase` scouts relevant source files before asking questions.
- **Fixed:** Update checker cache clearing, statusline migration regex, subagent path expansion, and config loading for `model_overrides` and `nyquist_validation`.

### 1.21.1 — 2026-02-27
- **Testing:** 428 tests across 13 files; 9-matrix CI (3 OS × 3 Node); cross-platform test runner added.
- **Fixed:** `getMilestoneInfo()` wrong version when shipped milestones collapsed in `<details>` blocks.
- **Fixed:** Milestone stats scoped to current milestone only; MILESTONES.md inserts newest-first.
- **Fixed:** Cross-platform path separators, Windows JSON quoting, and model override resolution.

### 1.21.0 — 2026-02-25
- **Added:** YAML frontmatter sync to STATE.md; `/gsd:add-tests` command; Codex runtime support.
- **Changed:** Installer suggests `/gsd:new-project`; requirements propagate `phase_req_ids` to agents.
- **Fixed:** Multi-level decimal phase regex, progress bar RangeError, STATE.md decision corruption.

### 1.20.6 — 2025-02-23
- **Added:** Context window monitor with WARNING/CRITICAL alerts; Nyquist validation in plan-phase pipeline.
- **Changed:** Installer refactored into 11 domain modules.
- **Fixed:** Auto-advance chain, Gemini CLI TOML conversion, universal phase number parsing.

### 1.20.5 — 2026-02-19
- **Fixed:** `/gsd:health --repair` creates a timestamped backup before regenerating STATE.md.
- **Changed:** Subagents discover and load project CLAUDE.md and skills at spawn time.

### 1.20.4 — 2026-02-17
- **Fixed:** Executor agents update ROADMAP.md and REQUIREMENTS.md after each plan completes.
- **Added:** `requirements mark-complete` CLI command for per-plan requirement tracking.

### 1.20.3 — 2026-02-16
- **Fixed:** Milestone audit cross-references three independent sources instead of single-source checks.
- **Fixed:** Orphaned requirements forced to `unsatisfied`; `complete-milestone` gates on requirements completion.
- **Fixed:** `plan-milestone-gaps` updates REQUIREMENTS.md traceability table and includes it in commit.

### 1.20.2 — 2026-02-16
- **Fixed:** Requirements tracking strips bracket syntax; verifier cross-references PLAN frontmatter requirement IDs.
- **Changed:** All requirements references enforce MUST/REQUIRED/CRITICAL language; plan checker now fails (blocking) on missing requirements.

### 1.20.1 — 2026-02-16
- **Fixed:** Auto-mode survives context compaction by persisting `workflow.auto_advance` to config.json on disk.
- **Fixed:** Checkpoints no longer block auto-mode; plan-phase passes `--auto` to execute-phase.

### 1.20.0 — 2026-02-15
- **Added:** `/gsd:health` command with `--repair` flag; `--full` flag for `/gsd:quick`; `--auto` flag wired through full phase chain.
- **Fixed:** Plans created without user context now warn; OpenCode subagent type conversion; phase directories tracked via `.gitkeep`.

### 1.19.2 — 2026-02-15
- **Added:** User-level defaults via `~/.gsd/defaults.json`; per-agent model overrides.
- **Fixed:** OpenCode local installs write to `./.opencode/`; large JSON payloads write to temp files; executor scope boundary and attempt limit added.

### 1.19.1 — 2026-02-15
- **Added:** Auto-advance pipeline — `--auto` flag chains discuss → plan → execute without stopping.
- **Fixed:** Phase transition routes to `discuss-phase` when no CONTEXT.md exists; ROADMAP progress counts computed from disk deterministically.

### 1.19.0 — 2026-02-15
- **Added:** Brave Search integration for researchers; GitHub issue templates and security policy.
- **Fixed:** UAT gaps auto-resolve after gap-closure execution; ROADMAP fallback when phase directory missing; `{phase_num}` replaces ambiguous `{phase}`.

### 1.18.0 — 2026-02-08
- **Added:** `--auto` flag for `/gsd:new-project` runs research → requirements → roadmap automatically.
- **Fixed:** Windows SessionStart hook spawns detached process; research decision persists to config.json.

### 1.17.0 — 2026-02-08
- **Added:** gsd-tools verification suite (6 verify commands), frontmatter CRUD, template fill, and state progression commands.
- **Added:** Local patch preservation — installer backs up modified GSD files to `gsd-local-patches/`; `/gsd:reapply-patches` command added.
- **Changed:** Agents use gsd-tools for state updates and verification instead of manual markdown parsing.

### 1.16.0 — 2026-02-08
- **Added:** 10 new gsd-tools CLI commands covering phase add/insert/remove/complete, roadmap analyze, milestone complete, validate, progress, todo complete, and scaffold.
- **Changed:** Workflows delegate deterministic operations to gsd-tools, reducing token usage; execute-phase spawns `gsd-executor` subagents correctly.

### 1.15.0 — 2026-02-08
- **Changed:** Optimized workflow context loading eliminates redundant file reads, saving ~5,000–10,000 tokens per execution.

### 1.14.0 — 2026-02-08
- **Added:** Context-optimizing gsd-tools commands (`phase-plan-index`, `state-snapshot`, `summary-extract`) returning structured JSON.
- **Fixed:** Installer no longer deletes opencode.json on JSONC parse errors; handles comments, trailing commas, and BOM.

### 1.13.0 — 2026-02-08
- **Added:** `history-digest`, `phases list`, `roadmap get-phase`, `phase next-decimal`, `state get/patch`, and `template select` gsd-tools commands.
- **Changed:** Planner uses two-step context assembly; agents migrated from bash patterns to structured gsd-tools commands.

### 1.12.1 — 2026-02-08
- **Changed:** Workflow initialization consolidated into compound `init` commands; 24 files updated to use single-call context gathering.

### 1.12.0 — 2026-02-07
- **Changed:** Thin orchestrator pattern — commands delegate to workflows, reducing command file size ~75%.
- **Added:** `gsd-tools.cjs` CLI utility with 11 functions replacing repetitive bash patterns across 50+ files.

### 1.11.2 — 2026-02-05
- **Fixed (CRITICAL):** Prevent API keys from being committed via `/gsd:map-codebase`.
- **Fixed:** Context fidelity enforced in planning pipeline; executor verifies task completion; parallelization config respected.

### 1.11.1 — 2026-01-31
- **Added:** Git branching strategy config with `none`/`phase`/`milestone` options and squash merge at milestone completion.
- **Fixed:** CONTEXT.md from `/gsd:discuss-phase` now flows to all downstream agents.

### 1.10.1 — 2025-01-30
- **Fixed:** Gemini CLI agent loading errors that prevented commands from executing.

### 1.10.0 — 2026-01-29
- **Added:** Native Gemini CLI support via `--gemini` flag; `--all` flag installs for all three runtimes simultaneously.
- **Fixed:** Context bar now correctly shows 100% at the actual 80% limit.

### 1.9.12 — 2025-01-23
- **Removed:** `/gsd:whats-new` command — superseded by `/gsd:update`.
- **Fixed:** Auto-release GitHub Actions workflow restored.

### 1.9.11 — 2026-01-23
- **Changed:** Switched to manual npm publish workflow, removing GitHub Actions CI/CD.
- **Fixed:** Discord badge uses static format for reliable rendering.

### 1.9.10 — 2026-01-23
- **Added:** Discord community link displayed in installer completion message.

### 1.9.9 — 2026-01-23
- **Added:** `/gsd:join-discord` command for quick access to the GSD Discord invite link.

### 1.9.8 — 2025-01-22
- **Added:** `--uninstall` flag to cleanly remove GSD from global or local installations.
- **Fixed:** Context file detection matches both `CONTEXT.md` and `{phase}-CONTEXT.md` filename variants.

### 1.9.7 — 2026-01-22
- **Fixed:** OpenCode installer uses correct XDG-compliant path `~/.config/opencode/`; permissions written to correct opencode.json location.

### 1.9.6 — 2026-01-22
- **Added:** Interactive runtime selection; native OpenCode support via `--opencode` flag; `--both` flag for dual-runtime install.
- **Changed:** Installation flow asks for runtime first, then location.

### 1.9.5 — 2025-01-22
- **Fixed:** Subagents can now access MCP tools — workaround for Claude Code bug #13898.
- **Fixed:** Installer Escape/Ctrl+C cancels correctly; Windows hook paths fixed.

### 1.9.4 — 2026-01-21
- **Changed:** Checkpoint automation enforces automation-first principle — Claude handles server start, CLI installs, and pre-checkpoint failure recovery before presenting checkpoints.

### 1.9.2 — 2025-01-21
- **Removed:** Codebase Intelligence System removed — deleted `/gsd:analyze-codebase`, `/gsd:query-intel`, SQLite graph database, sql.js (21 MB), and all intel hooks.

### 1.9.0 — 2025-01-20
- **Added:** Model Profiles via `/gsd:set-profile` for quality/balanced/budget configurations.
- **Added:** `/gsd:settings` command for toggling workflow behaviors interactively.

### 1.8.0 — 2026-01-19
- **Added:** `planning.commit_docs: false` config option keeps `.planning/` local-only, not committed to git.
- **Added:** `/gsd:new-project` asks about git tracking during initial setup.

### 1.7.1 — 2026-01-19
- **Fixed:** Quick task PLAN and SUMMARY files use numbered prefix (`001-PLAN.md`, `001-SUMMARY.md`) matching regular phase convention.

### 1.7.0 — 2026-01-19
- **Added:** `/gsd:quick` executes small ad-hoc tasks with GSD guarantees, skipping optional agents; tasks live in `.planning/quick/`.
- **Changed:** Progress bar clamped to 0–100 range; documentation updated with Quick Mode sections.
- **Fixed:** Windows hook console flash, empty `--config-dir` validation, and stale agent references.

### 1.6.4 — 2026-01-17
- **Fixed:** WSL2/non-TTY installation detects non-interactive stdin and falls back to global install.
- **Fixed:** Installation verifies copied files before showing success; orphaned `gsd-notify.sh` hook removed automatically.

### 1.6.3 — 2025-01-17
- **Added:** `--gaps-only` flag for `/gsd:execute-phase` executes only gap closure plans, eliminating redundant state discovery.

### 1.6.2 — 2025-01-17
- **Changed:** README restructured around a clear six-step workflow: init → discuss → plan → execute → verify → complete.
- **Changed:** Phase directories created at discuss/plan-phase instead of during roadmap creation.

### 1.6.1 — 2025-01-17
- **Changed:** Installer performs clean install of GSD folders, removing orphaned files from previous versions.
- **Changed:** `/gsd:update` shows changelog and requests confirmation before updating.

### 1.6.0 — 2026-01-17
- **Breaking:** `/gsd:new-milestone` now mirrors `/gsd:new-project` in a single unified flow.
- **Breaking Removed:** `/gsd:discuss-milestone`, `/gsd:create-roadmap`, `/gsd:define-requirements`, `/gsd:research-project` consolidated into project/milestone flows.
- **Added:** `/gsd:verify-work` includes next-step routing after verification completes.

### 1.5.30 — 2026-01-17
- **Fixed:** Output templates in `plan-phase`, `execute-phase`, and `audit-milestone` render markdown correctly instead of showing literal backticks.
- **Fixed:** Next-step suggestions consistently recommend `/gsd:discuss-phase` before `/gsd:plan-phase`.

### 1.5.29 — 2025-01-16
- **Changed:** Discuss-phase uses domain-aware questioning with deeper probing for gray areas.
- **Fixed:** Windows hooks work via Node.js conversion; blocking notification popups removed on all platforms.

### 1.5.28 — 2026-01-16
- **Breaking Removed:** `/gsd:execute-plan` command; use `/gsd:execute-phase` instead.
- **Fixed:** Phase directory matching handles both zero-padded and unpadded folder names.

### 1.5.27 — 2026-01-16
- **Fixed:** Orchestrator corrections between executor completions are committed instead of left uncommitted.

### 1.5.26 — 2026-01-16
- **Fixed:** Revised plans are committed after checker feedback; previously only initial plans were committed.

### 1.5.25 — 2026-01-16
- **Fixed:** Stop notification hook uses session-scoped todos only, eliminating stale project state display.
- **Fixed:** Researcher agent reliably loads CONTEXT.md from discuss-phase.

### 1.5.24 — 2026-01-16
- **Fixed:** Stop notification hook correctly parses STATE.md fields instead of always showing "Ready for input".
- **Fixed:** Planner agent reliably loads CONTEXT.md and RESEARCH.md files.

### 1.5.23 — 2025-01-16
- **Added:** Cross-platform completion notification hook for Mac, Linux, and Windows.
- **Fixed:** Consistent zero-padding for phase directories; restored `{phase}-{plan}-PLAN.md` naming; fixed researcher double-path git add bug.

### 1.5.22 — 2025-01-16
- **Added:** Statusline update indicator shows `⬆ /gsd:update` when a new version is available.
- **Fixed:** Planner updates ROADMAP.md placeholders after planning completes.

### 1.5.21 — 2026-01-16
- **Added:** GSD brand system for consistent UI; research synthesizer agent consolidates parallel research into SUMMARY.md.
- **Changed:** `/gsd:new-project` unified into a single command handling questions → research → requirements → roadmap.
- **Fixed:** verify-work checkpoint display, planner naming convention, and research synthesizer commit batching.

### 1.5.20 — 2026-01-16
- **Fixed:** Research no longer skipped based on premature "Research: Unlikely" predictions from roadmap creation.
- **Removed:** `Research: Likely/Unlikely` fields and roadmap-based research skip logic from planner.

### 1.5.19 — 2026-01-16
- **Changed:** `/gsd:discuss-phase` redesigned with intelligent gray area analysis and multi-select user control; CONTEXT.md template restructured.
- **Changed:** `/gsd:plan-phase` spawns `gsd-phase-researcher` before planning unless research exists or `--skip-research` used.

### 1.5.18 — 2026-01-16
- **Added:** Plan verification loop — `gsd-plan-checker` agent validates plans across six dimensions with up to three revision iterations.
- **Added:** Dedicated `gsd-planner` agent (1,319 lines) with full planning methodology and TDD integration.
- **Changed:** `/gsd:plan-phase` refactored to thin orchestrator pattern spawning planner and checker agents.

### 1.5.17 — 2026-01-15
- **Added:** `/gsd:update` command to check for updates, install, and display changelog of changes.

### 1.5.16 — 2026-01-15
- **Added:** `gsd-researcher` agent with four research modes (ecosystem, feasibility, implementation, comparison).
- **Added:** `gsd-debugger` agent with scientific debugging methodology and seven investigation techniques.
- **Added:** `gsd-codebase-mapper` agent for brownfield codebase analysis.
- **Changed:** `/gsd:research-phase` and `/gsd:research-project` refactored to thin orchestrators spawning `gsd-researcher`.

### 1.5.15 — 2025-01-15
- **Fixed:** `agents/` folder (gsd-executor, gsd-verifier, gsd-integration-checker, gsd-milestone-auditor) was missing from npm package; now included.
- **Changed:** `/gsd:plan-fix` consolidated into `/gsd:plan-phase --gaps`.

### 1.5.14 — 2025-01-15
- **Fixed:** Plan-phase always routes to `/gsd:execute-phase` after planning, including single-plan phases.

### 1.5.13 — 2026-01-15
- **Fixed:** `/gsd:new-milestone` presents research and requirements paths as equal options matching `/gsd:new-project` format.

### 1.5.12 — 2025-01-15
- **Changed:** Milestone cycle reworked: `complete-milestone` archives and deletes ROADMAP.md and REQUIREMENTS.md; `new-milestone` becomes a brownfield new-project flow.
- **Fixed:** `MILESTONE-AUDIT.md` versioned and archived on completion; `progress` routes correctly between milestones.

### 1.5.11 — 2025-01-15
- **Changed:** Verifier reuses previous must-haves on re-verification and focuses deep checks on failed items only.

### 1.5.10 — 2025-01-15
- **Changed:** Milestone audit reads existing phase VERIFICATION.md files instead of re-verifying each phase; adds `tech_debt` status.
- **Fixed:** VERIFICATION.md included in phase completion commit.

### 1.5.9 — 2025-01-15
- **Added:** `/gsd:audit-milestone` with parallel verification agents for milestone completion checking.
- **Changed:** Checkpoint display improved with box headers and "YOUR ACTION:" prompts; execute-phase recommends audit-milestone at milestone completion.

### 1.5.8 — 2025-01-15
- **Added:** Verification loop: when gaps are found, verifier generates fix plans that execute automatically before re-verifying.

### 1.5.7 — 2025-01-15
- **Added:** `gsd-executor` subagent for plan execution and `gsd-verifier` subagent for goal-backward phase verification.
- **Added:** Automatic verification runs when a phase completes to catch stubs and incomplete implementations.

### 1.5.6 — 2025-01-15
- **Changed:** README separates flow into distinct numbered steps making `research-project` clearly optional.
- **Fixed:** Phase metadata (timing, wave info) bundled into a single commit.

### 1.5.5 — 2025-01-15
- **Changed:** README commands section reorganized into seven grouped tables for easier scanning.
- **Changed:** Context Engineering table updated to include `research/` and `REQUIREMENTS.md`.

### 1.5.4 — 2025-01-15
- **Changed:** Research phase loads REQUIREMENTS.md to focus on concrete requirements rather than high-level roadmap descriptions.

### 1.5.3 — 2025-01-15
- **Changed:** Execute-phase orchestrator narrates what each wave builds and summarizes after completion.
- **Changed:** New-project offers two paths: research-first or define-requirements directly (fast path).
- **Removed:** Dead `/gsd:status` command, unused `agent-history.md` template, and old `_archive/` directory.

### 1.5.2 — 2026-01-15
- **Added:** Requirements traceability with `Requirements:` field in roadmap phases listing covered REQ-IDs.
- **Added:** Plan-phase loads REQUIREMENTS.md and marks requirements complete when phase finishes.
- **Changed:** Workflow preferences gathered in a single prompt instead of three separate questions.

### 1.5.1 — 2026-01-14
- **Changed:** Research agents write output files (STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md) directly instead of returning to orchestrator.

### 1.5.0 — 2026-01-14
- **Added:** `/gsd:research-project` spawns parallel agents to investigate stack, features, architecture, and pitfalls pre-roadmap.
- **Added:** `/gsd:define-requirements` transforms research findings into scoped v1 requirements with phase traceability.
- **Breaking:** New project flow is now `new-project → research-project → define-requirements → create-roadmap`.

### 1.4.29 — 2026-01-14
- **Removed:** Deleted obsolete `_archive/execute-phase.md` and `status.md` commands.

### 1.4.28 — 2026-01-14
- **Fixed:** Restored comprehensive checkpoint documentation with full examples for all three checkpoint types.
- **Fixed:** execute-plan uses fresh continuation agents instead of broken resume pattern.
- **Changed:** execute-phase slimmed to properly delegate checkpoint handling to workflow.

### 1.4.27 — 2025-01-14
- **Fixed:** Restored copy/paste-ready next-step routing after plan/phase execution completes.

### 1.4.26 — 2026-01-14
- **Added:** Full changelog history backfilled from git (66 historical versions, 1.0.0 to 1.4.23).

### 1.4.25 — 2026-01-14
- **Added:** `/gsd:whats-new` command shows changes since installed version; VERSION file and CHANGELOG.md included in package.

### 1.4.24 — 2026-01-14
- **Added:** USER-SETUP.md template for external service configuration.
- **Removed (breaking):** ISSUES.md system replaced by phase-scoped UAT issues and TODOs.

### 1.4.23 — 2026-01-14
- **Changed:** Removed dead ISSUES.md system code.

### 1.4.22 — 2026-01-14
- **Added:** Subagent isolation for debug investigations with checkpoint support.
- **Fixed:** DEBUG_DIR path constant corrected to prevent typos in debug workflow.

### 1.4.21 — 2026-01-14
- **Fixed:** SlashCommand tool added to plan-fix allowed-tools list.

### 1.4.20 — 2026-01-14
- **Fixed:** Standardized debug file naming convention and corrected execute-plan invocation in debug workflow.

### 1.4.19 — 2026-01-14
- **Fixed:** plan-fix auto-diagnoses issues instead of offering the user a choice.

### 1.4.18 — 2026-01-14
- **Added:** Parallel diagnosis runs before plan-fix execution.

### 1.4.17 — 2026-01-14
- **Changed:** verify-work redesigned as conversational UAT with persistent state.

### 1.4.16 — 2026-01-13
- **Added:** Pre-execution summary for interactive mode in execute-plan.
- **Added:** Wave numbers pre-computed at plan time.

### 1.4.15 — 2026-01-13
- **Added:** Context rot explanation added to README header.

### 1.4.14 — 2026-01-13
- **Changed:** YOLO mode is now the recommended default in new-project workflow.

### 1.4.13 — 2026-01-13
- **Fixed:** Brownfield flow documentation corrected; deprecated resume-task references removed.

### 1.4.12 — 2026-01-13
- **Changed:** execute-phase promoted as the recommended primary execution command.

### 1.4.11 — 2026-01-13
- **Fixed:** Checkpoints spawn fresh continuation agents instead of using resume.

### 1.4.10 — 2026-01-13
- **Changed:** execute-plan converted to orchestrator pattern for improved performance.

### 1.4.9 — 2026-01-13
- **Changed:** Removed subagent-only context from execute-phase orchestrator.
- **Fixed:** Removed "what's out of scope" question from discuss-phase.

### 1.4.8 — 2026-01-13
- **Added:** TDD reasoning explanation restored to plan-phase documentation.

### 1.4.7 — 2026-01-13
- **Added:** Project state loading before execution in execute-phase.
- **Fixed:** Parallel execution marked as recommended, not experimental.

### 1.4.6 — 2026-01-13
- **Added:** Checkpoint pause/resume for spawned agents; deviation rules, commit rules, and workflow references added to execute-phase.

### 1.4.5 — 2026-01-13
- **Added:** Parallel-first planning with dependency graphs and checkpoint-resume for long-running phases.
- **Added:** `.claude/rules/` directory for auto-loaded contribution rules.
- **Changed:** execute-phase uses wave-based blocking execution.

### 1.4.4 — 2026-01-13
- **Fixed:** Inline listing corrected for multiple active debug sessions.

### 1.4.3 — 2026-01-13
- **Added:** `/gsd:debug` command for systematic debugging with persistent state.

### 1.4.2 — 2026-01-13
- **Fixed:** Installation verification step clarification.

### 1.4.1 — 2026-01-13
- **Added:** Parallel phase execution via `/gsd:execute-phase` with wave-based dependency graphs and `/gsd:status` monitoring.
- **Changed:** `execute-phase.md` renamed to `execute-plan.md`; plan frontmatter extended with wave, depends_on, files_modified, autonomous fields.

### 1.4.0 — 2026-01-12
- **Added:** Full parallel phase execution system with dependency analysis and agent history schema v1.2.
- **Changed:** Plans specify wave numbers and dependencies; execute-phase orchestrates subagents in waves.

### 1.3.34 — 2026-01-11
- **Added:** `/gsd:add-todo` and `/gsd:check-todos` commands for mid-session idea capture.

### 1.3.33 — 2026-01-11
- **Fixed:** Consistent zero-padding for decimal phase numbers (e.g., 01.1).
- **Changed:** Removed obsolete `.claude-plugin` directory.

### 1.3.32 — 2026-01-10
- **Added:** `/gsd:resume-task` command for resuming interrupted subagent executions.

### 1.3.31 — 2026-01-08
- **Added:** Planning principles for security, performance, and observability; pro patterns section in README.

### 1.3.30 — 2026-01-08
- **Added:** verify-work option surfaces after plan execution completes.

### 1.3.29 — 2026-01-08
- **Added:** `/gsd:verify-work` for conversational UAT validation, `/gsd:plan-fix` for fixing UAT issues, and UAT issues template.

### 1.3.28 — 2026-01-07
- **Added:** `--config-dir` CLI argument for multi-account setups and `/gsd:remove-phase` command.
- **Fixed:** Validation for --config-dir edge cases.

### 1.3.27 — 2026-01-07
- **Added:** Recommended permissions mode documentation.
- **Fixed:** Mandatory verification enforced before phase/milestone completion routing.

### 1.3.26 — 2026-01-06
- **Added:** Claude Code marketplace plugin support.
- **Fixed:** Phase artifacts committed when created.

### 1.3.25 — 2026-01-06
- **Fixed:** Milestone discussion context persists across `/clear`.

### 1.3.24 — 2026-01-06
- **Added:** `CLAUDE_CONFIG_DIR` environment variable support.

### 1.3.23 — 2026-01-06
- **Added:** Non-interactive install flags (`--global`, `--local`) for Docker/CI environments.

### 1.3.22 — 2026-01-05
- **Changed:** Removed unused `auto.md` command.

### 1.3.21 — 2026-01-05
- **Changed:** TDD features use dedicated plans for full context quality.

### 1.3.20 — 2026-01-05
- **Added:** Per-task atomic commits for better AI observability.

### 1.3.19 — 2026-01-05
- **Fixed:** Clarified create-milestone.md file locations with explicit instructions.

### 1.3.18 — 2026-01-05
- **Added:** YAML frontmatter schema with dependency graph metadata for intelligent context assembly.

### 1.3.17 — 2026-01-04
- **Fixed:** Clarified that depth parameter controls compression, not inflation, in planning.

### 1.3.16 — 2026-01-04
- **Added:** Depth parameter for planning thoroughness (`--depth=1-5`).

### 1.3.15 — 2026-01-01
- **Fixed:** TDD reference loaded directly in commands.

### 1.3.14 — 2025-12-31
- **Added:** TDD integration with detection, annotation, and execution flow.

### 1.3.13 — 2025-12-29
- **Fixed:** Restored deterministic bash commands; removed redundant `decision_gate`.

### 1.3.12 — 2025-12-29
- **Fixed:** Restored `plan-format.md` as the output template.

### 1.3.11 — 2025-12-29
- **Changed:** 70% context reduction for plan-phase workflow; merged CLI automation into checkpoints; compressed scope-estimation (74%) and plan-phase.md (66%).

### 1.3.10 — 2025-12-29
- **Fixed:** Explicit plan count check added in `offer_next` step.

### 1.3.9 — 2025-12-27
- **Added:** Evolutionary PROJECT.md system with incremental updates.

### 1.3.8 — 2025-12-18
- **Added:** Brownfield/existing projects section in README.

### 1.3.7 — 2025-12-18
- **Fixed:** Improved incremental codebase map updates.

### 1.3.6 — 2025-12-18
- **Added:** File paths included in codebase mapping output.

### 1.3.5 — 2025-12-17
- **Fixed:** Removed arbitrary 100-line limit from codebase mapping.

### 1.3.4 — 2025-12-17
- **Fixed:** Inline code used for Next Up commands to avoid nesting ambiguity.

### 1.3.3 — 2025-12-17
- **Fixed:** Existing project detection checks PROJECT.md instead of `.planning/` directory.

### 1.3.2 — 2025-12-17
- **Added:** Git commit step added to map-codebase workflow.

### 1.3.1 — 2025-12-17
- **Added:** `/gsd:map-codebase` documentation added to help and README.

### 1.3.0 — 2025-12-17
- **Added:** `/gsd:map-codebase` command for brownfield project analysis with parallel Explore agent orchestration.
- **Added:** Codebase map templates covering stack, architecture, structure, conventions, testing, integrations, and concerns.
- **Fixed:** Permission errors for non-DSP users removed; first question is now freeform.

### 1.2.13 — 2025-12-17
- **Added:** Improved continuation UI with context and visual hierarchy.

### 1.2.12 — 2025-12-17
- **Fixed:** First question uses freeform input, not AskUserQuestion.

### 1.2.11 — 2025-12-17
- **Fixed:** Permission errors for non-DSP users resolved by removing shell context.

### 1.2.10 — 2025-12-16
- **Fixed:** Inline command invocation replaced with clear-then-paste pattern.

### 1.2.9 — 2025-12-16
- **Fixed:** Git init runs in the current directory.

### 1.2.8 — 2025-12-16
- **Changed:** Phase count derived from work scope, not arbitrary limits.

### 1.2.7 — 2025-12-16
- **Fixed:** AskUserQuestion mandated for all exploration questions.

### 1.2.6 — 2025-12-16
- **Changed:** Internal refactoring.

### 1.2.5 — 2025-12-16
- **Changed:** `<if mode>` tags added for yolo/interactive branching.

### 1.2.4 — 2025-12-16
- **Fixed:** Stale CONTEXT.md references updated to new vision structure.

### 1.2.3 — 2025-12-16
- **Fixed:** Enterprise language removed from help and discuss-milestone.

### 1.2.2 — 2025-12-16
- **Fixed:** New-project completion presented inline instead of as a question.

### 1.2.1 — 2025-12-16
- **Fixed:** AskUserQuestion restored for decision gate in questioning flow.

### 1.2.0 legacy — 2025-12-15
- **Changed:** Research workflow implemented as Claude Code context injection. (Renamed from `1.2.0` to avoid colliding with `@opengsd/gsd-core@1.2.0`.)

### 1.1.2 — 2025-12-15
- **Fixed:** YOLO mode skips confirmation gates in plan-phase.

### 1.1.1 — 2025-12-15
- **Added:** README documentation for the new research workflow.

### 1.1.0 — 2025-12-15
- **Added:** Pre-roadmap research workflow with `/gsd:research-phase`, `/gsd:research-project`, and `/gsd:create-roadmap` commands.
- **Changed:** new-project split to create only PROJECT.md and config.json; questioning rewritten as thinking partner.

### 1.0.11 — 2025-12-15
- **Added:** `/gsd:research-phase` command for niche domain ecosystem discovery.

### 1.0.10 — 2025-12-15
- **Fixed:** Scope creep prevention in discuss-phase command.

### 1.0.9 — 2025-12-15
- **Added:** Phase CONTEXT.md loaded in plan-phase command.

### 1.0.8 — 2025-12-15
- **Changed:** PLAN.md included in phase completion commits.

### 1.0.7 — 2025-12-15
- **Added:** Path replacement for local installs.

### 1.0.6 — 2025-12-15
- **Changed:** Internal improvements.

### 1.0.5 — 2025-12-15
- **Added:** Global/local install prompt during setup.
- **Fixed:** Bin path corrected (removed `./`); `.DS_Store` ignored.

### 1.0.4 — 2025-12-15
- **Fixed:** Bin name corrected and circular dependency removed.

### 1.0.3 — 2025-12-15
- **Added:** TDD guidance in planning workflow.

### 1.0.2 — 2025-12-15
- **Added:** Issue triage system to prevent deferred issue pile-up.

### 1.0.1 — 2025-12-15
- **Added:** Initial npm package release.

### 1.0.0 — 2025-12-14
- **Added:** Initial release of the GSD Core meta-prompting system with core slash commands, PROJECT.md/STATE.md templates, phase-based workflow, YOLO mode, and interactive mode with checkpoints.

---

## Pre-release & canary builds

These `-rc` and `-canary` builds were development previews published under the `next` / `canary` dist-tags during the retired package's lifetime. They were never promoted to stable under these version numbers and are retained here only for historical completeness. Newest first.

| Version | Summary |
| --- | --- |
| 1.50.0-canary.1 | Vertical MVP / TDD / UAT planning track introduced end-to-end |
| 1.42.0-rc.1 | Package legitimacy gate against slopsquatting; SDK and phase seams deepened |
| 1.40.0-rc.1 | Skill-surface consolidated 86→59; six namespace meta-skills replace flat listing |
| 1.39.0-rc.7 | First RC rolling in post-rc.5 main-branch fixes |
| 1.39.0-rc.6 | Version-bump republish of rc.5; no new content |
| 1.39.0-rc.5 | Codex hooks migrator correctness hardening |
| 1.39.0-rc.4 | Minimal install flag and Codex config.toml corruption fix |

### 1.50.0-canary.1
- `/gsd plan-phase --mvp` flag enables vertical-slice planning mode; suppresses horizontal-layer language in favour of user-flow-driven decomposition.
- `/gsd mvp-phase <N>` new top-level command frames a phase as a vertical MVP slice using "As a / I want to / So that" user stories, with SPIDR splitting for oversized stories.
- Execute-phase MVP+TDD gate requires a `test(<phase>-<plan>):` commit before each corresponding `feat(...)` commit when both modes are active.
- Verify-work flips UAT script framing under MVP mode: user-flow steps appear before technical correctness checks.
- `/gsd new-project` prompts for Vertical MVP vs Horizontal Layers mode; `/gsd-progress`, `/gsd-stats`, and `/gsd-graphify` gain MVP-mode awareness.

### 1.42.0-rc.1
- Three-layer package legitimacy gate added across researcher, planner, and executor agents; closes the path where hallucinated package names could flow undetected into `npm install`.
- Researcher runs `slopcheck install <pkgs> --json` and emits a Package Legitimacy Audit table; packages found only via WebSearch are tagged `[ASSUMED]`, never `[VERIFIED]`.
- Planner inserts `checkpoint:human-verify` tasks before any install tagged `[ASSUMED]` or `[SUS]`.
- SDK package seam deepened: legacy package and install-layout compatibility centralized behind a single module; runtime-global skills policy shared across SDK and CJS callers.
- Phase lifecycle refactored into three extracted modules: Phase Numbering Policy, Phase Filesystem Adapter, and Phase Roadmap Mutation.

### 1.40.0-rc.1
- Six namespace meta-skills (`gsd:workflow`, `gsd:project`, `gsd:review`, `gsd:context`, `gsd:manage`, `gsd:ideate`) replace the flat 86-skill listing; drops cold-start overhead from ~2,150 to ~120 tokens.
- Skill surface consolidated from 86 to 59 entries; 31 micro-skills removed with all behaviour preserved via flags on parent commands.
- `/gsd-health --context` utilization guard warns at 60% and raises critical at 70% context-window utilization.
- Gemini slash commands use the correct `/gsd:<cmd>` namespace form; previous `/gsd-<cmd>` references were unexecutable in Gemini CLI.
- Phase-lifecycle status-line read-side added: `parseStateMd()` reads `active_phase`, `next_action`, `next_phases`, and `progress` frontmatter fields.

### 1.39.0-rc.7
- First 1.39.0 RC to sync `release/1.39.0` with `main`; rc.6 was content-identical to rc.5.
- Added manual canary release workflow publishing `{base}-canary.{N}` builds under the `canary` dist-tag via `workflow_dispatch`.
- `extractCurrentMilestone` no longer truncates ROADMAP.md at heading-like lines inside fenced code blocks.
- `gsd-sdk auto` detects Codex runtime correctly; previously ignored `runtime: codex` and routed through the Claude SDK, producing `[FAILED] $0.00 0.1s`.
- `find-phase` returns `null` for archived phases; previously returned the prior-milestone directory, causing wrong-phase work.

### 1.39.0-rc.6
- rc.6 is a content-identical republish of rc.5; `release/1.39.0` was bumped without first being merged with `main`.
- The single commit between rc.5 and rc.6 is a version-bump only (`chore: bump to 1.39.0-rc.6`).
- Eight fixes that landed on `main` after rc.5 were not included; they were targeted for rc.7.

### 1.39.0-rc.5
- Hardened the `[[hooks.<Event>]]` migration path by replacing a bare regex in `parseHooksBody` with the full `parseTomlKey()` parser.
- `buildNestedBlock` emits event-entry blocks only when handler fields are present; previously always emitted a `type = "command"` entry with no `command`.
- `legacyMapSections` filter corrected to use `section.segments.length === 2`, eliminating misclassification of three-segment table headers.
- Regression test added for quoted event names containing dots to prevent `split('.')` misclassification of `[[hooks."before.tool"]]`.

### 1.39.0-rc.4
- Added `--minimal` install flag (alias `--core-only`) writing only six core skills; drops cold-start overhead from ~12k to ~700 tokens.
- Codex installer no longer corrupts `~/.codex/config.toml`; strips legacy `[agents]` blocks unconditionally.
- Install writes atomically via temp file and `renameSync`; validates post-write bytes with a strict TOML parser.
- On any pre-write or write-time failure, the pre-install snapshot is restored and the installer aborts with a clear error.

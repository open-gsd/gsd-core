# Changelog

All notable changes to GSD will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.3.1](https://www.npmjs.com/package/@opengsd/gsd-core/v/1.3.1) - 2026-06-04

### Security

- **Bumped `hono` to clear a moderate npm advisory** carried transitively in the dependency tree. (#670)

### Fixed

- **Installer-migration checksum drift no longer blocks upgrades** — the updater now self-heals when a shipped migration's recorded checksum has drifted, reconciling the stored checksum instead of aborting. Restores upgrades across all OSes after shipped migration bodies were edited in a prior release. (#670)

## [1.3.0](https://www.npmjs.com/package/@opengsd/gsd-core/v/1.3.0) - 2026-06-04

### Added

- **Vertical MVP Slice mode** — `--mvp` flag on `/gsd-plan-phase` switches the planner from horizontal layer decomposition to vertical feature-slice decomposition (UI→API→DB in one task sequence). On Phase 1 of a new project with no prior phase summaries, also emits `SKELETON.md` via Walking Skeleton mode. Composable with `--tdd`: `--mvp --tdd` produces vertical slices where every behavior-adding task starts with a failing test. Phase-level persistence via `**Mode:** mvp` in ROADMAP.md applies `--mvp` automatically without the flag. (#78)
- **`/gsd-mvp-phase` command** — guided MVP planning: prompts for a user story (`As a / I want to / So that`), runs SPIDR story-splitting check (Spike/Paths/Interfaces/Data/Rules axes), writes `**Mode:** mvp` to ROADMAP.md, then delegates to `/gsd-plan-phase`. (#78)
- **MVP-aware UAT framing in `verify-phase`** — when a phase has `mode: mvp`, the verifier generates a user-flow-first UAT script (walks the feature as a user would) before any technical checks. (#78)
- **MVP progress and stats display** — `progress` and `stats` commands show Walking Skeleton completion status and per-feature-slice status lines for MVP-mode phases. (#78)
- **Six MVP reference files** — `planner-mvp-mode.md`, `skeleton-template.md`, `user-story-template.md`, `spidr-splitting.md`, `execute-mvp-tdd.md`, `verify-mvp-mode.md` — loaded by the planner, executor, and verifier agents when MVP mode is active. (#78)
- Milestone-prefixed phase ID convention (M-NN) for globally unique phase IDs within a project (#39)
- `getMilestoneFromPhaseId()` and `getPhaseDirFromPhaseId()` helpers in core.cjs (#39)
- W021 validation rule: fires when a phase ID's integer prefix mismatches its enclosing milestone section (#39)
- `gsd-tools roadmap validate` subcommand for convention compliance checking (#39)
- `gsd-tools roadmap upgrade --convention milestone-prefixed` migration tool (dry-run by default, `--apply` to mutate) (#39)
- `phase_id_convention` config field (`null` | `'milestone-prefixed'` | `'free-form'`), defaults to `null` (legacy free-form, no breaking change) (#39)

### Fixed

- `isDirInMilestone` now correctly matches M-NN-style phase directories against milestone-prefixed ROADMAP headings (#39)
- `searchPhaseInContent` heading regex now tolerates `[bracket-token]` scope prefix (e.g., `### [GSD] Phase 2-01:`) (#39)
- **README version guidance now uses npm/package metadata as the source of truth** — README, localized READMEs, and the docs index no longer present archived release-note or canary-stream numbers as the current GSD Core package version. (#545)

## [1.2.0](https://www.npmjs.com/package/@opengsd/gsd-core/v/1.2.0) - 2026-05-31

`1.2.0` is the current stable `@opengsd/gsd-core` release. It resumes the public package line after the release-version validation recovery documented in [ADR 218](docs/adr/218-release-version-validation.md) and makes `@opengsd/gsd-core` / `gsd-core` the canonical package and CLI identity.

### Added

- **Plan-vs-codebase drift guard** — plan review can verify generated plans against live source symbols before execution so hallucinated files, APIs, or commands are caught earlier. (#487)
- **Single Package Identity seam** — package name, CLI identity, update checks, and installer identity are centralized so `@opengsd/gsd-core` stays consistent across runtime surfaces. (#499, #517, #521)
- **Cross-provider effort controls and fast-mode-aware routing** — model-effort selection works across providers and can adjust routing for faster workflows. (#463)
- **Current public docs and install identity** — README/docs now advertise GSD Core, `@opengsd/gsd-core`, and the `gsd-core` binary as the canonical user-facing surface. (#519, #523, #540)

### Changed

- **SDK shim retired from installer/runtime docs** — workflows now route through `gsd-tools`; dead SDK-shim verification and stale SDK-generated banners were removed. (#522, #515, #510)
- **Release numbering recovered at `1.2.0`** — leading-zero release inputs are invalid and duplicate-version checks fail early before publish work begins. See [ADR 218](docs/adr/218-release-version-validation.md).
- **CI/test selection is more precise** — affected-test selection now widens docs/test-impact correctly and avoids under-testing relevant PRs. (#495)

### Fixed

- **Planning writes are more reliable** — phase completion writes are transactional and no longer corrupt milestone progress counters. (#465, #514)
- **Roadmap and milestone parsing no longer leak stale phase details into active milestone state.** (#513)
- **`/gsd:update` detects local Antigravity `.agent` installs and repo-local Claude installs correctly.** (#512, #476)
- **Package identity registration no longer regresses update/runtime detection.** (#521)

## Legacy Release History

Release notes for every version published before the project was renamed to `@opengsd/gsd-core` — the retired `get-shit-done-cc` / `get-shit-done-redux` lineage, versions `1.0.0` → `1.42.x` plus pre-release and canary builds — have been rolled up into a single archive:

➡️ **[docs/RELEASE-NOTES-LEGACY.md](docs/RELEASE-NOTES-LEGACY.md)**

Those legacy `1.x` numbers belong to the previous package line and predate the current `@opengsd/gsd-core` versioning, which restarts at `1.0.0`. They are preserved verbatim-in-spirit (condensed) in the archive and intentionally kept out of this file so the two version streams cannot collide.

[Unreleased]: https://github.com/open-gsd/gsd-core/compare/main...HEAD

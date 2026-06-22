# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for GSD.

Each ADR documents one architectural decision: what was decided, why, and what consequences follow. ADRs are append-only. Amendments extend existing ADRs with a dated section rather than replacing them.

## Naming Convention

New ADRs use **issue#-prefix slug** naming:

```text
docs/adr/<issue#>-<kebab-slug>.md
```

Examples: `3485-adr-prd-naming-convention.md`, `3464-review-default-reviewers.md`.

### Why

Two developers computing "next ADR number" locally against `main` will independently pick the same integer and both ship. The collision is already on disk — `0010-*` exists twice and `0011-*` exists three times. GitHub issue numbers are server-assigned and atomic: the moment you open an issue, that number is reserved globally. Two PRs that both edit the `### Fixed` block of `CHANGELOG.md` always conflict on merge — two PRs that each use a distinct issue# as their ADR prefix never collide. Same shape, same solution.

### Legacy ADRs

Files `0001-*` through `0011-*` are preserved as immutable historical record. The duplicate `0010-*` and the three-way `0011-*` are documented residue of the old local-compute convention — not patterns to imitate. Do not renumber them.

### Full process

See **[CONTRIBUTING.md — "Proposing an ADR or PRD"](../../CONTRIBUTING.md#proposing-an-adr-or-prd)** for the end-to-end workflow: opening the issue, waiting for approval, naming the file, and submitting the PR.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001-dispatch-policy-module.md](0001-dispatch-policy-module.md) | Dispatch policy module as single seam for query execution outcomes | Accepted |
| [0002-command-contract-validation-module.md](0002-command-contract-validation-module.md) | Command Contract Validation Module | Accepted |
| [0003-model-catalog-module.md](0003-model-catalog-module.md) | Model Catalog Module as single source of truth for agent profiles and runtime tier defaults | Accepted |
| [0004-worktree-workstream-seam-module.md](0004-worktree-workstream-seam-module.md) | Planning Workspace Module as single seam for worktree and workstream state | Accepted |
| [0005-sdk-architecture-seam-map.md](0005-sdk-architecture-seam-map.md) | SDK Architecture seam map for query/runtime surfaces | Superseded by ADR-0174 |
| [0006-planning-path-projection-module.md](0006-planning-path-projection-module.md) | Planning Path Projection Module for SDK query handlers | Accepted |
| [0007-sdk-package-seam-module.md](0007-sdk-package-seam-module.md) | SDK Package Seam Module owns SDK-to-get-shit-done-redux compatibility | Superseded by ADR-0174 |
| [0008-installer-migration-module.md](0008-installer-migration-module.md) | Installer Migration Module owns install-time upgrade safety | Accepted |
| [0009-shell-command-projection-module.md](0009-shell-command-projection-module.md) | Shell Command Projection Module owns runtime-aware OS command rendering | Accepted |
| [0010-file-operation-engine-module.md](0010-file-operation-engine-module.md) | File Operation Engine Module owns safe runtime/config file mutations | Proposed |
| [0010-skill-surface-budget-module.md](0010-skill-surface-budget-module.md) | Skill Surface Budget Module — earlier draft superseded by ADR-0011 | Superseded by 0011 |
| [0011-skill-surface-budget-module.md](0011-skill-surface-budget-module.md) | Skill Surface Budget Module owns install-time profile staging and runtime surface control | Accepted |
| [0011-review-default-reviewers.md](0011-review-default-reviewers.md) | Review default-reviewers selection policy for /gsd:review | Accepted |
| [0011-review-default-reviewers-prd.md](0011-review-default-reviewers-prd.md) | PRD for review.default_reviewers feature (#3464) | Reference |
| [0012-command-routing-hub.md](0012-command-routing-hub.md) | CommandRoutingHub as single dispatch seam for CJS command families | Superseded by ADR-0174 |
| [15-autonomous-cross-ai-convergence.md](15-autonomous-cross-ai-convergence.md) | Cross-AI plan convergence via existing orchestration commands | Proposed |
| [22-plan-drift-guard.md](22-plan-drift-guard.md) | Plan-vs-codebase drift guard: defaults and symbol-resolver seam | Proposed |
| [3524-cjs-sdk-hard-seam.md](3524-cjs-sdk-hard-seam.md) | CJS↔SDK hard seam — single canonical owner per responsibility (#3524) | Superseded by ADR-0174 |
| [3660-runtime-artifact-layout-module.md](3660-runtime-artifact-layout-module.md) | Runtime Artifact Layout Module owns per-runtime artifact placement | Accepted |
| [0174-retire-gsd-sdk-package-boundary.md](0174-retire-gsd-sdk-package-boundary.md) | Retire @opengsd/gsd-sdk package boundary — single-runtime collapse | Accepted |
| [452-eslint-lint-harness.md](452-eslint-lint-harness.md) | Adopt standard ESLint flat-config lint harness; retire homegrown regex scanners | Accepted |
| [456-test-rigor-architecture.md](456-test-rigor-architecture.md) | Test-rigor architecture — deterministic scheduling, antagonistic tier, typed-surface mandate, delete-bad-tests policy | Accepted |
| [457-generated-cjs-single-source.md](457-generated-cjs-single-source.md) | Collapse hand-written CJS to generated single-source | Proposed |
| [660-release-from-next-head.md](660-release-from-next-head.md) | Release from the head of next; immutable release tags; @next dist-tag as the RC surface | Proposed |
| [58-runtime-install-policy-module.md](58-runtime-install-policy-module.md) | Runtime Install Policy Module owns the typed install-plan projection | Accepted |
| [766-claude-code-plugin-manifest-module.md](766-claude-code-plugin-manifest-module.md) | Claude Code Plugin Manifest Module owns the projection of gsd-core surfaces onto the Claude Code plugin contract | Accepted |
| [1016-runtime-capability-descriptor.md](1016-runtime-capability-descriptor.md) | Runtime Capability Descriptor | Accepted |
| [1235-descriptor-driven-agent-conversion-migration.md](1235-descriptor-driven-agent-conversion-migration.md) | Migrate agent conversion to the descriptor-driven install path (parity + per-runtime cutover) | Proposed |
| [1411-resolution-provenance.md](1411-resolution-provenance.md) | Resolution must report provenance, not fall open silently | Accepted |
| [1508-runtime-artifact-conversion-module.md](1508-runtime-artifact-conversion-module.md) | Runtime Artifact Conversion Module owns per-runtime content rewriting | Accepted |
| [1593-skill-mapping-converter-methodology.md](1593-skill-mapping-converter-methodology.md) | Skill mapping & converter methodology across runtimes | Accepted |

## Seam map

ADR 0005 is the top-level SDK seam index. It references per-seam ADRs and states the narrow-waist principle each seam follows. Use it as the entry point for understanding SDK module ownership.

ADR 0006 documents how SDK query handlers project planning paths (`cwd → effectiveRoot → .planning/<project>/...`). Cross-reference with the Planning Workspace Module (ADR 0004) for workstream pointer policy.

ADR 0008 documents the Installer Migration Module for safe install-time moves, removals, config rewrites, and user-data preservation.

ADR 0009 documents the Shell Command Projection Module seam for runtime-aware
projection of installer-owned command text and projection IR.

ADR 0010 documents the File Operation Engine Module seam for converging
installer/migration/planning file mutation safety policy, and its relationship
to ADR 0009 hook-command ownership policy.

ADR 0011 documents the Skill Surface Budget Module for install-time skill/agent
profile staging (`--profile=<name>`, `.gsd-profile` marker, `requires:` closure)
and the Phase 2 runtime `/gsd:surface` command for cluster-level enable/disable
without reinstall.

ADR 1411 establishes the Resolution Provenance principle: context resolution
(config loading, project-root anchoring, workstream resolution) must report its
provenance rather than fall open silently to defaults. It is the resolution-side
analog of ADR 227 (input-validation shape), binds the Config Loader Module,
Project-Root Resolution Module, and I/O Module, and is the decision record for
epic #1411 (phases P1–P4).

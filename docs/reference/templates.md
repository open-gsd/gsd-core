# Templates

Reference for the files under `gsd-core/templates/`: each template's path, the artifact it produces, and what loads it. The installer copies the directory to `<config dir>/gsd-core/templates/`.

[`gsd-core/templates/README.md`](../../gsd-core/templates/README.md) is the canonical artifact registry that `gsd-health` reads (an unlisted `.planning/` root file raises W019); it is not itself a template. For the `.planning/` files these templates produce, see [Planning artifacts](planning-artifacts.md).

## Template selection and fill

| Command | Behavior |
|---------|----------|
| `gsd-tools template select <plan-path>` | Picks a summary template for a plan: `templates/summary-minimal.md` when the plan has at most 2 `### Task N` headings, mentions at most 3 file paths and contains no occurrence of the word "decision"; `templates/summary-complex.md` when the plan mentions "decision", more than 6 file paths, or more than 5 tasks; otherwise `templates/summary-standard.md`. If the plan cannot be read it falls back to `summary-standard.md` and reports the error. Prints `{ template, type, taskCount, fileCount, hasDecisions }`. |
| `gsd-tools template fill summary\|plan\|verification --phase <N>` | Writes a skeleton `NN-MM-SUMMARY.md`, `NN-MM-PLAN.md` or `NN-VERIFICATION.md` into the phase directory with pre-filled frontmatter. The skeleton body is built into the command; it does not read the files in `gsd-core/templates/`. Refuses to overwrite an existing file. Options: `--plan`, `--name`, `--type` and `--wave` (plan), `--fields` (extra frontmatter). |

## Project-level templates

| Template | Produces | Referenced by |
|----------|----------|-----------|
| `project.md` | `.planning/PROJECT.md` | `/gsd-new-project`, `/gsd-new-milestone` |
| `requirements.md` | `.planning/REQUIREMENTS.md` | `/gsd-new-project`, `/gsd-new-milestone` |
| `roadmap.md` | `.planning/ROADMAP.md` | the `gsd-roadmapper` agent; `src/phase.cts`, `src/plan-drift-guard.cts` and the roadmap-disk-consistency health check |
| `state.md` | `.planning/STATE.md` | the `gsd-roadmapper` agent; `scripts/gen-state-md-docs.cjs`; the state-consistency health check |
| `config.json` | `.planning/config.json` (the registry lists `/gsd-new-project` and `/gsd-health --repair` as its producers) | No file under `src/`, `bin/`, `scripts/`, `gsd-core/workflows/`, `agents/`, `commands/` or `capabilities/` names it by template path |
| `milestone.md` | an entry in `.planning/MILESTONES.md` | `/gsd-complete-milestone` workflow |
| `milestone-archive.md` | archive files in `.planning/milestones/` | `/gsd-complete-milestone` |
| `retrospective.md` | `.planning/RETROSPECTIVE.md` | `/gsd-complete-milestone` workflow |

## Phase-level templates

All phase artifacts live in `.planning/phases/NN-name/`.

| Template | Produces | Referenced by |
|----------|----------|-----------|
| `context.md` | `NN-CONTEXT.md`: implementation decisions for the phase | `/gsd-discuss-phase` |
| `discussion-log.md` | `NN-DISCUSSION-LOG.md`: audit trail of the discuss-phase Q&A; not for agent consumption | the discuss-phase workflow |
| `spec.md` | `NN-SPEC.md`: falsifiable requirements locked before discuss-phase | `/gsd-spec-phase` |
| `research.md` | `NN-RESEARCH.md`: ecosystem research before planning | the `gsd-phase-researcher` agent |
| `VALIDATION.md` | `NN-VALIDATION.md`: validation architecture; status `draft` when seeded by plan-phase, `validated` when set by validate-phase | the plan-phase and validate-phase workflows |
| `phase-prompt.md` | `NN-MM-PLAN.md`: the executable plan format | the plan format in `src/plan-document.cts`; `gsd-core/references/planner-guidance.md` |
| `planner-subagent-prompt.md` | the `<planning_context>` block of a `gsd-planner` spawn | No file other than two static-check scripts names it |
| `summary.md` | `NN-MM-SUMMARY.md`: post-execution summary | the `gsd-executor` and `gsd-planner` agents; the execute-phase and execute-plan workflows |
| `summary-minimal.md`, `summary-standard.md`, `summary-complex.md` | `NN-MM-SUMMARY.md` at three sizes | chosen by `template select` |
| `summary.compact.md` | the compact form of `summary.md` | the execute-plan workflow |
| `user-setup.md` | `{phase}-USER-SETUP.md`: setup that needs a human (accounts, dashboards, secrets) | the execute-plan workflow |
| `user-setup.compact.md` | the compact form of `user-setup.md` | the execute-plan workflow |
| `UAT.md` | `NN-UAT.md`: persistent user-acceptance-test session state | `/gsd-verify-work`; `src/uat.cts` |
| `verification-report.md` | `NN-VERIFICATION.md`: phase-goal verification results | `gsd-core/references/verifier-phase-gates.md`; `src/verification.cts`; `src/uat.cts` |
| `UI-SPEC.md` | `NN-UI-SPEC.md`: UI design contract | `/gsd-ui-phase`; the `gsd-ui-researcher` agent |
| `SECURITY.md` | `NN-SECURITY.md`: threat model | `/gsd-secure-phase` |
| `AI-SPEC.md` | `NN-AI-SPEC.md`: AI design contract, consumed by `gsd-planner` and `gsd-eval-auditor` | `/gsd-ai-integration-phase` |
| `DEBUG.md` | `.planning/debug/<slug>.md`: active debug session | the debugger references under `gsd-core/references/` |
| `continue-here.md` | `.planning/phases/NN-name/.continue-here.md`: pause-work handoff | `/gsd-pause-work`, `/gsd-resume-work` |

## Research templates

`research-project/` holds the five documents of the project research step, written to `.planning/research/`:

| Template | Produces |
|----------|----------|
| `research-project/STACK.md` | `.planning/research/STACK.md`: recommended technologies for the domain |
| `research-project/FEATURES.md` | `.planning/research/FEATURES.md`: feature landscape |
| `research-project/ARCHITECTURE.md` | `.planning/research/ARCHITECTURE.md`: structure patterns |
| `research-project/PITFALLS.md` | `.planning/research/PITFALLS.md`: common mistakes |
| `research-project/SUMMARY.md` | `.planning/research/SUMMARY.md`: executive summary with roadmap implications |

The first four are loaded by the new-project elaboration step; `SUMMARY.md` is loaded by the `gsd-research-synthesizer` agent and by the new-project and new-milestone workflows.

## Codebase map templates

| Template | Produces | Referenced by |
|----------|----------|-----------|
| `codebase/stack.md` | `.planning/codebase/STACK.md`: the technology foundation | No file names it by template path; the map-codebase and new-project workflows write `.planning/codebase/STACK.md` |
| `codebase/architecture.md` | `.planning/codebase/ARCHITECTURE.md`: conceptual code organization | No file names it by template path; the map-codebase and new-project workflows write `.planning/codebase/ARCHITECTURE.md` |

## Profile and runtime templates

These are not `.planning/` artifacts.

| Template | Produces | Referenced by |
|----------|----------|-----------|
| `user-profile.md` | the developer profile (`USER-PROFILE.md`) | `/gsd-profile-user`; the `gsd-user-profiler` agent; the profile-pipeline capability |
| `dev-preferences.md` | the `dev-preferences` command file that `/gsd-profile-user` generates | `/gsd-profile-user`; the installer; the profile-pipeline capability |
| `copilot-instructions.md` | the GSD block merged into `copilot-instructions.md` between GSD markers (the file is created when absent) | the installer for the Copilot runtime |

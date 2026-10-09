# ADR-5273: Swarm — read-only small-model fan-out with one synthesizer, as a default-off capability

- **Status:** Proposed
- **Date:** 2026-10-09
- **Issue:** [#5273](https://github.com/open-gsd/gsd-core/issues/5273) (`approved-feature`, maintainer verdict Go-with-conditions; this ADR is the first deliverable the verdict requires)
- **Builds on:** [ADR-857](857-capability-system.md) (loop extension points, federated config), [ADR-894](894-capability-declaration-format.md) (manifest format), [ADR-959](959-capability-command-contribution.md) (capability command families), [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (`dispatch.maxConcurrency` and the `dispatch-capacity` query)
- **Reconciles with:** [ADR-1143](1143-claude-orchestration-capability.md) (Workflow-tool backend; still `Proposed`, no dispatch path since its 2026-09-14 amendment) and the open item E of [#4747](https://github.com/open-gsd/gsd-core/issues/4747)
- **Precedents:** #3777 (`planning.chunked_parallel`, gated on `dispatch-capacity`), #4209 (`supportsReviewerLanes`, a step trait with one core interpreter), #853 (backgrounded Claude Code agents cannot nest subagents)

## Context

`plan-phase` dispatches one `gsd-phase-researcher` (`gsd-core/workflows/plan-phase.md`, "Spawn gsd-phase-researcher") and one `gsd-pattern-mapper` (§7.8). The `code-review` skill dispatches one `gsd-code-reviewer` (`gsd-core/workflows/code-review.md`, "Spawn the gsd-code-reviewer agent"). Each agent works through its whole brief serially. The reporter measured two research runs on a large repo at **1144 s / 318k tokens** and **1721 s / 425k tokens**, mostly spent on independent look-ups such as "where is X written" or "which tests pin Y". *These figures are reporter-measured and cannot be reproduced from this repository.*

#5273 proposes a fan-out of small, read-only workers whose structured answers one stronger agent synthesizes into the existing artefact. Five facts in the tree shape the design. Each was measured at `ed0f3fd5`.

1. **The three roles are already capability steps.** `capabilities/research` and `capabilities/pattern-mapper` declare `plan:pre` steps with `ref.agent`. `capabilities/code-review` declares `execute:post` and `execute:wave:post` steps with `ref.skill`. The reference rule *"No two capability steps may produce the same artefact at the same point"* (`docs/reference/capability-manifest.md`, `steps.produces`) means a second capability **cannot** register its own step that produces `RESEARCH.md`, `PATTERNS.md` or `REVIEW.md`.
2. **No host mechanism lets a capability change how an existing step is dispatched.** ADR-1143's 2026-09-14 amendment removed the only attempt, an `execute:wave:pre` contribution into `executor`, and says so directly: *"Wiring it properly needs a host-level mechanism for a capability to alter the orchestrator's own dispatch procedure. That does not exist today."* The maintainer's approval of #4747 left that route (item E) undecided.
3. **`parallelization.max_concurrent_agents` has no reader.** It is documented (`docs/CONFIGURATION.md`, Parallelization Settings, default `3`) and templated (`gsd-core/templates/config.json`). No file in `src/` or `gsd-core/workflows/` reads it. `loadConfig` collapses `parallelization` to a boolean (`src/config-loader.cts`). `config-set parallelization.max_concurrent_agents 4` fails with `Unknown config key`. The live concurrency seam is `gsd_run query dispatch-capacity`, which resolves to 20 on `claude` and to the fail-closed floor `1` on every runtime whose descriptor leaves `maxConcurrency` `undocumented`.
4. **Model routing has a tier, but most spawn sites ignore it.** `resolve-model` returns `{model, profile, effort, tier}`. Under `resolve_model_ids: "omit"` the model is blank and only `tier` carries the routing (#3703, open). Not every runtime can map a Haiku-class tier: `runtimeTierDefaults` in `gsd-core/bin/shared/model-catalog.json` is `null` for `cline`, `kimi`, `kimi-code`, `cursor`, `windsurf` and `zcode`. On `cursor`, `resolve-model` still prints `"haiku"`, so the string alone proves nothing.
5. **`plan-phase.md` is at its cap.** It is 97,857 bytes against the 98,304-byte XL hard cap (`tests/workflow-size-budget.test.cjs`), leaving 447 bytes of headroom. `code-review.md` is 49,961 bytes against the 61,440-byte LARGE cap. Any swarm procedure written into those files does not fit.

## Decision

### 1. Shape: a sibling capability, `capabilities/swarm/`, that reuses one fan-out plan shape

Swarm ships as **`capabilities/swarm/`**, `role: feature`, `tier: full`, `runtimeCompat.supported: ["*"]`, **default-off and BETA**. Its activation key is `swarm.enabled`. It declares **no steps**, so it never produces an artefact. It changes only *how* three existing steps are dispatched, never *whether* they run or *what* they write.

Core gains one policy-free seam, modelled on #4209's `supportsReviewerLanes`:

- **A step trait `supportsFanOut: true`.** It is strict-boolean and step-scoped. It is declared on the `research` and `pattern-mapper` `plan:pre` steps and on both `code-review` steps.
- **A feature-body field `fanOutStrategy: { "command": "<family> <subcommand>" }`.** At most one active capability in the merged registry may declare it, and the validator rejects a second one. Swarm declares `{ "command": "swarm plan" }` against its own ADR-959 command family.
- **A core verb `gsd_run loop fan-out-plan --cap-id <id> --point <point> --phase <n>`.** It resolves the step through `resolveActiveHooksForPoint` (`src/loop-resolver.cts`), checks the trait, and invokes the active strategy's command. It then validates the returned **fan-out plan** against one schema and returns either that plan or `{ "mode": "single", "reason": "<code>" }`. Core holds the schema and the interpreter. Every policy decision lives in the capability: how to decompose a brief, which tier a worker runs on, how many workers to use, and the synthesis rules.

**The fan-out plan is the single mechanism.** It is an ordered list of stages with a barrier between consecutive stages. Each stage is a set of agent dispatches `{ agentType, model, tier, prompt, schema }`. This is the shape `emitWorkflowScript` (`src/claude-orchestration.cts`) already consumes, with waves becoming stages and plans becoming agents. The plan has exactly two executors:

- **Inline.** The host's existing main-loop `Agent()` calls, issued in batches of at most *C* per message (Decision 2). This is the default path on every runtime.
- **Workflow tool.** It is reached **only** through claude-orchestration's gate, and only once #4747 item E wires a dispatch route. Swarm never emits Workflow scripts, and claude-orchestration never grows a second planner.

**Swarm is a sibling, not a mode of claude-orchestration, for three reasons.**

- **Different gates.** Swarm needs main-loop parallel named dispatch and a cheap tier. The Workflow tool is neither necessary nor sufficient for that. claude-orchestration is `runtimeCompat: claude` and gated on a preview tool whose detection #4747 B is rewriting.
- **No working path to inherit.** ADR-1143's own audit records that its end-to-end path has never been exercised, and the capability has no dispatch path today. Making swarm one of its modes would block a working inline feature on an unwired one.
- **The overlap is the plan shape, not the toggle.** #5273 is a fan-out of reads followed by one synthesis, and the Workflow backend could express that. That is exactly why the plan shape is shared and the capability is not.

The `fanOutStrategy` seam is also a candidate answer to #4747 E1 for capability-owned steps. It does **not** decide E1 for `execute-phase` waves, which are the host's own dispatch and not a step.

### 2. Concurrency and size

- **Concurrency.** *C* = min(`dispatch-capacity`, `parallelization.max_concurrent_agents`). Swarm becomes the first reader of `parallelization.max_concurrent_agents`. The implementation registers the key in the central schema manifest, so `config-set` accepts it, and reads it through one accessor in core config. An absent key uses the documented default `3`. A value that is not a positive integer fails closed to single-agent with reason `invalid_max_concurrent_agents`. It is never silently clamped.
- **Workflow size guideline.** Claude Code's `workflowSizeGuideline` defaults to `medium`, which aims for *"fewer than 10 agents"* (code.claude.com/docs/en/workflows, read 2026-10-09; #4747 item 5 quoted 15, and the page has since changed). The guideline is advisory, but the plan validator treats it as a hard bound so that both executors agree: **one role run dispatches at most 9 agents in total**, counting decomposition, workers, any cross-file worker and the synthesizer. `swarm.max_workers` therefore defaults to `6` and is validated to `2..6`.
- **File-size budget.** None of the procedure enters `plan-phase.md` or `code-review.md`. Each of the three spawn sites gains a single `fan-out-plan` call plus a pointer to a lazily read `gsd-core/references/fan-out-dispatch.md`, the sibling of `loop-hook-dispatch.md`. The added bytes carry an `Emitted-Drift-Ack-Growth:` trailer (ADR-3942). If the two sites in `plan-phase.md` cannot fit in 447 bytes, the implementation extracts existing text first. The cap is never raised.

### 3. Workers and synthesizer

- **Workers are a new read-only agent, `gsd-swarm-worker`, owned by the swarm capability.** Its tools are `Read, Grep, Glob`, with no `Write`, `Edit` or `Bash`. For the researcher role only, it also gets the read-only web tools the single-agent researcher already has. Each worker answers one file-scoped question with `file:line` evidence and a verbatim quote, in a fixed JSON schema, under a token cap, and returns the answer. It writes no files. Its model comes from `resolve-model gsd-swarm-worker`, from a new catalog row that is `haiku` in every profile, and the spawn site passes **both** `model` and `tier`, which closes #3703 for this site. A user changes the worker model with the existing `model_overrides.gsd-swarm-worker`.
- **The synthesizer is the role's existing agent.** That is `gsd-phase-researcher`, `gsd-pattern-mapper` or `gsd-code-reviewer`, on its existing resolved model, with its unchanged step fragment and output path, plus a swarm-owned `fragments/synthesize.md` that carries the worker answers and the rules below. It writes the single `RESEARCH.md`, `PATTERNS.md` or `REVIEW.md` in the schema it already owns. Every downstream consumer therefore reads an artefact from the same author with the same contract, and no agent body grows.
- **Re-verification rule.** The synthesizer must `Read` every `file:line` it keeps during its own session. No worker citation reaches the artefact as `[VERIFIED]`. Only the synthesizer may promote a claim, and only after its own `Read`, which is the existing in-repo provenance rule in `agents/gsd-phase-researcher.md`. A claim it cannot confirm is marked `[ASSUMED]` in `RESEARCH.md`, and its excerpt is dropped from `PATTERNS.md`. In `REVIEW.md` the finding is **dropped**, because REVIEW.md has no assumed tier and its counts drive `code-review-fix`.
- **Mechanical floor.** After synthesis, `gsd_run swarm verify-anchors <artefact>` checks deterministically that every cited path exists, that every line range is in bounds, and that every quoted excerpt matches the text at the cited lines. If any anchor is unresolved, the swarm run fails. The role then falls back loudly to single-agent dispatch, whose output overwrites the swarm artefact.
- **Decomposition.** Code-review units come deterministically from the already computed `REVIEW_FILES`, one per file. Research and pattern-mapping units need judgement, so a first stage asks the synthesizer-tier model for a schema-validated question list. Code validates that list: 2 to `max_workers` items, each scoped to files. Fewer than 2 units means single-agent dispatch.

### 4. Cross-file findings

- **Research and pattern-mapping.** The **final synthesizer pass** covers cross-file findings. Their units are look-ups, and integrating answers across files is what synthesis does. The synthesizer may open any file to do it.
- **Code-review.** The worker stage adds **one cross-file worker on the synthesizer's model** whenever the review scope has two or more files. Per-file workers cannot see a defect that spans files, and the synthesizer reads distilled answers rather than code. The synthesizer pass then follows as for the other roles. A one-file scope never fans out.

### 5. Token telemetry

Every swarm-eligible role run appends one entry to `${PHASE_DIR}/${PADDED_PHASE}-SWARM.json` through `gsd_run swarm record`. Runs that fell back to single-agent dispatch are included. The file is committed with the artefact when `commit_docs` is on. An entry holds:

- `{ run_id, role, mode: "swarm" | "single", reason, wall_clock_ms }`
- `dispatches[]` as `{ stage, agentType, model, tier, tokens, duration_ms, usage_source }`
- `tokens_by_model`

`tokens` is the host-reported usage for that dispatch. When the host reports none, `tokens` is `null` with `usage_source: "unreported"`. It is never estimated, and `0` is never written for unknown. When `swarm.enabled` is false, no file is written, so output is byte-identical to today. When ADR-2619 observability is on, the same fields are also emitted as trace events, aligned with that ADR's D2 grain (model tier, durations).

### 6. Runtime gating: degrade to single-agent, loudly

`swarm plan` runs a fail-closed ladder in the style of `detectWorkflowBackend`. Each miss returns `mode: "single"` with a stable reason code.

| Rung | Miss → reason | Loud? |
|---|---|---|
| `swarm.enabled` | `disabled` | No. Config choice; nothing printed or written |
| role in `swarm.roles` | `role_not_selected` | No. Config choice |
| descriptor `dispatch.namedDispatch === true` | `no_named_dispatch` | Yes |
| *C* ≥ 2 (echoes `dispatch-capacity`'s `source`/`reason`) | `no_concurrency` | Yes |
| worker tier maps to a model on this runtime (catalog row, `model_policy.runtime_tiers`, or `model_overrides.gsd-swarm-worker`) and is not `inherit` | `no_worker_tier` | Yes |
| decomposition yields ≥ 2 units | `too_few_units` | Yes |
| first worker `Agent()` returns tool-unavailable (the #853 case, a real error and not self-assessed) | `no_agent_tool` | Yes |
| `verify-anchors` passes and the artefact exists | `anchor_check_failed` / `synthesis_failed` | Yes |

"Loud" means a banner, `◆ Swarm skipped for <role>: <reason> — running single-agent <agent>`, plus a `mode: "single"` telemetry entry. Today only `claude` passes the concurrency rung. Because the ladder reads descriptor data, a runtime that declares `maxConcurrency` joins without any manifest change.

### 7. Configuration

All keys are federated from `capabilities/swarm/capability.json`, so uninstalling the capability removes them.

| Key | Type | Default |
|---|---|---|
| `swarm.enabled` | boolean | `false` |
| `swarm.roles` | string (comma list over `researcher,pattern-mapper,code-reviewer`) | all three |
| `swarm.max_workers` | number, `2..6` | `6` |

The keys use the namespace `swarm.*` rather than the issue's `workflow.swarm.*`. A standalone capability's slice is named after the capability (`claude_orchestration.*`, `external_job.*`, `mempalace.*`), `workflow.*` keys are flat two-segment role toggles, and no key today has the form `workflow.<x>.<y>`.

**No `worker_tier` or `synthesizer_tier` keys.** Model selection already has one owner: the catalog plus `model_overrides.<agent>`. A second channel would conflict with it ([ADR-3473](3473-enforcement-by-construction.md)). The issue's `max_workers` total and the concurrency cap are kept separate on purpose. The total is `swarm.max_workers`. Concurrency stays with the existing parallelization key and the host.

### 8. Equivalence gate (tests-first)

The gate has two layers, because the plan-checker and the verifier are LLM agents and cannot run in CI.

**Layer 1: CI, deterministic, written before the implementation.**

The tests are `tests/swarm.test.cjs` for the ladder and the plan, and `tests/swarm-equivalence.test.cjs`. That stays within the two test files per production module that `scripts/lint-test-file-count.cjs` allows. The fixture phase lives at `tests/fixtures/representative/swarm-equivalence/`. Its `CONTEXT.md`, single-agent artefacts and swarm artefacts come from **real runs**, including a real worker answer carrying a fabricated anchor as the negative fixture. That follows the fixture-provenance rule: a gate's fixtures are never written by the gate's author. Every assertion goes through the CLI or exported functions (TESTING-STANDARDS contract 1). The tests assert that:

- every ladder rung returns its **exact** degraded verdict (contract 6, standing rule);
- the synthesizer dispatch has the same `agentType` and output path as single-agent dispatch;
- `verify-anchors` passes the single-agent fixtures and rejects the fabricated anchor by name;
- the swarm artefacts carry every structure a downstream consumer reads in the single-agent fixture:
  - REVIEW.md frontmatter `status` and `findings.{critical,warning,info,total}`;
  - the RESEARCH.md headings `## Architectural Responsibility Map`, `## Open Questions` and `## Validation Architecture`;
- telemetry `tokens_by_model` sums to its dispatch entries, and unreported usage is `null`.

There are no wall-clock assertions ([ADR-456](456-test-rigor-architecture.md) bans them). Wall-clock time is recorded and not asserted.

**Layer 2: live, a merge condition of the enabling PR.**

The fixture phase is planned on Claude Code twice, with `swarm.enabled` off and then on. Both plans must reach `## VERIFICATION PASSED` from `gsd-plan-checker` and `status: passed` from `gsd-verifier` after execution. The swarm `REVIEW.md` must flow through `code-review-fix` unchanged. The PR attaches both runs' artefacts, verdicts and `SWARM.json`. This is deliberately a merge condition and not a later ratification bar. ADR-1143 set its end-to-end bar as a ratification step, and that bar was never met.

## Alternatives considered

- **Swarm as a mode of claude-orchestration** (`claude_orchestration.swarm.*`). Rejected; see Decision 1.
- **A new swarm step at `plan:pre` producing `RESEARCH.md`.** This is invalid by the uniqueness rule in `produces`, and it would duplicate the role's schema in a second agent.
- **New worker and synthesizer agents per role.** That means six agents, the roster ripple twice over, and a second writer of each schema. Reusing the role agent as synthesizer is what keeps downstream gates unchanged.
- **Core orchestration (Lens A).** The maintainer and the triage rejected this. Core receives only the trait, the field, one verb and the plan schema.
- **A contribution into the role agents that tells them to fan out themselves.** A dispatched agent fanning out is the #853 failure on Claude Code, and it repeats the role-partition error #4740 corrected (an agent cannot orchestrate).
- **`worker_tier` / `synthesizer_tier` config keys.** Rejected; see Decision 7.

## Consequences

- **Positive.** Workers spread across concurrent dispatches, and most tokens move to the cheap tier. Both are claims to be measured by telemetry, not assumed. #3703 closes at the three new sites. `parallelization.max_concurrent_agents` stops being a documented knob that nothing reads. The fan-out seam gives #4747 E1 a candidate shape.
- **Negative and forever-cost.**
  - A new core manifest field, step trait, verb and plan schema to maintain, plus validator and registry changes.
  - One new agent, with roster, inventory and capability-matrix ripples.
  - A synthesis fragment that must track three role schemas: when a role's output schema changes, `fragments/synthesize.md` and the Layer 1 structural assertions change in the same PR.
  - Haiku-class workers will cite anchors that do not exist. `verify-anchors` and the re-verification rule are the product, not an add-on, and a failed check costs a full single-agent rerun.
  - The orchestrator's context grows by up to `max_workers` capped answers per run.
- **Neutral.** With `swarm.enabled: false`, behaviour and artefacts are byte-identical to today, and no file is written.

## Implementation plan

Each step is one PR.

1. **Tests-first.** Add the fixture phase and both test files. The cases that need step 3 are `todo`-marked and listed in the PR.
2. **Core seam.** Add the `supportsFanOut` trait, the `fanOutStrategy` field with its validator, the `loop fan-out-plan` verb, the plan schema and `gsd-core/references/fan-out-dispatch.md`. Register `parallelization.max_concurrent_agents` with its accessor. The ADR-894 back-link (`Amended by`) lands here.
3. **Swarm capability.** Add the manifest, the `gsd-swarm-worker` agent and catalog row, `swarm plan|record|verify-anchors`, `fragments/synthesize.md`, the opt-in traits on the three role steps, docs (`docs/CONFIGURATION.md`, a how-to, inventory and capability matrix) and a changeset. Layer 1 turns fully green.
4. **Wire the spawn sites** in `plan-phase.md` (two sites) and `code-review.md` (one site), with acks for the growth. This PR carries the Layer 2 evidence.
5. **Optional, gated on #4747 E.** Route the fan-out plan through the Workflow executor.

## Open questions for the maintainer

1. Should `fanOutStrategy` be added now as the generic seam (recommended), or should the first cut hard-wire swarm's verb and generalize later?
2. Should `swarm.max_workers` be bounded at 6, so that a run fits `medium` (fewer than 10 agents)? Or should it read the user's `workflowSizeGuideline` where Claude Code exposes it? No GSD seam reads that setting today.
3. On a failed anchor check, the run falls back to a single-agent rerun. Is the rerun's cost acceptable, or should swarm instead keep its artefact with the unresolved claims removed?
4. This PR is ADR-only, but `auto-close-unsolicited-prs.yml` requires a closing keyword, so it says `Closes #5273`. Should #5273 be reopened after merge to track steps 1 to 4, or should those steps get their own sub-issues?

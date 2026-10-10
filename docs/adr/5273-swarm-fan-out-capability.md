# ADR-5273: Swarm — read-only small-model fan-out with one synthesizer, as a default-off capability

- **Status:** Proposed
- **Date:** 2026-10-09 (revised 2026-10-10: concurrency cap, token-usage provenance, implementation plan; swarm sizing; step 3 decisions)
- **Issue:** [#5273](https://github.com/open-gsd/gsd-core/issues/5273) (`approved-feature`, maintainer verdict Go-with-conditions; this ADR is the first deliverable the verdict requires)
- **Amends:** [ADR-894](894-capability-declaration-format.md) — adds the `supportsFanOut` step trait and the `fanOutStrategy` feature-body field to the declaration format (in force only once this ADR is accepted)
- **Builds on:** [ADR-857](857-capability-system.md) (loop extension points, federated config), [ADR-959](959-capability-command-contribution.md) (capability command families), [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (`dispatch.maxConcurrency` and the `dispatch-capacity` query), [ADR-2782](2782-reviewer-lane-capability-surface.md) (the `supportsReviewerLanes` trait and its untrusted-evidence contract), [ADR-4650](4650-path-containment-and-filename-classification-seam.md) (the path-containment predicate)
- **Reconciles with:** [ADR-1143](1143-claude-orchestration-capability.md) (Workflow-tool backend; still `Proposed`, no dispatch path since its 2026-09-14 amendment) and the open item E of [#4747](https://github.com/open-gsd/gsd-core/issues/4747)
- **Precedents:** #3777 (`planning.chunked_parallel`, gated on `dispatch-capacity`), #4209 (`supportsReviewerLanes`, a step trait with one core interpreter, recorded in [ADR-2782](2782-reviewer-lane-capability-surface.md)), #853 (backgrounded Claude Code agents cannot nest subagents)

Swarm is a default-off capability, `capabilities/swarm/`, that changes how three existing steps are dispatched: research and pattern-mapping in `plan-phase`, and code review. Read-only Haiku-class workers answer file-scoped questions in parallel, and the role's existing agent synthesizes their answers into the unchanged `RESEARCH.md`, `PATTERNS.md` or `REVIEW.md` after re-reading every anchor it keeps. Core gains one policy-free seam (a step trait, one registry field, one verb and one plan schema), and a role run dispatches at most `max_workers` + 3 agents, fallback included, with `max_workers` defaulting to 20 and uncapped. Worker output is untrusted data, every path is contained to the project root, and the run records its token split by model. The fan-out plan is the one description of what to dispatch: the inline executor runs it today, and the Workflow backend reaches it only through a single renderer that step 5 builds by refactoring `emitWorkflowScript`.

## Context

`plan-phase` dispatches one `gsd-phase-researcher` (`gsd-core/workflows/plan-phase.md`, "Spawn gsd-phase-researcher") and one `gsd-pattern-mapper` (§7.8). The `code-review` skill dispatches one `gsd-code-reviewer` (`gsd-core/workflows/code-review.md`, "Spawn the gsd-code-reviewer agent"). Each agent works through its whole brief serially. The reporter measured two research runs on a large repo at **1144 s / 318k tokens** and **1721 s / 425k tokens**, mostly spent on independent look-ups such as "where is X written" or "which tests pin Y". *These figures are reporter-measured and cannot be reproduced from this repository.*

#5273 proposes a fan-out of small, read-only workers whose structured answers one stronger agent synthesizes into the existing artefact. Five facts in the tree shape the design. Each was measured at `ed0f3fd5` and re-checked, unchanged, at `5d987ccf6`.

1. **The three roles are already capability steps.** `capabilities/research` and `capabilities/pattern-mapper` declare `plan:pre` steps with `ref.agent`. `capabilities/code-review` declares `execute:post` and `execute:wave:post` steps with `ref.skill`. The reference rule *"No two capability steps may produce the same artefact at the same point"* (`docs/reference/capability-manifest.md`, `steps.produces`) means a second capability **cannot** register its own step that produces `RESEARCH.md`, `PATTERNS.md` or `REVIEW.md`.
2. **No host mechanism lets a capability change how an existing step is dispatched.** The 2026-09-14 amendment of [ADR-1143](1143-claude-orchestration-capability.md) removed the only attempt, an `execute:wave:pre` contribution into `executor`, and says so directly: *"Wiring it properly needs a host-level mechanism for a capability to alter the orchestrator's own dispatch procedure. That does not exist today."* The maintainer's approval of #4747 left that route (item E) undecided.
3. **`parallelization.max_concurrent_agents` has no reader.** It is documented (`docs/CONFIGURATION.md`, Parallelization Settings, default `3`) and templated (`gsd-core/templates/config.json`). No file in `src/` or `gsd-core/workflows/` reads it. `loadConfig` collapses `parallelization` to a boolean (`src/config-loader.cts`). `config-set parallelization.max_concurrent_agents 4` fails with `Unknown config key`. The live concurrency seam is `gsd_run query dispatch-capacity`, which resolves to 20 on `claude` and to the fail-closed floor `1` on every runtime whose descriptor leaves `maxConcurrency` `undocumented`.
4. **Model routing has a tier, but most spawn sites ignore it.** `resolve-model` returns `{model, profile, effort, tier}`. Under `resolve_model_ids: "omit"` the model is blank and only `tier` carries the routing (#3703, open). Not every runtime can map a Haiku-class tier: every runtime whose `runtimeTierDefaults` entry in `gsd-core/bin/shared/model-catalog.json` is `null` has no catalog mapping for any tier. At `5d987ccf6` that is ten runtimes: `cline`, `kimi`, `kimi-code`, `cursor`, `windsurf`, `zcode`, `augment`, `trae`, `codebuddy` and `antigravity`. The ladder (Decision 6) tests the rule, not this list. On `cursor`, `resolve-model` still prints `"haiku"`, so the string alone proves nothing.
5. **`plan-phase.md` is at its cap.** It is 97,857 bytes against the 98,304-byte XL hard cap (`tests/workflow-size-budget.test.cjs`), leaving 447 bytes of headroom. `code-review.md` is 49,961 bytes against the 61,440-byte LARGE cap. Any swarm procedure written into those files does not fit.

## Decision

### 1. Shape: a sibling capability, `capabilities/swarm/`, with one fan-out plan

Swarm ships as **`capabilities/swarm/`**, `role: feature`, `tier: full`, `runtimeCompat.supported: ["*"]`, **default-off and BETA**. Its activation key is `swarm.enabled`. It declares **no steps** and **no contributions**, so it never produces an artefact. It changes only *how* three existing steps are dispatched, never *whether* they run or *what* they write.

Core gains one policy-free seam, modelled on #4209's `supportsReviewerLanes` ([ADR-2782](2782-reviewer-lane-capability-surface.md)):

- **A step trait `supportsFanOut: true`.** It is strict-boolean and step-scoped. It is declared on the `research` and `pattern-mapper` `plan:pre` steps and on both `code-review` steps.
- **A feature-body field `fanOutStrategy: { "command": "<family> <subcommand>" }`.** At most one active capability in the merged registry may declare it, and the validator rejects a second one. Swarm declares `{ "command": "swarm plan" }` against its own [ADR-959](959-capability-command-contribution.md) command family.
- **A core verb `gsd_run loop fan-out-plan --cap-id <id> --point <point> --agent <agent> --phase <n> [--stage decompose|fan-out] [--units <file>] [--scope-file <file>]`.** `--agent` names the agent the site would dispatch single-agent; it is the only allowed synthesizer, and it must match the step's own `ref.agent` when the step declares one. It resolves the step through `resolveActiveHooksForPoint` (`src/loop-resolver.cts`), checks the trait, and invokes the active strategy's command. It then validates the returned **fan-out plan** (Decision 9) and returns either that plan or `{ "mode": "single", "reason": "<code>" }`. Core holds the schema, the validator and the interpreter. Every policy decision lives in the capability: how to decompose a brief, which tier a worker runs on, how many workers to use, and the synthesis rules.

**The fan-out plan is the single description of a fan-out.** It is an ordered list of stages with a barrier between consecutive stages. Each stage is a set of agent dispatches `{ agentType, model, tier, prompt, schema }`.

**What the Workflow backend consumes today.** `emitWorkflowScript` (`src/claude-orchestration.cts`) does **not** consume this shape. Its input is `{ phaseDir, waves, runId, executorModel, budgetTokens }`. Each wave holds `{ id, brief, files_modified, use_worktree }` plans, and every plan is dispatched as `gsd-executor` on the one resolved executor model. Stages are derived from file overlap by `partitionStages`, isolation is per-plan worktrees, and results are read back as `<worktree_metadata>`. It has no per-dispatch agent type, model, tier, prompt or result schema. An earlier draft of this ADR said the emitter "already consumes" the plan shape. That was wrong.

**How the two are reconciled into one mechanism.** This is a commitment about implementation step 5, not a claim about today:

- **One schema and one renderer.** Step 5 refactors `emitWorkflowScript` into a pure adapter, `wavesToFanOutPlan`, and a single emitter, `renderFanOutPlan`. The adapter maps each wave's `partitionStages` output to stages and each plan to a `gsd-executor` dispatch. The plan schema gains the two executor-only optional fields that mapping needs: `isolation: "worktree"` and the `<worktree_metadata>` result contract. The existing `emitWorkflowScript` tests pin the refactor byte for byte, so execute-phase's Workflow output does not change.
- **Planning stays with the owner of the work.** Swarm plans read-only fan-outs, and execute-phase plans waves. The renderer and claude-orchestration decide nothing about what to dispatch, so claude-orchestration never grows a second planner.
- **Swarm plans never use the executor-only fields.** The validator rejects them on a plan returned by a `fanOutStrategy` command (Decision 9).
- **Until step 5 lands, the inline executor is the only executor.** Swarm does not wait for the Workflow route, and it never emits Workflow scripts itself.

The plan therefore has exactly two executors:

- **Inline.** The host's existing main-loop `Agent()` calls, issued in batches of at most *C* per message (Decision 2). This is the default path on every runtime.
- **Workflow tool.** It is reached **only** through claude-orchestration's gate, **only** once #4747 item E wires a dispatch route, and **only** through `renderFanOutPlan` from step 5.

**Swarm is a sibling, not a mode of claude-orchestration, for three reasons.**

- **Different gates.** Swarm needs main-loop parallel named dispatch and a cheap tier. The Workflow tool is neither necessary nor sufficient for that. claude-orchestration is `runtimeCompat: claude` and gated on a preview tool whose detection #4747 B is rewriting.
- **No working path to inherit.** The audit in [ADR-1143](1143-claude-orchestration-capability.md) records that its end-to-end path has never been exercised, and the capability has no dispatch path today. Making swarm one of its modes would block a working inline feature on an unwired one.
- **The overlap is the plan and its renderer, not the toggle.** #5273 is a fan-out of reads followed by one synthesis, and the Workflow backend could express that. That is why the plan schema and the renderer are shared and the capability is not.

The `fanOutStrategy` seam is also a candidate answer to #4747 E1 for capability-owned steps. It does **not** decide E1 for `execute-phase` waves, which are the host's own dispatch and not a step.

### 2. Concurrency, agent budget and size

- **A swarm, not a handful.** The design point is many weak workers that each look at a very small part, in parallel, in place of one strong agent that reads everything itself. The sizing below follows from that founder decision (2026-10-10). It is a decision, not a measurement: Layer 2 (Decision 8) is where the claim that it is faster and cheaper gets measured.
- **Concurrency.** *C* = min(`dispatch-capacity`, `swarm.max_concurrency`, `swarm.max_workers`). Each term has one owner: the host's ceiling (`dispatch-capacity`, the seam #3777 gates on, 20 on `claude`), swarm's own parallelism (`swarm.max_concurrency`, default `20`), and swarm's fan-out width (`swarm.max_workers`). The third term only matters when `max_concurrency` is set above `max_workers`. Workers run in waves of at most *C* per message, so 50 workers at *C* = 20 take three waves.
  - **Swarm does not read `parallelization.max_concurrent_agents`.** An earlier revision made swarm its first reader. That was reversed: the key defaults to `3`, the template writes `3` into every existing `config.json`, and a swarm throttled to three at a time is not a swarm. The key stays unread, as before this ADR. Giving it a reader is execute-phase's business and out of scope here.
  - **Core never reads a swarm-owned key.** The strategy reads `swarm.max_workers` and `swarm.max_concurrency`, validates them, and writes them into the plan as `maxWorkers` and `maxConcurrency`. Core validates the plan's values and computes *C* from them. An invalid config value is the strategy's to report, with its own reason code.
- **Agent budget.** There is no fixed agent ceiling. One role run dispatches at most `max_workers` + 3 agents, and every dispatch counts, including the single-agent fallback rerun:

  | Role | Decomposition | Workers | Cross-file worker | Synthesizer | Reserved fallback | Maximum |
  |---|---|---|---|---|---|---|
  | research, pattern-mapping | 1 | ≤ `max_workers` | 0 | 1 | 1 | `max_workers` + 3 |
  | code-review | 0 | ≤ `max_workers` | 1 | 1 | 1 | `max_workers` + 3 |

  `swarm.max_workers` defaults to `20`, must be an integer of at least `2`, and has **no upper bound**: a user who sets 200 gets 200. Code-review units never exceed `max_workers`, because Decision 3 groups files. The validator rejects any plan whose dispatches, plus a prior decomposition and the reserved fallback, exceed `maxWorkers` + 3, with reason `over_agent_budget` (Decision 6). That rung guards against a defective strategy and is not a normal path.
  - An earlier revision bounded a run at 9 agents, citing Claude Code's `workflowSizeGuideline` default (*"fewer than 10 agents"*). That guideline governs the Workflow tool, not main-loop `Agent()` calls, which is how the inline executor dispatches. It applies to swarm only through step 5's renderer, which accepts a plan of any size; a user who routes swarm through the Workflow tool raises `workflowSizeGuideline` to fit (founder decision 2026-10-10), and the docs say so.
- **File-size budget.** None of the procedure enters `plan-phase.md` or `code-review.md`. Each of the three spawn sites gains a single `fan-out-plan` call plus a pointer to a lazily read `gsd-core/references/fan-out-dispatch.md`, the sibling of `loop-hook-dispatch.md`. The added bytes carry an `Emitted-Drift-Ack-Growth:` trailer ([ADR-3942](3942-emitted-drift-ack-commit-trailer.md)). If the two sites in `plan-phase.md` cannot fit in 447 bytes, the implementation extracts existing text first. The cap is never raised.

### 3. Workers and synthesizer

- **Workers are a new read-only agent, `gsd-swarm-worker`, owned by the swarm capability.** Its tools are `Read, Grep, Glob`, with no `Write`, `Edit` or `Bash`. It has **no web tools**, in any role (founder decision 2026-10-10): an agent's tools are fixed in its frontmatter, so "web only for research" would need a second agent, and a worker looks at a small part of the codebase. Web research stays with the researcher, who runs as the synthesizer and already holds those tools. Each worker answers one file-scoped question with `file:line` evidence and a verbatim quote, in a fixed JSON schema, and returns the answer. A worker run has **no token cap** (founder decision 2026-10-10): the unit is meant to be small, and the 4 KiB answer cap (Decision 9) bounds what it can hand on. It writes no files, so workers run on the shared working tree with no isolation primitive: no worktree, no lock, no copy. Its model comes from `resolve-model gsd-swarm-worker`, from a new catalog row that is `haiku` (Haiku 5.5 at the time of writing) in every profile, and the worker spawn site passes **both** `model` and `tier`. That makes the new worker sites honour `tier`. It does not close #3703, which is about the existing spawn sites, and the synthesizer spawn keeps today's behaviour there. A user changes the worker model with the existing `model_overrides.gsd-swarm-worker`.
- **The synthesizer is the role's existing agent.** That is `gsd-phase-researcher`, `gsd-pattern-mapper` or `gsd-code-reviewer`, on its existing resolved model, with its unchanged step prompt and output path. It writes the single `RESEARCH.md`, `PATTERNS.md` or `REVIEW.md` in the schema it already owns. Every downstream consumer therefore reads an artefact from the same author with the same contract, and no agent body grows.
- **How the synthesis rules reach the synthesizer.** The rules live in a swarm-owned `fragments/synthesize.md`. The fragment is **not** a loop contribution, and swarm declares no `contributions[]`. The strategy appends the fragment's text to the synthesizer dispatch's `prompt` in the fan-out plan, and the executor fills the plan's answer slot with the previous stage's validated worker answers (Decision 9). The rules therefore reach the synthesizer only on a swarm run, and nothing acts as a host-behaviour directive, which the 2026-09-14 amendment of [ADR-1143](1143-claude-orchestration-capability.md) forbids.
- **Re-verification rule.** The synthesizer must `Read` every `file:line` it keeps during its own session. No worker citation reaches the artefact as `[VERIFIED]`. Only the synthesizer may promote a claim, and only after its own `Read`, which is the existing in-repo provenance rule in `agents/gsd-phase-researcher.md`. A claim it cannot confirm is marked `[ASSUMED]` in `RESEARCH.md`, and its excerpt is dropped from `PATTERNS.md`. In `REVIEW.md` the finding is **dropped**, because REVIEW.md has no assumed tier and its counts drive `code-review-fix`.
- **Mechanical floor.** After synthesis, `gsd_run swarm verify-anchors <artefact> --prune` checks deterministically that every cited path exists inside the project root, that every line range is in bounds, and that every quoted excerpt matches the text at the cited lines. Decision 9 sets its containment and read bounds.
  - **An unresolved anchor removes its claim, not the run** (founder decision 2026-10-10). `--prune` deletes the whole claim unit that carries the anchor: in `RESEARCH.md` and `PATTERNS.md` the list item, table row or excerpt block, and in `REVIEW.md` the whole finding block, with the frontmatter `findings` counts recomputed from what remains. Each removal is loud: a banner names the count, the artefact gains a closing `## Swarm: removed unverified claims` section listing each removed anchor and its reason code, and `SWARM.json` records the same list.
  - **Pruning that cannot be done cleanly falls back.** When a failing anchor's claim unit cannot be located unambiguously in the artefact's schema, or when pruning would leave a required heading (Decision 8's structural list) empty, the swarm run fails with `anchor_check_failed`, and the role falls back loudly to single-agent dispatch, whose output overwrites the swarm artefact.
- **Decomposition, code-review.** Units come deterministically from the already computed `REVIEW_FILES`, which the spawn site writes one path per line to a file and passes as `--scope-file`. Core checks the file exists and forwards it to the strategy unread; unlike `--units` it books no decomposition dispatch. One file never fans out. From 2 to `max_workers` files, each file is one unit. Above `max_workers` files, the files are split in `REVIEW_FILES` order into `max_workers` contiguous groups whose sizes differ by at most one. No file is dropped and none is reviewed twice.
- **Decomposition, research and pattern-mapping.** These units need judgement, so the role calls `loop fan-out-plan` twice:
  1. `--stage decompose` returns a one-stage plan with one dispatch, `gsd-swarm-worker` on the role agent's resolved model and tier, so the decomposition runs on the strong model: a poor split makes the whole swarm worthless. Its prompt asks for the smallest independent units and aims to use all of `max_workers`; a swarm of many very small units is the design point, not a ceiling to stay under. Its result schema is `{ "units": [ { "question": string, "scope": [path, ...] } ] }`.
  2. `--stage fan-out --units <file>` passes that result back. The strategy builds the worker and synthesizer stages from it, and core validates the plan, including every unit's scope (Decision 9). The decomposition dispatch counts against this call's agent budget.

  Fewer than 2 valid units means single-agent dispatch with reason `too_few_units`.

### 4. Cross-file findings

- **Research and pattern-mapping.** The **final synthesizer pass** covers cross-file findings. Their units are look-ups, and integrating answers across files is what synthesis does. The synthesizer may open any file inside the project root to do it.
- **Code-review.** The worker stage adds **one cross-file worker** whenever the review scope has two or more files. It is a `gsd-swarm-worker` dispatch on the synthesizer's resolved model and tier, scoped to the whole review scope. Per-file workers cannot see a defect that spans files, and the synthesizer reads distilled answers rather than code. The synthesizer pass then follows as for the other roles. The cross-file worker counts against the agent budget (Decision 2).

### 5. Token telemetry

Every swarm-eligible role run appends one entry to `${PHASE_DIR}/${PADDED_PHASE}-SWARM.json` through `gsd_run swarm record`. Runs that fell back to single-agent dispatch are included. The file is committed with the artefact when `commit_docs` is on. An entry holds:

- `{ run_id, role, mode: "swarm" | "single", reason, wall_clock_ms }`
- `dispatches[]` as `{ stage, agentType, model, tier, tokens, duration_ms, usage_source }`
- `tokens_by_model`

`tokens` is the host-reported usage for that dispatch, with `usage_source: "host"`. When the host reports none, `tokens` is `null`, and `0` is never written for unknown. Interactive Claude Code sessions do not expose exact per-dispatch, per-model totals, so a dispatch with no host figure may instead carry `estimated_tokens` with `usage_source: "estimate_chars_div_4"`: the dispatch's prompt plus its returned text, in characters, divided by 4. An estimate is never written into `tokens`, and never summed with host figures. The entry carries two maps, `tokens_by_model` (host figures only) and `estimated_tokens_by_model` (estimates only), so no reader can mistake one for the other. The Layer 2 acceptance runs (Decision 8) are headless, and their figures must all be `usage_source: "host"`; an estimate there fails the evidence. When `swarm.enabled` is false, no file is written, so output is byte-identical to today. When [ADR-2619](2619-observability-shareable-diagnostics.md) observability is on, the same fields are also emitted as trace events, aligned with that ADR's D2 grain (model tier, durations).

### 6. Runtime gating: degrade to single-agent, loudly

The ladder runs fail-closed, in the style of `detectWorkflowBackend`, in two phases. **Plan-time** rungs are evaluated by `swarm plan` and core's validator before `loop fan-out-plan` returns. Each miss returns `mode: "single"` with a stable reason code, and the role dispatches its single agent as today. Core evaluates its own rungs after the strategy has answered, so a user who never enabled swarm sees nothing, and it validates the plan before computing *C*, because *C*'s third term is the plan's own `maxWorkers`. `gsd-core/references/fan-out-dispatch.md` lists the rungs in the order the verb checks them. **Run-time** rungs are observed by the executor after a plan has returned. Each miss abandons the swarm run and uses the reserved fallback dispatch (Decision 2) to run the single agent.

**Plan-time rungs**

| Rung | Miss → reason | Loud? |
|---|---|---|
| `swarm.enabled` | `disabled` | No. Config choice; nothing printed or written |
| role in `swarm.roles` | `role_not_selected` | No. Config choice |
| `parallelization` (the boolean `loadConfig` collapses it to, including the documented `parallelization: false` shorthand) is true | `parallelization_disabled` | Yes. Swarm is on but parallel dispatch is off |
| descriptor `dispatch.namedDispatch === true` | `no_named_dispatch` | Yes |
| *C* ≥ 2 (echoes `dispatch-capacity`'s `source`/`reason`); evaluated after plan validation, since two of its terms come from the plan | `no_concurrency` | Yes |
| worker tier maps to a model on this runtime (catalog row, `model_policy.runtime_tiers`, or `model_overrides.gsd-swarm-worker`) and is not `inherit` | `no_worker_tier` | Yes |
| the strategy's plan passes core validation (Decision 9) | `invalid_plan` | Yes |
| prior and planned dispatches plus the reserved fallback are ≤ `maxWorkers` + 3 | `over_agent_budget` | Yes |
| decomposition yields ≥ 2 valid units (evaluated in the `--stage fan-out` call) | `too_few_units` | Yes |

**Run-time rungs**

| Rung | Miss → reason | Loud? |
|---|---|---|
| first worker `Agent()` does not return tool-unavailable (the #853 case, a real error and not self-assessed) | `no_agent_tool` | Yes |
| the synthesizer wrote the artefact | `synthesis_failed` | Yes |
| at most 25 % of worker answers were dropped (Decision 9: over 4 KiB, not JSON, or failing its schema) | `too_many_dropped_answers` | Yes |
| `verify-anchors --prune` resolves or cleanly prunes every anchor | `anchor_check_failed` | Yes |

"Loud" means a banner, `◆ Swarm skipped for <role>: <reason> — running single-agent <agent>`, plus a `mode: "single"` telemetry entry. Today only `claude` passes the concurrency rung. Because the ladder reads descriptor and catalog data, a runtime needs no swarm manifest change to join: it passes once its descriptor declares `maxConcurrency` and a Haiku-class tier maps to a model for it, from the catalog, `model_policy.runtime_tiers` or `model_overrides`.

### 7. Configuration

All keys are federated from `capabilities/swarm/capability.json`, so uninstalling the capability removes them.

| Key | Type | Default |
|---|---|---|
| `swarm.enabled` | boolean | `false` |
| `swarm.roles` | string (comma list over `researcher,pattern-mapper,code-reviewer`) | all three |
| `swarm.max_workers` | integer, `≥ 2`, no upper bound | `20` |
| `swarm.max_concurrency` | integer, `≥ 1` | `20` |

The keys use the namespace `swarm.*` rather than the issue's `workflow.swarm.*`. A standalone capability's slice is named after the capability (`claude_orchestration.*`, `external_job.*`, `mempalace.*`), `workflow.*` keys are flat two-segment role toggles, and no key today has the form `workflow.<x>.<y>`.

**No `worker_tier` or `synthesizer_tier` keys.** Model selection already has one owner: the catalog plus `model_overrides.<agent>`. A second channel would conflict with it ([ADR-3473](3473-enforcement-by-construction.md)). The issue's `max_workers` total and the concurrency cap are kept separate on purpose. The total is `swarm.max_workers`, and concurrency is `swarm.max_concurrency`, capped by the host's `dispatch-capacity`.

### 8. Equivalence gate (tests-first)

The gate has two layers, because the plan-checker and the verifier are LLM agents and cannot run in CI.

**Layer 1: CI, deterministic, landing in the same PR as the code it tests.**

An earlier draft wrote these tests first, in a PR of their own, with the cases that need unwritten code marked `todo`. That cannot work in this repository: `gsd-test` recognizes only `pass` and `fail`, so a `todo` test whose body throws counts as a real failure and blocks the push gate (`tests/fixtures/representative/README.md`, "Why the still-broken fixtures assert `currentBuggyOutput`"). Each case therefore lands with the step that makes it pass (see the implementation plan), and is written before that step's code inside the PR.

The tests are `tests/swarm.test.cjs` for the ladder, the plan validator and `verify-anchors`, and `tests/swarm-equivalence.test.cjs`. That stays within the two test files per production module that `scripts/lint-test-file-count.cjs` allows. The fixture phase lives at `tests/fixtures/representative/swarm-equivalence/`. Its `CONTEXT.md`, single-agent artefacts and swarm artefacts come from **real runs**, including a real worker answer carrying a fabricated anchor as the negative fixture. That follows the fixture-provenance rule: a gate's fixtures are never written by the gate's author. Every assertion goes through the CLI or exported functions (TESTING-STANDARDS contract 1). The tests assert that:

- every ladder rung returns its **exact** degraded verdict (contract 6, standing rule), in its phase (plan-time or run-time);
- the synthesizer dispatch has the same `agentType` and output path as single-agent dispatch;
- `verify-anchors` passes the single-agent fixtures and rejects the fabricated anchor by name;
- the swarm artefacts carry every structure a downstream consumer reads in the single-agent fixture:
  - REVIEW.md frontmatter `status` and `findings.{critical,warning,info,total}`;
  - the RESEARCH.md headings `## Architectural Responsibility Map`, `## Open Questions` and `## Validation Architecture`;
- telemetry `tokens_by_model` sums exactly the `usage_source: "host"` entries, `estimated_tokens_by_model` sums exactly the estimate entries, no entry carries both `tokens` and `estimated_tokens`, and unreported usage is `null`;
- **boundaries**, each at limit−1, limit and limit+1:
  - `maxWorkers` 1, 2, 20 and 200 (1 rejected, the rest accepted: there is no upper bound);
  - the agent total `maxWorkers` + 2, + 3 and + 4 (the last rejected as `over_agent_budget`);
  - code-review file counts 1, 2, `max_workers` and `max_workers` + 1 (1 runs single, 2 and `max_workers` give one unit per file, `max_workers` + 1 is grouped into `max_workers` units with every file kept once);
  - decomposition unit counts 1, 2, `max_workers` and `max_workers`+1 (1 is `too_few_units`, the last is `invalid_plan`);
  - *C* at 1 and 2 from each of its three terms (1 is `no_concurrency`, whichever term set it);
  - a worker answer at 4 KiB and at 4 KiB + 1 (the second is dropped and counted);
  - dropped answers out of 20 at 5 and 6 (25 % passes, 30 % is `too_many_dropped_answers`);
- **pruning**: `verify-anchors --prune` removes exactly the claim unit around a fabricated anchor in each of the three artefact schemas, recomputes `REVIEW.md`'s `findings` counts, lists every removal, and returns `anchor_check_failed` when the unit cannot be located or a required heading would be left empty;
- **properties** (`fast-check`): the `verify-anchors` parser never throws on arbitrary artefact text and every anchor it reports round-trips; the plan validator accepts every plan built from valid parts and rejects every plan carrying one invalid part (Decision 9);
- **line endings**: an anchor into a CRLF file matches its excerpt, because excerpt comparison normalizes line endings on both sides;
- **hostile input** (`CONTRIBUTING.md`, "Security and prompt-injection surfaces"): anchors and scopes using `..`, an absolute path, a symlink that escapes the root, or a control character are rejected with no read outside the root; a worker answer carrying a fake instruction tag reaches the synthesizer prompt only JSON-encoded inside the `<swarm_worker_answers>` block.

The `plan-phase.md` headroom needs no new row. `tests/workflow-size-budget.test.cjs` already fails at cap+1, and step 4 must pass it unchanged. There are no wall-clock assertions ([ADR-456](456-test-rigor-architecture.md) bans them). Wall-clock time is recorded and not asserted.

**Layer 2: live, a merge condition of the enabling PR.**

The fixture phase is planned on Claude Code twice, with `swarm.enabled` off and then on. Both plans must reach `## VERIFICATION PASSED` from `gsd-plan-checker` and `status: passed` from `gsd-verifier` after execution. The swarm `REVIEW.md` must flow through `code-review-fix` unchanged. The PR attaches both runs' artefacts, verdicts and `SWARM.json`.

The PR also records, per role, the wall-clock time of both runs. The swarm-on figure is `wall_clock_ms` from `SWARM.json`, which includes any fallback rerun. The swarm-off figure is the host-reported duration of the single role agent's dispatch, because a swarm-off run writes no `SWARM.json` by design (Decision 5). The issue's acceptance, *"lower wall-clock time"*, is met only if the swarm-on figure is lower for every role that fanned out. This comparison is evidence in the PR, not a CI assertion.

This is deliberately a merge condition and not a later ratification bar. [ADR-1143](1143-claude-orchestration-capability.md) set its end-to-end bar as a ratification step, and that bar was never met.

### 9. Trust boundaries and hostile input

Swarm reads paths written by models and passes model output to an agent that holds `Write`, and for two roles `Bash`. It reuses the repository's existing contracts for both, and adds no new kind of trust.

- **Path containment.** Every path swarm opens or forwards goes through the [ADR-4650](4650-path-containment-and-filename-classification-seam.md) predicate, with the two halves `validatePaths` in `src/reviewer-step-dispatch.cts` already applies. That covers anchors in `verify-anchors`, unit scopes in a plan, and the code-review groups. Absolute paths, any `..` segment and control characters are rejected lexically. The real path must stay inside the real project root, so a symlink that escapes is rejected. Only regular files are read, each read is bounded in bytes, and an artefact may cite a bounded number of anchors. `verify-anchors` reports only `pass` or `fail` with a reason code per anchor. It never echoes file content, so it is not a read oracle.
- **Worker output is untrusted data.** Each worker answer is validated against its JSON schema and capped at **4 KiB** (`answerMaxBytes` in the verdict) before it is passed on. An answer over the cap is dropped, not truncated: a truncated answer could cut an anchor or a quote in half. Core owns the check as `checkWorkerAnswer` beside `ANSWER_MAX_BYTES`, so the executor and the Layer 1 boundary use one predicate. An answer that fails is dropped and counted in telemetry. The synthesizer receives the answers JSON-encoded inside a `<swarm_worker_answers>` block, under the same contract `agents/gsd-code-reviewer.md` applies to `<external_reviewer_evidence>` ([ADR-2782](2782-reviewer-lane-capability-surface.md)): the block is data, never instructions, a redirect attempt inside it is prompt injection, and every claim is re-verified against the source before it is kept. `fragments/synthesize.md` states the contract for all three role agents.
- **Plan validation is more than structural.** Core rejects a strategy's plan, with reason `invalid_plan`, when any of these holds:
  - an `agentType` is outside the allowlist, which is `gsd-swarm-worker` plus the step's own agent as the one synthesizer;
  - a dispatch's `model` or `tier` differs from `resolve-model`'s output for the agent whose values it claims (the worker's, or for decomposition and cross-file dispatches the synthesizer's);
  - a `prompt` or `schema` exceeds its byte bound;
  - a unit scope fails containment, or there are more units than `maxWorkers`;
  - `maxWorkers` is not an integer of at least 2, or `maxConcurrency` is not an integer of at least 1;
  - the plan carries an executor-only field (Decision 1).
- **Reviewer-lane evidence stays where it is.** Both code-review steps already carry `supportsReviewerLanes`. Lane dispatch is unchanged by swarm. Lane evidence goes only to the synthesizer, `gsd-code-reviewer`, in its existing `<external_reviewer_evidence>` block. It never reaches a per-file worker or the cross-file worker, so it is never laundered through a worker answer past the consolidation contract.

## Alternatives considered

- **Swarm as a mode of claude-orchestration** (`claude_orchestration.swarm.*`). Rejected; see Decision 1.
- **A new swarm step at `plan:pre` producing `RESEARCH.md`.** This is invalid by the uniqueness rule in `produces`, and it would duplicate the role's schema in a second agent.
- **New worker and synthesizer agents per role.** That means six agents, the roster ripple twice over, and a second writer of each schema. Reusing the role agent as synthesizer is what keeps downstream gates unchanged.
- **Core orchestration (Lens A).** The maintainer and the triage rejected this. Core receives only the trait, the field, one verb and the plan schema.
- **A contribution into the role agents that tells them to fan out themselves.** A dispatched agent fanning out is the #853 failure on Claude Code, and it repeats the role-partition error #4740 corrected (an agent cannot orchestrate).
- **A second Workflow emitter for fan-out plans next to `emitWorkflowScript`.** Rejected: that is the two-mechanism outcome the verdict forbids. Step 5 refactors the one emitter instead (Decision 1).
- **`worker_tier` / `synthesizer_tier` config keys.** Rejected; see Decision 7.

## Consequences

- **Positive.** Workers spread across concurrent dispatches, and most tokens move to the cheap tier. Both are claims to be measured by telemetry, not assumed, and Layer 2 measures the wall-clock claim on the fixture. The new worker spawn sites pass `tier`. The fan-out seam gives #4747 E1 a candidate shape.
- **Negative and forever-cost.**
  - A new core manifest field, step trait, verb and plan schema to maintain, plus validator and registry changes.
  - Step 5 refactors `emitWorkflowScript` into an adapter and a renderer, and the plan schema carries two executor-only fields.
  - One new agent, with roster, inventory and capability-matrix ripples.
  - A synthesis fragment that must track three role schemas: when a role's output schema changes, `fragments/synthesize.md` and the Layer 1 structural assertions change in the same PR.
  - Haiku-class workers will cite anchors that do not exist. `verify-anchors` and the re-verification rule are the product, not an add-on. A failed anchor costs its claim, so a swarm artefact can carry fewer findings than a single-agent run would have; the removal list makes that visible rather than silent. Only an anchor that cannot be pruned cleanly costs a full single-agent rerun.
  - The orchestrator's and the synthesizer's context grow by up to `max_workers` × 4 KiB of answers per run: 80 KiB at the default 20, 200 KiB at 50. With no upper bound on `max_workers`, a user who raises it far enough can exceed the synthesizer's context. That trade-off is the user's: the bound was declined on purpose, and the loud `synthesis_failed` rung plus the fallback rerun is what a run that overflows gets.
  - Layer 2 is a live, human-run check that CI cannot reproduce. Layer 1 is the reproducible floor, and the attached Layer 2 artefacts are what a reviewer re-reads.
- **Neutral.** With `swarm.enabled: false`, behaviour and artefacts are byte-identical to today, and no file is written.

## Implementation plan

Each step is one PR, tracked by its own issue opened after this ADR is accepted. #5273 stays open as their parent, and this ADR authorizes none of them by itself.

1. **Fixture capture (input, not code).** Record the representative fixture phase from real runs on Claude Code: `CONTEXT.md`, the single-agent `RESEARCH.md`, `PATTERNS.md` and `REVIEW.md`, and a real worker answer carrying a fabricated anchor. The fixture-provenance rule forbids the gate's author from writing them, so this is a separate input with its own `README.md` and `MANIFEST.json` naming each run. Steps 2 and 3 do not wait for it; the assertions that read it land with step 3. The founder runs both captures locally on Claude Code, from a written procedure and a fixture skeleton that step 3 supplies.
2. **Core seam, with its tests.** Add the `supportsFanOut` trait, the `fanOutStrategy` field with its validator, the `loop fan-out-plan` verb, the plan schema and its validator (Decision 9), and `gsd-core/references/fan-out-dispatch.md`. The PR carries the Layer 1 cases that need only the seam: plan validation with its boundaries and properties, path containment and hostile input, the config rungs, and *C*.
3. **Swarm capability.** Add the manifest, the `gsd-swarm-worker` agent and catalog row, `swarm plan|record|verify-anchors`, `fragments/synthesize.md`, the opt-in traits on the three role steps, docs (`docs/CONFIGURATION.md`, a how-to, inventory and capability matrix) and a changeset. The PR carries the remaining Layer 1 cases: the strategy's rungs, `verify-anchors` against the step 1 fixtures, telemetry, and the structural equivalence assertions. Layer 1 is then complete.
4. **Wire the spawn sites** in `plan-phase.md` (two sites) and `code-review.md` (one site), with acks for the growth. This PR carries the Layer 2 evidence.
5. **Optional, gated on #4747 E.** Refactor `emitWorkflowScript` into `wavesToFanOutPlan` plus `renderFanOutPlan`, byte-identical for waves, then route fan-out plans through the Workflow executor.

## Open questions for the maintainer

Resolved on 2026-10-10, after review on the issue:

- **Concurrency cap.** Decided as min(`dispatch-capacity`, `swarm.max_concurrency`, `swarm.max_workers`). Swarm does not read `parallelization.max_concurrent_agents`; its default of 3 would throttle the swarm (Decision 2).
- **Swarm size.** `swarm.max_workers` defaults to 20 with no upper bound, and the fixed 9-agent ceiling is gone (Decision 2). Workers need no worktrees, because they cannot write (Decision 3).
- **Token split in interactive sessions.** Decided as exact host figures where reported, otherwise `null` or a labelled chars/4 estimate kept in its own map, and exact-only for the Layer 2 evidence (Decision 5).
- **Nesting (#853).** Unaffected. Swarm fans out from the main loop on every runtime, so a host's nesting depth is never on its path. This ADR does not change any runtime descriptor's `dispatch.nested` or `maxDepth`; if host documentation has moved on nesting, that is a descriptor correction for its own issue. The `no_agent_tool` run-time rung (Decision 6) stays as the observed backstop.
- **Tests-first with `todo` cases.** Not workable under `gsd-test`; the tests land with the code they test (Decision 8, implementation plan).
- **Generic seam.** `fanOutStrategy` ships as the generic seam (Decision 1), not hard-wired to swarm.
- **Failed anchor check.** The artefact is kept with the unverified claims removed and listed; only an unclean prune falls back to single-agent (Decision 3).
- **Step 3 policy (founder decisions 2026-10-10).** Workers are Haiku in every profile; decomposition runs on the role's strong model and aims to use all of `max_workers`; code-review groups files above `max_workers`; more than 25 % dropped answers fails the run; workers have no token cap; all three roles are on by default when `swarm.enabled` is set; step 5's renderer accepts any plan size and the user raises `workflowSizeGuideline`.

Nothing is left open for the maintainer beyond accepting or amending these decisions.

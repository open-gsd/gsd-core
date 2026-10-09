# ADR-5057: One owner per workflow verdict — phase status, verification, gates, runtime activation, planning writes

- **Status:** Accepted — design lock for epic [#5056](https://github.com/open-gsd/gsd-core/issues/5056); ratified at the closeout phase (Phase 14, [#5219](https://github.com/open-gsd/gsd-core/issues/5219)) once every arm shipped. See *Ratification* below.
- **Date:** 2026-09-27
- **Issue:** [#5057](https://github.com/open-gsd/gsd-core/issues/5057) — Phase 0 of epic [#5056](https://github.com/open-gsd/gsd-core/issues/5056)
- **Supersedes:** nothing.
- **Relationship to prior work:** the sixth application of the single-owner mechanism, after [ADR-1372](1372-markdown-sectionizer-seam.md), [ADR-2143](2143-markdown-table-and-mutation-consolidation.md), [ADR-3180](3180-planning-semantic-model-single-owner.md), [ADR-4910](4910-planning-document-seam.md) and the `phase-id.cts` consolidation (#2121). It adds owners **above** ADR-3180's §7 owners and does not replace any of them. Epic #5056 subsumes three epics that never reached Phase 0 — [#4907](https://github.com/open-gsd/gsd-core/issues/4907) (Arm B), [#4631](https://github.com/open-gsd/gsd-core/issues/4631) (Arm C) and [#4632](https://github.com/open-gsd/gsd-core/issues/4632) (Arm D). None of them had an ADR, so there is no `Subsumes` relation to declare. [#4629](https://github.com/open-gsd/gsd-core/issues/4629) ([ADR-4629](4629-state-write-intent-beyond-frontmatter.md)) is in progress and is **not** subsumed.

## Context

An architecture review of `next` @ `19a7b1fe69` (2026-09-27) looked for shallow modules and verdicts derived at more than one site. Five clusters survived verification against the code and against the existing ADR corpus. They are one defect in five subsystems: **a verdict the workflow acts on is derived at more than one site, the copies use different vocabularies, and nothing forces them to agree.**

### Arm A — phase status has four vocabularies

[ADR-3180](3180-planning-semantic-model-single-owner.md) §7.4 made `isPhaseComplete` (`src/verification.cts`) the single owner of *is phase P complete?*. The richer question the UI and the health checks ask — *what state is phase P in?* — has no owner. It is derived at four sites:

| Site | Vocabulary | Verification read through |
|---|---|---|
| `src/commands.cts:217` `determinePhaseStatus`, with `foldPhaseStatus` (`:203`) for colliding directories. Called by `cmdProgressRender` (`:3418`), `cmdStats` (`:3938`), and `init plan-phase`'s `phase_status` (`src/init.cts:1265`) | `Not Started`/`Pending`, `Planned`, `In Progress`, `Executed`, `Needs Review`, `Complete` (the pending word is a caller argument) | **the raw frontmatter `status` key** of the file `resolveVerificationFile` picks |
| `src/health-diagnostic-rules/phase-structure.cts:112` `derivePhaseStatusLabel`, whose docblock says it *"reconstruct[s] `commands.cts`'s `determinePhaseStatus` six-way label"* | the same six labels | `isPhaseComplete` and `readVerificationStatus` |
| `src/state-contract.cts:195` `statusFromProgressCell` → `.planning/state.json` | `complete` / `in_progress` / `pending` | none: it parses the ROADMAP Status cell |
| `src/workstream-inventory-builder.cts` `PhaseStatus.status` | `complete` / `in_progress` / `pending` | `isPhaseComplete`, computed by the caller |

The first two sites **disagree today**. Take a phase whose `*-VERIFICATION.md` says `status: passed` but whose `covered_digest` no longer matches. `determinePhaseStatus` returns **Complete**, because it never reaches the staleness check. `derivePhaseStatusLabel` returns **Executed**, because `isPhaseComplete` fails closed on `stale`. So `progress`, `stats` and `init plan-phase` contradict both `gsd-health` and ADR-3180's decision on the same phase. `init.cts:1265` also passes `phaseInfo.plans.length` rather than `scanPhasePlans`'s count, which is §7.5's owner. That makes a third input path.

### Arm B — verification staleness (carried from #4907)

#4907's body is the design input and is not restated here. Its arms are: (a) the covered set contains files that verification writes (#4857, #4887, and now #4981); (b) emitter and checker derive their inputs independently (#4817); (c) `stale` is read two ways, and no workflow regenerates the report (#4765, #4887); (d) `detectDrift` (`src/drift.cts:161`) sees only added files (#4886). Two changes since it was filed: #4894 (the `--project-dir` arm) shipped, and #4987 is a new instance of arm (c) — a nonexistent phase directory answers `missing` and routes to `/gsd-execute-phase` at exit 0. The comment on #4907 about the out-of-repo planning layout supplies a design constraint (§3.1): phase artifacts can live outside `projectRoot`.

### Arm C — gates (carried from #4631, plus the precondition it did not state)

#4631 asks for one `resolveEvaluationScope()`, evidence read through the existing document seams, and an `Evidence` type that separates *none* from *could not read*. None of the three exists today. The review found a structural precondition #4631 did not name: the gates are not modules. `src/check-command-router.cts` is 2,017 lines. It contains decision-coverage extraction and verification (`:295`–`:538`), with its own `extractYamlBlock` (`:204`) and `extractXmlTagBodies` (`:217`) parallel to the Frontmatter Module. It also contains the UI plan and safety gates (`:563`–`:853`), the TDD review checkpoint (`:854`), the verify-command-path checks (`:1141`) and API-coverage verify-pre (`:1512`). Every one prints through `output()`, so a gate's verdict can be tested only through captured stdout. About 19 of the other 25 command routers are the thin pass-throughs [ADR-2346](2346-command-dispatch-completion.md) intended; this one is not.

The comments on #4631 add #4686 (a correct verdict whose exit code is 0), #4869 (scope too wide), and the `git log --all` spot-checks in `execute-phase.md` (evidence from the wrong branch). The boundary note on #4631 stands: #4692, #4867 and #4957 concern a narrow evidence *model*, not a narrow parser, and are out of scope.

### Arm D — runtime activation (carried from #4632, plus the hooks surface)

#4632 asks for one runtime descriptor that owns every runtime-specific fact, one resolver, an activation probe, and an advertised command list generated from the registered surface. Its absorbed issues (#4332, #4557, #4567, #4347, #4438) were closed as duplicates of that epic, and #4849 and #4690 are still open. The review adds three places where the descriptor is bypassed:

- `_hostBehaviors` is implemented twice: `src/install-engine.cts:263` and `src/runtime-artifact-conversion.cts:102`.
- `src/install-engine.cts:1441` special-cases `runtime === 'hermes'` for bare-stem cleanup rather than reading a descriptor field.
- `applySettingsJsonHooks` (`src/runtime-hooks-surface.cts:2464`) is 655 lines, cyclomatic complexity 157, cognitive complexity 303 — the most complex function in the repository. Its top-level dispatch is already keyed on the descriptor's `hooksSurface` (`writeKimiHooksToml` is a separate writer). Below that, every registered hook is a hand-written branch in one body, so no single hook's registration can be tested without the rest.

### Arm E — planning writes that ADR-4910's census missed

[ADR-4910](4910-planning-document-seam.md) was ratified on 2026-09-26 with its Done-when item *"No verb mutates a `.planning/` artifact with a bespoke `String.replace`"* checked. The review found four mutations outside the seam:

| Site | Shape | Artifact |
|---|---|---|
| `src/roadmap-upgrade.cts:2294`–`2298` | `applyRoadmapEdits` (line-indexed exact-match replacement) → `fs.writeFileSync` | ROADMAP.md |
| `src/roadmap-upgrade.cts:2285` | precomputed `rewrite.to` → `fs.writeFileSync` | `*-PLAN.md` `depends_on` |
| `src/roadmap-upgrade.cts:2315`–`2328` | `content.split(from).join(to)` → `fs.writeFileSync` | STATE.md, PROJECT.md |
| `src/phase.cts:4131` | `b.replace(planCheckboxPattern, '$1x$2')`, next to a sibling at `:4090` that uses `updateBullet` | ROADMAP.md |

`local/no-adhoc-markdown-parsing`'s detectors key on table, section and bold-label-field regexes, so none of these shapes is visible to them, and `lint:ci` is green. The `:2315`–`:2328` loop is not specific to one file: it iterates `crossRefsByFile` and writes whichever of STATE.md and PROJECT.md it holds edits for. Its STATE.md write is also invisible to #4629's terminal guard. `scripts/lint-state-write-path-drift.cjs`'s `targetsStatePath` (`:612`) matches only a `statePath` identifier or a `STATE.md` literal, and this call's target is `filePath`.

### Why a design lock, before any code phase

1. Three of the five arms had an epic but no locked interface, ordering or ratchet. Fourteen phases will build against whatever this file says.
2. The arms touch each other. Arm A consumes Arm B's verdict, Arm C's gates read verification, and Arm E's lint extends the rule Arm C's evidence readers must pass. Without one set of ordering constraints, two phases would each claim the same file.
3. Four review candidates were rejected on inspection because an existing ADR already owns them (see *Alternatives considered*). Recording why is what keeps the next review from suggesting them again.

## Decision

Seven decisions, locked. Phases 1–14 execute against them as separate PRs.

### 1. The rule: one owner, one closed vocabulary, one positive control

Every verdict the workflow acts on has:

1. **exactly one owner module** that computes it;
2. **a closed vocabulary**, exported by the owner as a frozen enum and imported by every producer and every consumer, so an out-of-vocabulary value fails where it is produced rather than where it is misread;
3. **a positive control** — a test that drives the verdict to its failing value, so the check can be shown to go red before anyone relies on it going green.

Projections — display labels, wire values, table cells — are functions **of** the owner's value, exported by the owner. A consumer never maps a raw input to a projection itself.

### 2. Arm A — the Phase Status Module owns the ladder

A new module, `src/phase-status.cts` (the **Phase Status Module**), owns the answer to *what state is phase P in?*

- **Interface.** `phaseStatus(phaseDir, deps?) → ScopedResult<PhaseStatus>`, built only from the §7 owners: plan and summary counts from `scanPhasePlans` (§7.5), and completion and verification from `isPhaseComplete` / `readVerificationStatus` (§7.4). It reads nothing else, and in particular never reads VERIFICATION.md frontmatter itself.
- **Closed ladder.** `PHASE_STATUS = { NOT_STARTED, PLANNED, IN_PROGRESS, EXECUTED, NEEDS_REVIEW, COMPLETE }`. The pending word is **one** value. The `Pending` / `Not Started` split in today's callers is a display choice and moves into the label projection.
- **Precedence.** `foldPhaseStatus`'s rank (#2408 — two directories colliding on one phase number) becomes the module's `foldPhaseStatuses(a, b)` over the enum, not over strings.
- **Projections, exported by the module.** `toDisplayLabel(status, { pendingWord })`; `toWireStatus(status)` → the three-value `complete | in_progress | pending` vocabulary that `state.json` and the workstream inventory already publish (unchanged on the wire); `toRoadmapStatusCell(status)` for the writers of ROADMAP's Status column; and its inverse, `parseRoadmapStatusCell(cell)`, which replaces `statusFromProgressCell`, so the cell's vocabulary is owned in one place for both directions.
- **What does not change.** `state.json` keeps composing its phase rows from the ROADMAP progress table — the Planning State Contract's documented *"cannot disagree with GSD's own progress counters"* property. What changes is that the cell's writer and reader now share one vocabulary.
- **Interaction with Arm B.** `NEEDS_REVIEW` maps from the `human_needed` member of the verification vocabulary. When Phase 4 closes that vocabulary into the `VerificationStatus` enum (§3), the Phase Status Module is one of its importers, and Phase 4's census counts it.

### 3. Arm B — verification: #4907's seam, adopted with two amendments

The five seam items in #4907's body are adopted as decisions: a covered-set schema enforced at fingerprint time; verify-lifecycle write ordering behind a lint; emitter and checker deriving their inputs through one seam; a closed `VerificationStatus` enum with `stale` owned by one routing table and one command that regenerates; and `detectDrift` taking the full change set and all seven generated documents. The ratchet — the two-cycle verify-work acceptance test ending `passed`, plus fingerprint idempotence as a property — is adopted unchanged. The two amendments:

1. **Two containment roots.** Implementation files are contained in `projectRoot`; phase artifacts are contained in the planning root that `planningPaths` (Planning Workspace Module) resolves, which may be a symlinked out-of-repo store. `canonicalizeCoveredFiles` normalizes, de-duplicates, sorts and drops report paths; each covered path is classified to one root and contained against that root by the planning-scope containment helpers (`enumeratePlanningScopes`, `bestPlanningScopeForRel`) that the digest calls. *(Phase 14 correction: as first written this sentence attributed the classification to `canonicalizeCoveredFiles` itself.)* Containment is not weakened: every path is still confined, just to the root it actually lives in. This removes the case where a correct covered set recomputes to `null` → `stale` forever under the documented out-of-repo layout.
2. **A phase directory that does not exist is not `missing`.** `readVerificationStatus` returns a distinct `phase_dir_not_found` member of the closed enum (#4987), routed to a usage error and never to `/gsd-execute-phase`. `missing` keeps meaning "the directory exists and has no report."

The project-root arm of #4907 (#4894) shipped on its own and is closed; phases use `Refs #4894`.

### 4. Arm C — a gate is a module that returns a verdict

- **Gate modules.** Each gate in `src/check-command-router.cts` moves to its own module, which returns a `GateVerdict` object and never calls `output()`. The router keeps argv parsing and output formatting only — the shape [ADR-2346](2346-command-dispatch-completion.md) already gives every other host router. This is a move with one class of behaviour change, stated below, and it is the precondition for the next three bullets: they are unmeasurable while gates live in a router. The router's private `extractYamlBlock` is deleted in favour of the Frontmatter Module (`frontmatterKeyBlockText`, raw text off the one fence owner's block), its private `extractXmlTagBodies` in favour of the markdown sectionizer seam (`src/markdown-sectionizer.cts`, not `PlanningDoc`: the tags are scanned as text, never written), and its private `readWorkflowConfig` (`:113`) in favour of the key resolver `config-get` shares (`resolveConfigKey` in `src/capability-activation.cts`, wrapped by `src/gate-config.cts`). A gate reads config the way every other surface does, so it cannot honour a top-level alias that `config-get` and the loader reject (#4978); the same resolver makes gate config workstream-aware (`GSD_WORKSTREAM`: the workstream's config first, then the project root's), and reads it quietly, so a malformed `config.json` is an absent key and never a write to stderr.
- **One scope resolver.** `resolveEvaluationScope(unit)` answers *which commits and file set does this gate evaluate for this plan, wave or phase*, including workstream scope. It returns only commits reachable from the branch under evaluation, never repo-wide (`git log --all` is removed), and matches plan subjects anchored. Three constraints hold. The scope is the union of each scope-tagged commit's own file set, not a range: a range keeps interleaved non-phase files (measured on a 9,676-commit repo, the range bound 23, 194 and 602 files for three phases where the union held 9, 42 and 69), so a range is not an acceptable representation. An empty union after path exclusions (a phase with no scope-tagged commits, or one whose commits touched only excluded paths, including a planning-only phase) never becomes an empty scope that reviews nothing and reports success: the resolver degrades to wider evidence and reports the degradation, the `Evidence` *none* versus *unreadable* distinction applied to scope. What the union drops is named by path, not counted: commits scoped differently from the phase (`fix(test):`, bare `fix:`) surface as the range-minus-union difference, and paths dropped because they no longer exist on disk are listed by name. The derivation starts from the SUMMARY `## Task Commits` mechanism and its byte-parity guard on the closed PR #4127 branch `fix/3926-tier3-diff-tip-bound`, generalized rather than copied.
- **Evidence through the document seams, as a typed result.** `Evidence<T> = { kind: 'found', value: T } | { kind: 'none' } | { kind: 'unreadable', reason, span? }`. `unreadable` never produces a passing verdict. Structured plan and document content is read through the Frontmatter Module, `markdown-sectionizer`, `markdown-table` and `PlanningDoc`, never through a per-gate regex.
- **The exit code is a function of the verdict.** A gate verb's exit status is derived from its `GateVerdict` through the process exit contract ([ADR-3889](3889-process-exit-contract.md), `src/cli-exit.cts`), not chosen per verb (#4686).
- **Ratchet.** A gate module with no test that drives it to its failing verdict is a lint failure. The gates that exist today enter an allowlist that is drained to zero, never renewed.
- **Policy is untouched.** What each gate forbids does not change; only how it determines scope, reads evidence and reports.

### 5. Arm D — the runtime descriptor owns every runtime-specific fact

- **One descriptor.** Event names, tool and payload vocabulary (`KIMI_TOOL_NAMES` becomes a row, not a special case), environment-variable candidates, command registration surface, platform command construction, and runtime-specific post-install steps (the Hermes bare-stem cleanup becomes a descriptor field) all live in the runtime descriptor ([ADR-1016](1016-runtime-capability-descriptor.md), laid out per [ADR-3660](3660-runtime-artifact-layout-module.md)). There is **one** accessor for a runtime's host behaviours; the two `_hostBehaviors` copies are deleted.
- **An unknown id refuses.** Every descriptor accessor rejects a runtime id it does not know, rather than falling through to Claude Code defaults. The comment on #4632 measured `getGlobalConfigDir('gemini')` returning `~/.claude`.
  *Phase 10 amendment (#5169): "falling through to Claude Code defaults" is the rule's subject.* Two answers to an unknown id are a documented **cross-agent** default that is not a Claude Code value — `getProjectInstructionFile` (`AGENTS.md`, the #1529 contract) and the new-project command (`/gsd-new-project`, since Phase 12 answered by `resolveAdvertisedNewProject` rather than a descriptor accessor) — and they keep it; an unknown id there names a future runtime GSD cannot know, and a cross-agent default is the correct answer. Every accessor that returns a Claude Code path, label, directory name or config home refuses (`UnknownRuntimeError`, `src/runtime-name-policy.cts`): `getDirName`, `getRuntimeLabel`, `getGlobalConfigHomeFragment`, `getGlobalConfigDir`, `getGlobalSkillsBase`. The one host-behaviors accessor, `hostBehaviorsFor`, is a predicate source read by guard and hook code on user-supplied labels (a stale `runtime` value, a retired id): for a label GSD does not know, "no declared behaviors" is the generic path — never Claude's behaviors — and a throw would crash a session rather than skip a behavior, so it answers `{}`. `tests/runtime-descriptor-owner.test.cjs` pins all three halves.
- **One resolver.** The shell launcher's candidate list and the JS resolver derive from the same source, and every consumer of *which runtime is this install* reads the install-time marker through one function (#4690).
- **Hooks-surface adapters.** `hooksSurface` stays the top-level seam, and it is a real one: `settings-json`, `kimi-hooks-toml` and `none` are three adapters. Inside the `settings-json` adapter, hook registration becomes a table of `{ hook, event, matcher, command builder }` rows consumed by one loop, replacing the per-hook branches in `applySettingsJsonHooks`. A hook is added by adding a row.
- **The activation probe.** For every runtime × every registered hook, CI drives a synthetic payload through the real registration and asserts that the guard body executes (#4849, #4332, #4557). The installer's advertised command list is generated from the registered surface, and a parity test fails when they differ (#4567).
- **Posture is untouched.** `ON_CRASH = ALLOW` stays correct for advisory guards. That is why the probe is the only place this class can be caught.
  *Phase 12 amendment (#5215):* the probe's enumeration source is what the real installer registered, pinned equal to the Phase 11 table rows (limit-1 / limit / limit+1), and it executes each registered command through the host shell against a sentinel stub with a synthetic payload; a registration that resolves to nothing, to a different script, or to a stub that does not run is red (positive controls). The probe replaces each hook body with the sentinel stub, so it proves the registered command resolves to the script at the registered path and delivers the payload; it does not run the shipped guard body (an advisory guard exits 0 silently, so "ran" would be unobservable without editing the hook), and a startup crash inside a shipped script stays covered by that hook's own tests. It executes through `/bin/sh`, so Windows registration shapes stay pinned by the Phase 11 `win32` golden scenarios rather than executed. Its census covers the `settings-json` adapter the Phase 11 table drives; the `kimi-hooks-toml`, `codex-hooks-json` and `cursor-hooks-json` adapters keep their own registration tests and are named here as outside this phase's census. The advertised next-step command is `resolveAdvertisedNewProject(runtime, scope)` in `src/runtime-artifact-layout.cts`: it projects the registered `new-project` trigger of the install scope and renders it with the host's invocation syntax. That syntax (`$` for codex, `/skill:` for kimi, a mention for cursor) is presentation, kept as a small renderer table beside the function; whether the command exists is decided by the registered surface alone. A runtime that registers no `new-project` trigger in the scope (pi, windsurf global, vscode; cline, kimi and kimi-code local) is told so instead of being sent to a command that does not exist (#4567), and a native-extension runtime is told the command its extension registers (pi: `/gsd`, the stem of `hostBehaviors.nativePlugin.file`, pinned against the extension itself). Host launch and restart steps in the completion message are unchanged. Pi's missing workflow command surface is a capability, not a message, and stays out of this phase. The census was taken from `next` @ `bee8d3db7e`: advertised-vs-registered mismatches went from 8 runtime × scope pairs to 0.

### 6. Arm E — ADR-4910's census covers every mutation shape

- The `src/roadmap-upgrade.cts` mutations of ROADMAP.md, `*-PLAN.md` and PROJECT.md, and `src/phase.cts:4131`'s checkbox flip, route through the `PlanningDoc` seam (`updateBullet` for the flip). `applyRoadmapEdits` is deleted, not wrapped.
- `local/no-adhoc-markdown-parsing` gains a detector for the two shapes it cannot see: a `split(x).join(y)` substitution and a line-indexed rewrite, each over content read from a registry-recognized planning artifact. The detector ships with a positive control, per [ADR-4910](4910-planning-document-seam.md) §7.
- This executes ADR-4910's own Done-when; it does not change ADR-4910's decision, so no `Amends` relation is declared.
- The cross-reference loop at `src/roadmap-upgrade.cts:2315`–`2328` is deleted, not split in place. Its two targets get two writes, one per seam: PROJECT.md through `PlanningDoc`, and STATE.md through the STATE.md write seam that is current when Phase 13 opens — `readModifyWriteStateMd` ([ADR-3408](3408-state-write-path-preservation.md)) today, or #4629's `StateWriteIntent` if it has landed by then. Arm E migrates the **call site**; it does not design the STATE.md seam's contract, which #4629 owns.
- The gap in #4629's terminal guard — a raw STATE.md write whose target arrives in a variable not named `statePath` — is **not** claimed here. It is reported to #4629 as a finding about its guard, because closing it is part of that epic's residual-writer census.

  *Phase 13 amendment (#5217):* the census was taken from `next` @ `196688b210`: four sites (the table above) went to zero. `updateHeading` is the heading analogue of `updateBullet` in `src/markdown-sectionizer.cts` (heading discovery stays `tokenizeHeadings`', so no fourth fence state machine), and both `match` callbacks now receive the physical line index, which is what lets a pre-computed line-indexed plan stay unambiguous across milestones. `replaceProse(doc, from, to)` in `src/planning-document.cts` is the seam's verbatim cross-reference rewrite: fenced code is never rewritten, every other byte is copied, and a doc with staged field edits is refused. `applyRoadmapEdits` is deleted; the migration's ROADMAP rewrite (`rewriteRoadmapLines`, exported only for the property test, per the ADR-1508 precedent) is a composition of `updateHeading` and `updateBullet` and throws when an edit it planned cannot be applied, so a heading the sectionizer does not read as a heading (`###Phase 1:`) rolls the migration back instead of leaving a half-migrated roadmap that the mixed-state guard would then refuse to retry. PROJECT.md goes through `replaceProse`; STATE.md goes through `readModifyWriteStateMd` with `{ resync: false }`, running the same substitution. The `*-PLAN.md` `depends_on` write persists `spliceFrontmatter`'s output (already the frontmatter seam's), and is refused when the file changed since the plan was computed. Two deliberate narrowings, both pathological inputs: fenced content is no longer rewritten, and a heading or checklist line that is not CommonMark-shaped is refused rather than rewritten. `no-adhoc-markdown-parsing` gains `adhocSplitJoinMutation` and `adhocLineIndexedMutation`; the receiver gate is a planning-specific identifier name or a same-scope binding initialised by a file read whose path evidence (followed four hops) names a planning location, so a parameter or an agent-file read is not flagged. Positive controls are the `invalid` rows in `tests/eslint-rules.test.cjs`. Not claimed: `src/state-transition.cts` `stripTemplatePlaceholders`, a body rewrite inside the STATE.md transition seam #4629 owns, which the detector's receiver gate does not reach (its `content` is a parameter).

### 7. Ordering, and in-flight work

- **Census is taken from the tree as it stands when each phase opens.** Five point-fix PRs against this epic's arms were closed unmerged on 2026-09-27, along with their issues, so each census starts from the real tree (see *The point fixes were closed, deliberately*).
- **Left open, deliberately:** #5041 fixes #4869 (Phase 7 evidence) but also #5011 (`/gsd-debug list`), which is not a gate and no phase here covers. #4507 (#4483) belongs with the approved typed-phase-context feature #4030 (PR #4393). #4701 (#4692) and #5055 (#4957) are the narrow-evidence-model class that §4 leaves out of scope. If #5041 lands first, Phase 7 cites #4869 with `Refs`.

## What makes a phase done

**A phase is done when a structural property holds, not when N symptoms are gone.** Every phase carries three acceptance criteria, in this order:

1. **Census → zero.** The phase opens by enumerating every instance of its anti-pattern tree-wide and publishes the count in its PR. It closes at **zero**, not at "the reported sites".
2. **Deletion, not coexistence.** Bespoke derivations are removed, including ones that are correct today. Two copies that agree today are the same defect as two that disagree.
3. **Unrepresentable by construction.** One property that makes the class impossible rather than currently absent — a `fast-check` property, a type that does not admit the wrong shape, or a drift guard — shipped with a positive control that drives it red.

Absorbed issues are fail-first regression **evidence**, never the deliverable. Those already closed are referenced with `Refs #NNNN`; `CONTRIBUTING.md` forbids a closing keyword against a closed issue.

## Phases

Each phase is one `chore(#5056): … — Phase N` sub-issue and one PR, gated on `gsd-test`, and carries the three criteria above.

- **Phase 0 — this ADR.** Design lock. Docs-only. Closes [#5057](https://github.com/open-gsd/gsd-core/issues/5057) only; #5056 stays open. Also adds the `### Phase Status Module [Planned]` entry to `CONTEXT.md`, closes the three subsumed epics with a pointer to their arm here, and reports §6's guard gap to #4629. Phase 0 is the one phase the three criteria below do not apply to: it changes no code.

**Arm A**

- **Phase 1 — the Phase Status Module exists and is the only phase-status derivation** (§1, §2).
  - *Census:* every function that maps plan/summary counts or verification state to a phase-status word, or parses/writes the ROADMAP Status cell vocabulary. Four derivations today (see Context); driven to one.
  - *Deletion:* `determinePhaseStatus`, `foldPhaseStatus`, `derivePhaseStatusLabel` and `statusFromProgressCell` are removed. `init.cts`'s `phase_status` reads `scanPhasePlans` counts through the module rather than `phaseInfo.*.length`.
  - *Unrepresentable:* a `fast-check` property over generated phase directories: `phaseStatus(d) === COMPLETE ⇔ isPhaseComplete(d).value.complete`, and `parseRoadmapStatusCell(toRoadmapStatusCell(s))` agrees with `toWireStatus(s)` for every `s`. Positive control: a generated `passed`-but-stale phase must not project to `COMPLETE`.
  - *Wired surface:* a user can run `progress`, `stats` and `init plan-phase` — each now wired to `phaseStatus()` — and a `passed`-but-stale phase shows *Executed* in all three, matching `gsd-health`.
  - *Evidence (fail-first):* the stale-verification divergence between `progress` / `stats` and `gsd-health` described in Context.
  - Adds the `### Phase Status Module` glossary entry to `CONTEXT.md` (replacing the `[Planned]` entry) with its `SEAM.*.owns` / `SEAM.*.enforced-by` pair ([ADR-3626](3626-context-md-seam-claim-gate.md)).

**Arm B**

- **Phase 2 — the fingerprint's input set is closed and idempotent** (§3, #4907 items 1 and 3).
  - *Census:* every path by which a file written during verification can enter `covered_files`, and every place emitter and checker derive the covered set or root separately.
  - *Deletion:* the separate emitter-side and checker-side derivations collapse onto `canonicalizeCoveredFiles` with the two-root classification (§3.1).
  - *Unrepresentable:* compute → write → recompute yields the same digest, as a property over generated covered sets including the out-of-repo planning layout.
  - *Evidence:* #4857, #4817, #4981.
- **Phase 3 — no verify-lifecycle hook writes a covered artifact after fingerprint time** (#4907 item 2).
  - *Census:* every `verify:post` step or hook that writes a path a report may cover.
  - *Unrepresentable:* a lint over the registered verify-lifecycle hooks, with a positive control.
  - *Evidence:* #4887 (the SECURITY.md append), #4981 (the VALIDATION append).
- **Phase 4 — `VerificationStatus` is closed and `stale` has one route that regenerates** (§3 and its amendment 2, #4907 item 4). Depends on Phase 2.
  - *Census:* every reader and writer of a verification status value (agents, workflows, `src/`), including the Phase Status Module's mapping.
  - *Deletion:* the second reading of `stale` in `execute-phase.md` and the empty `next_command` for `stale` are removed; one routing table remains.
  - *Unrepresentable:* the enum is imported by `gsd-verifier`'s contract and `verification.cts`; a status outside it is a hard error. The two-cycle acceptance test (green phase → verify-work twice → `passed`) is the ratchet.
  - *Wired surface:* a user can run `/gsd-verify-work` on a stale phase and the single `stale` route dispatches to the command that regenerates the report; the run ends `passed`.
  - *Evidence (`Refs` for #4765, #4987):* #4765, #4887, #4817 (status outside `VERIFIER_STATUSES`), #4987.
- **Phase 5 — `detectDrift` sees the whole change set, and its output is sanitized** (#4907 item 5). Independent of Phases 2–4.
  - *Census:* change classes and generated documents outside the detector's input (today: modified, deleted; six of seven documents).
  - *Unrepresentable:* a property over generated change sets: every added, modified or deleted file under a mapped directory yields an element.
  - *Output seam:* `detectDrift`'s `affected_paths` leave the module only through `sanitizePaths` (`src/drift.cts`), which today has no production caller (#4923). No unsanitized path reaches the warn message or the mapper's `--paths` argument. A property over generated paths (absolute, `..`, shell metacharacters) asserts that none survives.
  - *Evidence (`Refs`):* #4886, #4923.

**Arm C**

- **Phase 6 — no gate lives in a command router** (§4, first bullet). No behaviour change, with one exception that is a class: config is read through the key resolver `config-get` shares (`resolveConfigKey`, wrapped by `src/gate-config.cts`), so a top-level config alias that `config-get` and the loader reject stops being honoured. That is `context_coverage_gate` (#4978) and, for `check auto-mode`, `auto_advance` / `_auto_chain_active`. The same read makes gate config workstream-aware (`GSD_WORKSTREAM`). Must precede Phases 7–9.
  - *Census:* gate-verdict logic and `output()` calls inside `src/check-command-router.cts`. Driven to argv parsing and formatting only.
  - *Deletion:* `extractYamlBlock`, `extractXmlTagBodies`, `readWorkflowConfig` and the other router-local helpers are removed in favour of the Frontmatter Module (`extractYamlBlock`), the markdown sectionizer seam (`extractXmlTagBodies`) and the shared config-key resolver (`readWorkflowConfig`).
  - *Evidence (fail-first, `Refs`):* #4978 — a config holding only a top-level `context_coverage_gate: false` must leave the decision-coverage gate enabled, as `plan-phase` already assumes.
  - *Unrepresentable:* each gate module's tests assert on its `GateVerdict`; a cutover-equivalence test per gate pins the router's stdout byte-for-byte across the move, as [ADR-2346](2346-command-dispatch-completion.md) did for its cutovers.
- **Phase 7 — one evaluation-scope resolver** (§4, second bullet). Depends on Phase 6.
  - *Census:* every gate or workflow step that computes its own commit range or file set (`HEAD~1..HEAD`, `DIFF_BASE..HEAD`, basename re-resolution, `git log --all --grep`), including the deleted-file filter in `gsd-core/workflows/code-review.md`, which prints `Filtered N deleted files from review scope` and counts where the resolver names.
  - *Unrepresentable:* a failing-first case per migrated gate whose only matching commit lives on another branch, plus the byte-parity guard generalized from PR #4127. Three further failing-first cases: interleaved non-phase commits inside the phase's window do not appear in scope; an empty-after-exclusions union degrades to wider evidence and says so; dropped paths appear by name. Design input for these: @grayson-mitchell's comment on #5056 (https://github.com/open-gsd/gsd-core/issues/5056#issuecomment-5903122765).
  - *Evidence (`Refs`):* #3926, #4563, #4498; #4869.
- **Phase 8 — evidence is typed and read through the document seams; the exit code follows the verdict** (§4, third and fourth bullets). Depends on Phase 6.
  - *Census:* per-gate regex parsers of structured content, gate return paths that cannot distinguish `none` from `unreadable`, and gate verbs whose exit code is chosen per verb.
  - *Unrepresentable:* the `Evidence` type does not admit a passing verdict on `unreadable`; gate verbs obtain their exit code only through `cli-exit`.
  - *Wired surface:* a shell caller of a gate verb (`phase uat-passed --require-verification`, `verify.artifacts`) gets a non-zero exit status whenever the verdict fails.
  - *Evidence (`Refs` — all closed):* #4562, #4541, #4259, #4686, #4031, #4176.
- **Phase 9 — every gate has a positive control** (§4, ratchet). Lands last in Arm C.
  - *Census:* the allowlist of gates without a red-driving test; ends empty.
  *Phase 14 amendment (#5219):* Phases 6–9 left four `check` verbs outside the gate-module shape: `verify-schema-drift`, `verify-codebase-drift`, `verify-context-drift` (entry points in `src/verify.cts`) and `prohibition-enforcement` (`routeProhibitionEnforcement`, `src/prohibition-enforcement.cts`). They already produced `GateVerdict`s and declared their exit through the seam, but each printed its own payload and lived where the Phase 9 ratchet does not look, so Arm C's first bullet and its ratchet were not true of them. They are now `src/gate-schema-drift.cts`, `src/gate-codebase-drift.cts`, `src/gate-context-drift.cts` and `src/gate-prohibition-enforcement.cts`, each exporting an `evaluate…Gate` that returns a `GateResult`; `check-command-router.cts` formats all of them at its one output site, and the `verify schema-drift|codebase-drift|context-drift` aliases route through the same functions. Stdout, stderr and exit status of 46 captured arms are pinned byte-for-byte (`tests/fixtures/gate-cutover/`). Two stated differences: a throw inside the prohibition gate is a non-blocking `unreadable` verdict (it crashed before), and `verify-codebase-drift` validates its mapped-commit stamp as a 7–64 character hex object id before any git call, so a ref name (`HEAD`) or a 6-character abbreviation, which the old code resolved through `git cat-file`, now reads as `unresolvable-mapped-commit` (`unreadable`, exit 69). Usage failures keep their old reason code (`unknown`), so JSON-error and exit-contract output do not change. The census taken from `next` @ `8bbdded7ef` was four gates; it is zero, and `lint-gate-positive-control` reports 16 gates, each with a red-driving control, with an empty allowlist. The router is 261 lines (2,017 before). Unrepresentable by construction: the router's imports are an allowlist (`eslint.config.mjs`, `no-restricted-imports` `patterns`: `gate-*`, `io`, `check-auto-mode`, `decision-coverage-support`), so a verb whose logic lives in `verify.cts`, a producer module or any other non-gate module cannot be wired into the router without a lint failure (`tests/check-router-gate-boundaries.test.cjs` B2b); a gate module imports no `io` module, so it cannot print.

**Arm D**

- **Phase 10 — the descriptor owns every runtime-specific fact, and an unknown id refuses** (§5, first three bullets). Must precede Phases 11–12.
  - *Census:* runtime-name literals (`runtime === '…'`) in install and hook code, duplicated descriptor accessors (`_hostBehaviors` ×2), and runtime resolvers that read the runtime without the install-time marker.
  - *Unrepresentable:* a drift guard fails on a runtime-name literal outside the descriptor; a property over arbitrary non-canonical ids asserts that every accessor refuses.
  - *Evidence (`Refs` where closed):* #4690, #4347, #4438, #4332.
- **Phase 11 — hook registration is a table behind the `hooksSurface` adapters** (§5, fourth bullet). Depends on Phase 10.
  - *Census:* per-hook registration branches in `applySettingsJsonHooks`.
  - *Deletion:* the branches are replaced by the registration table and one loop.
  - *Unrepresentable:* a parity test: every row registers identically through the table as the pre-migration output did, for every runtime whose `hooksSurface` is `settings-json` (golden settings files).
- **Phase 12 — registration is proven to activate** (§5, fifth bullet). Depends on Phase 10; benefits from Phase 11's table as the probe's enumeration source.
  - *Census:* runtime × registered-hook pairs with no activation probe; driven to zero.
  - *Unrepresentable:* adding a runtime or a hook without a passing probe fails CI; advertised commands equal registered commands, by parity test.
  - *Wired surface:* a user who runs the installer is told only the commands that runtime registered, because the completion message is generated from the registered surface.
  - *Evidence:* #4849, #4557, #4567.

**Arm E**

- **Phase 13 — every planning-artifact mutation goes through `PlanningDoc`, and the lint sees every shape** (§6). Independent.
  - *Census:* `split/join`, line-indexed and regex `.replace` mutations of registry-recognized planning artifacts outside the seams (four sites today, the STATE.md target of the cross-reference loop included).
  - *Deletion:* `applyRoadmapEdits` and the raw write paths in `roadmap-upgrade.cts`; the raw checkbox `.replace` in `phase.cts`.
  - *Unrepresentable:* the new `no-adhoc-markdown-parsing` detector with its positive control; ADR-4910's byte-stability property re-run over the migrated `roadmap-upgrade` writes.

**Closeout**

- **Phase 14 — ratify.** Verify §1 per arm (one owner, a closed enum, a positive control) and that every phase PR published its census at zero (§7); re-run `/adr-phase-coverage` against the shipped state; ratify this ADR to `Accepted` with a dated Ratification section citing each phase's PR; close #5056. Lands last.

**Ordering constraints.** Within Arm B, Phase 2 precedes Phase 4. Within Arm C, Phase 6 precedes Phases 7 and 8, which may run in parallel, and Phase 9 lands last. Within Arm D, Phase 10 precedes Phases 11 and 12. Phases 1, 5 and 13 are independent. **Across arms:** Arm A has no dependency on Arm B, because the Phase Status Module reads verification only through `isPhaseComplete` / `readVerificationStatus`, whose contracts Phases 2–4 preserve. Phase 4 must update the module's enum import in the same PR that closes the enum. Phase 14 is last.

## The point fixes were closed, deliberately

Five open community PRs were doing point fixes at call sites a phase of this epic deletes or replaces. **All five were closed unmerged on 2026-09-27**, with thanks and an explanation, along with their issues:

| PR | Issue | Contributor | Owning phase | What the phase does to that code path |
|---|---|---|---|---|
| #5003 | #4987 | @0xdhx | 4 | `phase_dir_not_found` becomes a member of the closed `VerificationStatus` enum (§3 amendment 2) — the PR's own answer, adopted |
| #4835 | #4765 | @drungrin | 4 | the second reading of `stale` in `execute-phase.md` is deleted; one routing table, and no branch transitions a stale phase |
| #4922 | #4886, #4923 | @0xdhx | 5 | `detectDrift` takes the full change set and all seven generated documents, and its `affected_paths` leave only through `sanitizePaths` |
| #4938 | #4686 | @denniyahh | 8 | every gate verb's exit code is derived from its verdict through `cli-exit`, not chosen per verb |
| #5014 | #4978 | @ScalingMBA | 6 | `readWorkflowConfig` is deleted; gate modules read config through the key resolver `config-get` shares |

Landing five correct point fixes would have left the missing owners missing, and would have made each phase's census start from a tree that looks healthier than it is. This is not a quality judgement: several of these diagnoses are cited above as the evidence for their arm. #5003's `phase_dir_not_found` is adopted as the design.

- **A closed issue changes the link form, not the evidence obligation.** Phase PRs reference these six issues with `Refs #NNNN`; `CONTRIBUTING.md` forbids a closing keyword against a closed issue. Each still owes its fail-first regression.

## Consequences

- **Positive.** Each verdict is computed in one place, with one vocabulary, and a new consumer inherits correctness instead of re-deriving it. Two of the largest branch-heavy units in the tree lose their branch count to tables: `check-command-router.cts` to gate modules, `applySettingsJsonHooks` to a registration table. Gates become testable through their verdicts rather than through stdout.
- **Cost.** Fourteen PRs plus lint infrastructure. Phases 1, 4, 6 and 10 have high blast radius (`progress`, `stats`, `init`, `gsd-health`; every verification reader; every `check.*` verb; every installer path) and need per-consumer `get_impact` due diligence in their PRs.
- **Risk — output drift.** Phase 1 changes `progress` and `stats` output for stale phases from *Complete* to *Executed*. That is the fix, but it is visible, and it needs a changeset (`Fixed`) in Phase 1's PR. Phases 6 and 11 are designed as byte-identical moves and carry equivalence tests for that reason.
- **Risk — breadth.** An umbrella over five subsystems can stall on its slowest arm. Mitigated by the ordering above: the arms have no hard cross-dependencies, so each can close independently. The epic closes at Phase 14.

## Alternatives considered

1. **Keep #4907, #4631 and #4632 as separate epics and open a fourth for Arms A and E.** Rejected by the maintainer on 2026-09-27: none of the three had started, and Arm A consumes Arm B's verdict, while Arm C's gates read both. Separate epics would each have claimed the same `stale` routing and the same gate files.
2. **Fix the progress/health divergence at `determinePhaseStatus` by calling `isPhaseComplete`.** Rejected as the deliverable. It is a point fix that leaves four vocabularies and a copy described in its own docblock as a reconstruction. It is kept as Phase 1's fail-first evidence.
3. **Phase transition across ROADMAP.md and STATE.md as one command** (review candidate 5). Rejected: already built. [ADR-1769](1769-state-md-transition-module.md) §3 has `completePhase` run inside the multi-file ROADMAP + REQUIREMENTS + STATE transaction (`writePlanningFileSet`). The review traced `roadmap update-plan-progress` and `state complete-phase` separately and missed that `phase complete` already composes them.
4. **Declarative subcommand tables for the shallow command routers** (review candidate 6). Rejected: [ADR-2346](2346-command-dispatch-completion.md) decided that each family's parsing lives in its router (locality), behind a shared `parseFamilyArgs`. The deletion test confirms the remaining duplication moves rather than disappears.
5. **Re-home all raw planning-file reads onto `PlanningDoc`.** Rejected: 27 of the 31 raw `fs` sites the review first flagged are reads, which ADR-4910 does not govern. Only the four mutations are in scope.
6. **Leave the STATE.md target of `roadmap-upgrade.cts`'s cross-reference loop to #4629 entirely.** Rejected: the loop does not distinguish files, so Arm E cannot delete it for PROJECT.md and leave it for STATE.md. Arm E migrates the call site onto #4629's seam, whatever its state when Phase 13 opens. The guard gap, which is the part #4629 owns, is reported there. The opposite split — Arm E redesigning the STATE.md seam — is also rejected, because that would give the seam two owners.
7. **Put the gate verdict type in `write-set.cts`'s `Result<T>`.** Rejected: `Result` is ok/error, and a gate needs three outcomes (found, none, unreadable), the distinction #4631 exists to force. `Evidence<T>` is its own type.

## Ratification

**Ratified `Accepted` on 2026-10-04** by Phase 14 ([#5219](https://github.com/open-gsd/gsd-core/issues/5219)). §1 was verified per arm against the tree after Phase 13 merged (`next` @ `8bbdded7ef`) plus Phase 14's own change.

| Arm | One owner | Closed vocabulary | Positive control | Phase PRs |
| :-- | :-- | :-- | :-- | :-- |
| A — phase status | `phaseStatus` / `phaseStatusFromFacts` (`src/phase-status.cts`) | `PHASE_STATUS` (frozen, `assertPhaseStatus`) and its projections | `tests/phase-status.test.cjs`: passed-but-stale is `EXECUTED`, never `COMPLETE`; `COMPLETE` iff `isPhaseComplete` (property) | 1: [#5077](https://github.com/open-gsd/gsd-core/pull/5077) |
| B — verification | `readVerificationStatus` and `VERIFICATION_ROUTES` (`src/verification.cts`) | `VERIFICATION_STATUS`, `VERIFIER_STATUSES`; `no-verification-status-literal` lint | fingerprint idempotence property (`tests/verification-status.test.cjs`); `lint-verify-lifecycle-writes`; `tests/drift-whole-change-set.test.cjs` P1c/P2c | 2: [#5103](https://github.com/open-gsd/gsd-core/pull/5103) · 3: [#5114](https://github.com/open-gsd/gsd-core/pull/5114) · 4: [#5131](https://github.com/open-gsd/gsd-core/pull/5131) · 5: [#5137](https://github.com/open-gsd/gsd-core/pull/5137) |
| C — gates | one `src/gate-*.cts` module per `check` gate; the router is the single output site | `GateVerdict` / `GateResult`, `Evidence<T>`, `GATE_FAILURE_CODE`, `gateExitOutcome` | `lint-gate-positive-control`: 16 gates, each with a control, empty allowlist | 6: [#5144](https://github.com/open-gsd/gsd-core/pull/5144) · 7: [#5168](https://github.com/open-gsd/gsd-core/pull/5168) · 8: [#5171](https://github.com/open-gsd/gsd-core/pull/5171) · 9: [#5205](https://github.com/open-gsd/gsd-core/pull/5205) · 14: this PR (four gates the first pass missed) |
| D — runtime activation | `hostBehaviorsFor` / `assertKnownRuntime` (`src/runtime-name-policy.cts`), `resolveAdvertisedNewProject` | `KNOWN_HOST_BEHAVIORS`; `UnknownRuntimeError` | `tests/runtime-descriptor-owner.test.cjs`, `tests/hook-registration-table.test.cjs`, `tests/hook-activation-probe.test.cjs`, `tests/advertised-command-parity.test.cjs`; `local/no-runtime-name-literal` | 10: [#5206](https://github.com/open-gsd/gsd-core/pull/5206) · 11: [#5208](https://github.com/open-gsd/gsd-core/pull/5208) · 12: [#5216](https://github.com/open-gsd/gsd-core/pull/5216) |
| E — planning writes | `PlanningDoc` (`replaceProse`, `updateBullet`, `updateHeading`) | the registry's planning-artifact set | `no-adhoc-markdown-parsing` `adhocSplitJoinMutation` / `adhocLineIndexedMutation`, with `invalid` rows in `tests/eslint-rules.test.cjs` | 13: [#5218](https://github.com/open-gsd/gsd-core/pull/5218) |

Phase 0 was [#5058](https://github.com/open-gsd/gsd-core/pull/5058) (with the scope-resolver amendment [#5141](https://github.com/open-gsd/gsd-core/pull/5141)). The phase PR bodies of Phases 0–6 and 8–13 record a census; Phase 7's ([#5168](https://github.com/open-gsd/gsd-core/pull/5168)) does not mention one, and its zero is carried by `scripts/lint-evaluation-scope-drift.cjs` (rules S1–S5, in `lint:ci`), which fails on any bespoke commit-range or file-set derivation. The identifiers the ADR named for deletion (`determinePhaseStatus`, `foldPhaseStatus`, `derivePhaseStatusLabel`, `applyRoadmapEdits`, the router-local copies of `extractYamlBlock`, `extractXmlTagBodies` and `readWorkflowConfig`, the three `_hostBehaviors` copies) no longer exist as definitions; three comments still name the Phase 1 identifiers, and `extractXmlTagBodies` lives on in the sectionizer seam (`src/markdown-sectionizer.cts`) as §4 directed.

`/adr-phase-coverage` was re-run against the shipped state (14 decisions, Phases 0–13, each decision owned by exactly one merged phase) and reports no orphan, no dangling deferral and no multi-owner.

**What the first verification pass found.** Arm C was not complete after Phase 9: four `check` verbs still emitted their own output outside a gate module (see the Phase 9 amendment). They moved in Phase 14, so the arm was ratified only after it held.

**Limits carried forward, not claimed.** The `settings-json` hook adapter is the one the activation probe executes; the `kimi-hooks-toml`, `codex-hooks-json` and `cursor-hooks-json` adapters keep their own registration tests (Phase 12 amendment). `src/state-transition.cts` `stripTemplatePlaceholders` belongs to #4629 (Phase 13 amendment). The remaining `verify` verbs that are not `check` gates keep `emitVerbVerdict`.

## References

- Epic: [#5056](https://github.com/open-gsd/gsd-core/issues/5056) · Phase 0: [#5057](https://github.com/open-gsd/gsd-core/issues/5057)
- Subsumed epics (design input, carried forward): [#4907](https://github.com/open-gsd/gsd-core/issues/4907), [#4631](https://github.com/open-gsd/gsd-core/issues/4631), [#4632](https://github.com/open-gsd/gsd-core/issues/4632)
- Not subsumed, in progress: [#4629](https://github.com/open-gsd/gsd-core/issues/4629) / [ADR-4629](4629-state-write-intent-beyond-frontmatter.md)
- Owners this ADR builds on: [ADR-3180](3180-planning-semantic-model-single-owner.md) (§7.4 `isPhaseComplete`, §7.5 `scanPhasePlans`), [ADR-4910](4910-planning-document-seam.md) (`PlanningDoc`), [ADR-3889](3889-process-exit-contract.md) (exit contract), [ADR-1016](1016-runtime-capability-descriptor.md) and [ADR-3660](3660-runtime-artifact-layout-module.md) (runtime descriptor and layout), [ADR-2346](2346-command-dispatch-completion.md) (router shape), [ADR-3626](3626-context-md-seam-claim-gate.md) (seam claims)
- Prior art for the scope resolver: closed PR #4127, branch `fix/3926-tier3-diff-tip-bound`

## Amendment (2026-10-09): a reporting path may catch the refusal (#5236)

The §5 rule is unchanged: every accessor that would answer with a Claude Code value refuses an UNKNOWN runtime id through `assertKnownRuntime`, and install code keeps that refusal. A reporting path that can state "could not run" may catch the refusal as a caller, instead of crashing the command that reads it. The reasoning is the Phase 10 amendment's for `hostBehaviorsFor`: a throw would crash a session rather than skip a behavior. Two callers do this:

- `checkAgentsInstalled` (Agent Install Check Module) returns `agents_installed: null` with `reason: 'unknown_runtime'` (`AGENTS_INSTALLED_REASON`), so every `init` command, `validate agents` and `docs-init` keep working for an UNKNOWN id.
- `buildAgentSkillsBlock` treats an UNKNOWN id as having no global skills directory GSD can locate: `global:` entries are skipped with a warning.

The catch is narrow: only `UnknownRuntimeError`. `RetiredRuntimeError` and every other error still propagate.

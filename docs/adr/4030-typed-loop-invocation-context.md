# ADR-4030: Typed invocation context on `loop render-hooks`

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** #4030
- **Amends:** [ADR-857](857-capability-system.md) — adds a typed `context` field to the `loop render-hooks` envelope the Ratification section names as shipped (the 12 Loop Extension Points' render-hook call sites).
- **Implementation:** Additive, optional field on the existing `loop render-hooks` CLI and JSON envelope ([ADR-857](857-capability-system.md)). No new command, dependency, or persisted state.

## Decision

`cmdLoopRenderHooks` (`src/loop-resolver.cts`) accepts one new optional flag,
`--phase <token>`, supplied by the invoking workflow at phase-scoped points
(`discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:wave:pre`,
`execute:wave:post`, `execute:post`, `verify:pre`, `verify:post`). `<token>` uses the same
bare-tolerant grammar every phase-scoped workflow already holds
(`phase_number` from its own `init.*` query — e.g. `"05"`), not the bracket
display form. Workstream scoping needs no new plumbing: `gsd-tools.cjs`
already resolves `--ws`/`GSD_WORKSTREAM` generically for every command before
dispatch (`resolveActiveWorkstream` / `applyResolvedWorkstreamEnv`). Each phase-scoped
`render-hooks` call site now forwards `${GSD_WS:+--ws=${GSD_WS##* }}`, so phase
resolution and hook activation use the invoking workstream.

The resolver never treats a caller-supplied directory as a source of truth. It
resolves `phaseDir` itself by calling `guardedFindPhase(cwd, phase,
config.project_code)` (`src/phase-locator.cts`) — the same function `init.*`
uses, not the bare `findPhaseInternal` it wraps — and surfaces both as an
additive `context: { phase, phaseDir }` field, where `phaseDir` is the
literal on-disk directory name the underlying `findPhaseInternal` matched
(`toPosixPath(path.join(relBase, match))`), never a caller-supplied string.
Because the result is drawn from a `readdirSync` listing filtered by
`matchPhaseDirs`, path traversal and absolute-path substitution are
structurally unreachable. A symlinked `.planning`, workstream or `phases`
parent is not: the resolver realpath-confines the directory under the project's
`.planning/phases` and omits `context` with a warning on escape.
Going through `guardedFindPhase` rather than the bare primitive also carries
its `isForeignPrefixedPhaseQuery` check (`src/phase-id.cts`, the #2056/#2105
guard): a `project_code`-scoped repo gets the identical #2237 foreign-prefix
protection `init.*` already has, rather than reopening it for this new call
site — confirmed with a hostile-token test (`tests/loop-render-hooks.test.cjs`).

`--phase-dir <dir>` is accepted alongside `--phase`, as the issue's spec asks,
but strictly as a **cross-check on the token's resolution** — never as an
independent path. The comparison is filesystem identity: `fs.statSync` on both
the supplied value and the locator's directory, equal `dev`+`ino` (where the
filesystem reports `ino` 0, as some Windows volumes do, `realpath` equality
stands in). Any spelling
of the same directory matches — relative, absolute, `./`-prefixed, `..`
segments, a symlinked spelling, or a different case on a case-insensitive
volume — and no per-platform case folding is guessed. Sibling commands accept
absolute paths (`resolvePath`, `src/check-command-router.cts`), so a caller
following that convention must not silently lose its context. The value emitted
is always the locator's, so this is a comparison convenience, not a second
path source. A stat failure is a mismatch. When it matches, the envelope is
unchanged; when it does not, `context` is omitted with a warning naming both.
`--phase-dir` alone is refused, since there is then no resolution to check it
against. Two consequences follow. An out-of-project value (`/etc`, `../..`)
cannot reach `context`: only the locator's value is emitted, and the realpath
confinement above covers the symlink case.
And a *wrong-phase* value — `--phase 05 --phase-dir .planning/phases/07-other`,
where both paths are inside the project and would survive any containment
check — is rejected too, which confinement alone could never do.

`guardedFindPhase` does not throw on a missing, ambiguous, or foreign-prefixed
phase — it returns `null`/`found: false` (with `ambiguous_matches` when more
than one directory matches). `cmdLoopRenderHooks` mirrors `cmdInitPhaseOp`'s
existing #2237 handling of that same shape: `context` is omitted and a
warning is appended to the envelope's existing `warnings` array, not thrown
or exited non-zero — `--phase` degrades to "no context", it does not fail
the render. Omitting `--phase` entirely preserves today's `{ point,
activeHooks, rendered, warnings? }` shape exactly.

Generic `step`/`gate`/`contribution` dispatch (`gsd-core/references/loop-hook-dispatch.md`)
projects `context.phase` / `context.phaseDir` into the dispatched handler's
invocation (CLI arg, agent prompt, or command payload per handler kind).
**Invocation context is authoritative for task-local phase identity.** A
capability MUST use it over `STATE.current_phase` or artifact-order/mtime
inference when both are available — `STATE.current_phase` is project lifecycle
status, not a claim about which phase the current invocation is scoped to, and
diverges from it whenever one phase plans/verifies while another executes.

## Consequences

- `context` appears in the `loop render-hooks` envelope only when `--phase` is
  passed and resolves. Without `--phase`, the envelope is unchanged.
- An unresolvable, ambiguous, foreign-prefixed, escaping, or mismatched
  `--phase`/`--phase-dir` omits `context` and appends a warning; hooks still
  dispatch and the command does not exit non-zero.
- Handlers must treat `context` as optional and fall back to their prior
  behavior when it is absent.

## Rationale

- **The gap is narrower than "no context exists," and that is exactly why it
  is easy to miss.** `loop-hook-dispatch.md`'s `step` → `ref.command` rule
  already does `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw` today
  — but `${PHASE_NUMBER}` is whatever shell variable the host workflow
  happens to hold at that call site, unvalidated and uncorrelated with the
  resolved point. Before this ADR, the `ref.skill`/`ref.agent` bullets in
  `loop-hook-dispatch.md` said nothing about a phase argument at all — so any
  point without its own bespoke, per-workflow phase-filling prose gets no
  phase argument, silently. This is not hypothetical: `nyquist`'s
  `verify:post` step (`capabilities/nyquist/capability.json`) is
  `{"ref":{"skill":"validate-phase"}}`, dispatched through `verify-work.md`'s
  generic `kind == "step"` loop (no bespoke phase-filling there, unlike
  `plan-phase.md`). `gsd-validate-phase`'s own argument contract —
  `argument-hint: "[phase number]", "Phase: $ARGUMENTS — optional, defaults
  to last completed phase"` — silently falls back to artifact-order inference
  exactly like the originating issue describes, precisely because the
  generic dispatch path gave it nothing else to use. `plan-phase.md`'s
  `plan:pre`/`plan:post`
  points are the exception, not the rule: its own "Generic step hook
  dispatch contract" (§5.6) already hand-fills `${PHASE}` for `ref.skill`
  args and `ref.agent` prompts, and does so correctly: `$PHASE` there is the
  raw token this file resolves from `$ARGUMENTS` (`PHASE="${BASH_REMATCH[1]}"`),
  the same bare-tolerant spelling `guardedFindPhase` accepts as input and
  denotes the same phase this ADR's `context.phase` derives — not literally
  identical (`5` vs the normalized `05`), but the same phase either way — so
  §5.6 is unaffected by this ADR and is left as-is. Formalizing `context` as a resolver-derived,
  validated envelope field closes the gap with one seam that every point can
  rely on, instead of requiring each workflow to hand-roll its own
  phase-filling prose the way `plan-phase.md` happened to.
- **Rejected: doc-only convention (no code change).** Extend the
  `ref.skill`/`ref.agent` bullets in `loop-hook-dispatch.md` to instruct each
  host workflow to pass its own already-known `$PHASE`/`$PHASE_DIR` into the
  dispatched prompt/command by hand. Rejected because this is a prose
  contract every host workflow and every runtime adapter would re-derive or
  paraphrase independently — precisely the per-capability/per-adapter
  inference the issue rejects — and a non-Claude runtime adapter projecting
  the envelope onto a native hook payload has no prose to read from. A typed
  field is the only shape an adapter can project.
- **Rejected: `phaseDir` as an INDEPENDENT caller input.** The issue's spec has
  the caller pass both `--phase` and `--phase-dir`, each validated on its own
  with a hand-rolled path-confinement check. `--phase-dir` is accepted (see
  Decision), but never as its own source of truth, for two reasons that do not
  expire when confinement is available:
  - It would need new containment logic where `guardedFindPhase` already
    resolves the same fact, duplicating an invariant this repo's own
    [ADR-3473](3473-enforcement-by-construction.md) ("one owner per invariant")
    argues against. Confinement helpers exist (`tryWithinRoot` /
    `assertWithinRoot`, `src/security.cts`), but they answer only "is this
    path inside the project", not "is this the phase's directory".
  - **Confinement would not be sufficient even once written.** `--phase 05
    --phase-dir .planning/phases/07-other` names two different in-project
    phases; both survive any containment check, and the pair is still
    incoherent. Comparing the supplied directory against the token's own
    resolution is what rejects it. #4354 hardens the callee for `check
    predicate`, which is the correct fix there and complementary to this one —
    it makes an out-of-project path safe, while this makes a *wrong-phase* path
    detectable.
- **Evidence.** This is a property gap verified in-tree (above), not a
  single external bug report — the originating issue cites one, but that
  report cannot on its own distinguish "wrong phase received" from "hook
  mis-dispatched" (a separate, already-tracked concern in #3606/#3647), so
  it is not relied on here as the sole justification.

## Deviations from #4030, ruled on PR #5265

Maintainer rulings recorded in review `60fee2ba299b` (2026-10-18):

- **(a) AC3 warn-and-omit: ACCEPTED.** A rejected `--phase` (no match, ambiguous, foreign prefix, `--phase-dir` mismatch) yields a warning and no `context`; hooks still dispatch. Callers capture `X=$(gsd_run ...)` without checking exit status, so a hard failure would drop every hook; this matches the resolver stance on #4393.
- **(b) AC1 locator-derived `phaseDir`: ACCEPTED.** `phaseDir` is derived by the resolver, project-relative, from the phase locator (`.planning/phases/05-widgets`, stable across checkouts), not caller-supplied as the issue's absolute example shows. `--phase-dir` is a cross-check on `--phase`, never an independent path (see Decision); no shipped call site passes it.

## Scope notes

- Points that are not phase-scoped pass no `--phase`: `ship:pre`/`ship:post` run per release; `quick.md` (`plan:pre`, `execute:post`) and `quick-batch/steps/planner-wave.md` (`plan:pre`) are task-scoped with no phase; `audit-milestone.md` (`verify:post`) is milestone-scoped. `code-review.md`'s `REVIEWER_POINT` call reads only `contribution` fragments for the reviewer, which never consume `context`, and the reviewer-lane `dispatch-step` verb resolves its own hook only to read `supportsReviewerLanes`; neither needs a phase.
- Each fenced bash block may run as its own shell (it does in Claude Code). A call site whose phase variable is bound in an earlier fence relies on the dispatching agent carrying the resolved token, as it carries `{phase_dir}`; the test suite lists those sites and the binding each relies on. It classifies a site only by where its phase variable is bound, not by what that binding reads: same-fence sites (`secure-phase`, `validate-phase`, `code-review-fix`, `execute-phase` `execute:post`, `autonomous` `execute:post`, the UI contract) still rely on the host carrying the variables their phase binding reads (`PHASE_ARG`, `GSD_WS`, `$PHASE_STATE`, or the `INIT` query) from an earlier fence. The `init.*` bindings read the phase with `--pick phase_number`, never `jq`. A missed carry or an empty phase becomes `--phase ""`, which warns on stderr and omits `context` (ruling (a)); `loop-hook-dispatch.md` then passes no phase argument (the host's `PHASE_NUMBER` fills in only when `--phase` was never passed, never for a rejected token). Only the `ref.command` branch of `loop-hook-dispatch.md` is behaviourally exercised (the `[projection]` test builds its handler argv); the `ref.skill` and `ref.agent` branches stay prose, and the tests only pin that their phase instructions survive the Claude and Codex projections. Call sites add no `[ -n "$PHASE_NUMBER" ]` guard: the warning is the signal, and skipping the call would drop the hooks.

## Revisit if

A later ADR generalizes loop invocation context beyond `phase`/`phaseDir`
(e.g. workstream, milestone) — this ADR's `context` field would extend, not
be replaced, since the additive-envelope shape already accommodates new keys.

## References

- [ADR-857](857-capability-system.md) — capability system / loop extension points this field extends.
- [ADR-3473](3473-enforcement-by-construction.md) — "one owner per invariant"; why `phaseDir` is derived, not caller-supplied.
- `gsd-core/references/loop-hook-dispatch.md` — generic dispatch contract this ADR's `context` field extends.
- `src/phase-locator.cts`'s `guardedFindPhase` / `findPhaseInternal` / `searchPhaseInDir` — existing phase-token-to-directory resolution this ADR reuses rather than re-implements. #4030 moved `guardedFindPhase` here from `src/init.cts` so its second consumer does not have to reach through the first.

## Out of scope

`gate-predicate-evaluator.cts` already accepts a `--phase-dir` value on the
unrelated `check predicate` command and does not confine it to the project, so
a blocking gate can pass on a file outside it. Pre-existing, not introduced or
fixed by this ADR — this ADR removes its own caller-supplied path rather than
adding one — and tracked separately as #4354.

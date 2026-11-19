'use strict';
// hooks/lib/isolation-deny-reason.js — shared, frozen reason-code enum for
// the #3045 dispatch-isolation guards' block/deny decisions
// (hooks/gsd-agent-isolation-guard.js, hooks/gsd-cursor-subagent-start.js).
//
// CONTRIBUTING.md ("Prohibited: Raw Text Matching on Test Outputs") bans
// asserting on a hook's free-form, human-readable reason/user_message prose
// — that text is for the operator/model reading the denial and may change
// wording without notice. Every block/deny decision therefore ALSO carries
// one of these STABLE codes (surfaced on the hook's stdout JSON as
// `reason_code`), so tests assert `out.reason_code === REASON_CODE.X`
// instead of regexing the message (mirrors the REASON enum convention in
// gsd-core/bin/verify-reapply-patches.cjs).
//
// Adding a new code requires updating this enum AND any test that locks the
// documented set.
const REASON_CODE = Object.freeze({
  // The compiled runtime library (gsd-core/bin/lib/*.cjs) is missing and
  // could not be self-built (ensure-runtime-build.cjs's RuntimeBuildError).
  RUNTIME_BUILD_FAILED: 'runtime_build_failed',
  // The project's dispatch-isolation configuration ('.planning/config.json')
  // could not be read or resolved for a reason OTHER than a runtime-build
  // failure (unreadable/malformed config, unexpected resolver error).
  CONFIG_UNREADABLE: 'config_unreadable',
  // Isolation resolves to "harness-worktree" but the Agent()/Task() dispatch
  // is missing the harness's isolation flag/kwarg.
  HARNESS_FLAG_MISSING: 'harness_flag_missing',
  // Isolation resolves to "harness-worktree" but the dispatch payload carries
  // no usable subagent_type, so the guard cannot confirm it is a GSD executor.
  NO_SUBAGENT_TYPE: 'no_subagent_type',
  // Isolation resolves to "harness-worktree" but whether the workspace root
  // is an isolated worktree could not be determined (e.g. git unresponsive).
  CANNOT_DETERMINE_ISOLATION: 'cannot_determine_isolation',
  // Isolation resolves to "harness-worktree" and the workspace root is
  // confirmed NOT an isolated worktree.
  NOT_ISOLATED_WORKTREE: 'not_isolated_worktree',
});

// #4594 row 15 / F2: values interpolated into a deny reason (sentinel/dispatch
// phase and plan) come from a sentinel file on disk and, transitively, from
// model-authored prompt text, neither of which is trusted — bound length and
// strip control characters/newlines so a crafted value cannot forge extra
// lines or otherwise inject content into the guard's stdout/stderr message
// (same discipline as escaping an untrusted token before embedding it in a
// message, e.g. phase-plan-index's `depends_on` warning).
//
// Originally duplicated byte-for-byte in hooks/gsd-agent-isolation-guard.js
// and hooks/gsd-cursor-subagent-start.js (#4594 F2 review finding) — both
// hooks already require this dependency-free module, so there is no
// cold-load justification for the duplication the way there is for
// hooks/lib/dispatch-identity.js's grammar mirror. Moved here as the single
// owner; both hooks now import it.
const REASON_INTERPOLATION_MAX_LEN = 64;

// F6: also strip Unicode line/paragraph separators (U+2028/U+2029) and the
// bidi-override/isolate control characters (U+202A-U+202E, U+2066-U+2069) —
// none of these are in `[\x00-\x1f\x7f]`, so a crafted sentinel or dispatch
// value carrying them could still visually reflow the deny message onto a
// new line or reverse/hide part of it despite the ASCII control-char strip.
const REASON_UNSAFE_CHARS_RE = new RegExp(
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars/newlines
  '[\\x00-\\x1f\\x7f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);

function sanitizeForReason(value) {
  if (typeof value !== 'string' || value.length === 0) return '(none)';
  const stripped = value.replace(REASON_UNSAFE_CHARS_RE, '');
  return stripped.length > REASON_INTERPOLATION_MAX_LEN
    ? `${stripped.slice(0, REASON_INTERPOLATION_MAX_LEN)}…`
    : stripped;
}

// #6028: which remedy a flag-missing / not-isolated deny gives. A stable code (surfaced on the hook's stdout
// JSON as `remedy`) so tests assert it instead of the prose, like REASON_CODE.
const REMEDY = Object.freeze({
  // The default: add the harness flag (Claude) or start an isolated session (Cursor): one code for the
  // "isolate this dispatch" advice, since the hooks share the seam.
  ADD_FLAG: 'add_flag',
  // A fresh recorded sequential degrade (`none`) for a different phase existed but did not apply to this
  // dispatch: the remedy is to record an applicable decision (null on every other deny path: not applicable).
  RECORD_APPLICABLE_DECISION: 'record_applicable_decision',
});

/**
 * True when the discarded record was a recorded sequential degrade (isolation `none`) for a DIFFERENT phase than
 * the dispatch. A `none` for another plan of the same phase is not matched: it can be a per-plan decision (a
 * submodule intersection, #2474) and adding the flag is then still the right fix.
 */
function isRecordedDegradeDiscard(sentinelDiscarded) {
  if (!sentinelDiscarded || !sentinelDiscarded.sentinel || !sentinelDiscarded.dispatch) return false;
  const { sentinel, dispatch } = sentinelDiscarded;
  return sentinel.isolation === 'none' && !!sentinel.phase && !!dispatch.phase && sentinel.phase !== dispatch.phase;
}

/** The remedy code for a deny whose natural advice is to add the flag / start an isolated session. */
function remedyFor(sentinelDiscarded) {
  return isRecordedDegradeDiscard(sentinelDiscarded) ? REMEDY.RECORD_APPLICABLE_DECISION : REMEDY.ADD_FLAG;
}

/**
 * The remedy text for a recorded degrade that did not apply to this dispatch (#6028). Names the recorded
 * degrade and both identifiers and says how to record a decision that applies, instead of telling the
 * orchestrator to do what the degrade's base-check refused.
 */
// #6028: the dispatch phase is copied into a runnable command line below, so it is echoed only when it is a
// well-formed phase token; anything else (it comes from the orchestrator's prompt marker, which accepts almost
// any text) becomes the `<phase>` placeholder. Mirrors DISPATCH_PHASE_TOKEN_SOURCE in
// hooks/lib/dispatch-identity.js (a test pins the two equal; this module stays dependency-free).
const PHASE_ARG_SOURCE = '\\d+[A-Za-z]?(?:\\.\\d+)*';
const PHASE_ARG_RE = new RegExp(`^${PHASE_ARG_SOURCE}$`);
const PHASE_ARG_MAX_LEN = 32;

function safePhaseArg(phase) {
  return typeof phase === 'string' && phase.length <= PHASE_ARG_MAX_LEN && PHASE_ARG_RE.test(phase) ? phase : '<phase>';
}

function describeRecordedDegradeRemedy(sentinelDiscarded) {
  const sentinelPhase = sanitizeForReason(sentinelDiscarded.sentinel.phase);
  const sentinelPlan = sanitizeForReason(sentinelDiscarded.sentinel.plan);
  const dispatchPhase = sanitizeForReason(sentinelDiscarded.dispatch.phase);
  const dispatchPlan = sanitizeForReason(sentinelDiscarded.dispatch.plan);
  const phaseArg = safePhaseArg(sentinelDiscarded.dispatch.phase);
  return (
    ` A sequential degrade (isolation "none") was recorded for phase="${sentinelPhase}" plan="${sentinelPlan}" ` +
    `but it did not apply to this dispatch (phase="${dispatchPhase}" plan="${dispatchPlan}"). If that degrade came ` +
    `from the worktree base-check refusing the harness worktree for this repository, isolating this dispatch ` +
    `(adding the harness flag or starting an isolated session) is what the base-check refused; record a decision ` +
    `that applies to this dispatch with \`gsd_run query dispatch-isolation --raw --phase ${phaseArg} ` +
    `--force-isolation none\` and retry. Otherwise isolate the dispatch as usual.`
  );
}

function describeSentinelDiscard(sentinelDiscarded) {
  const sentinelPhase = sanitizeForReason(sentinelDiscarded.sentinel.phase);
  const sentinelPlan = sanitizeForReason(sentinelDiscarded.sentinel.plan);
  const dispatchPhase = sanitizeForReason(sentinelDiscarded.dispatch.phase);
  const dispatchPlan = sanitizeForReason(sentinelDiscarded.dispatch.plan);
  return (
    ` A fresh dispatch-isolation sentinel was present but did not apply to this dispatch ` +
    `(sentinel phase="${sentinelPhase}" plan="${sentinelPlan}"; dispatch phase="${dispatchPhase}" ` +
    `plan="${dispatchPlan}"), so it was not consulted.`
  );
}

/**
 * The remedy tail of a deny whose natural advice is `addAdvice` (add the flag / start an isolated session):
 * the advice plus the discarded-sentinel note when no recorded degrade is involved, otherwise the recorded
 * degrade's remedy in its place. One composition for both hooks, so they cannot diverge (#6028).
 */
function composeRemedyText(sentinelDiscarded, addAdvice) {
  if (remedyFor(sentinelDiscarded) === REMEDY.RECORD_APPLICABLE_DECISION) return describeRecordedDegradeRemedy(sentinelDiscarded);
  return addAdvice + (sentinelDiscarded ? describeSentinelDiscard(sentinelDiscarded) : '');
}

module.exports = {
  REASON_CODE,
  REMEDY,
  PHASE_ARG_SOURCE,
  composeRemedyText,
  isRecordedDegradeDiscard,
  remedyFor,
  describeRecordedDegradeRemedy,
  REASON_INTERPOLATION_MAX_LEN,
  sanitizeForReason,
  describeSentinelDiscard,
};

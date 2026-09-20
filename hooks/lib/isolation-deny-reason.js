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

module.exports = {
  REASON_CODE,
  REASON_INTERPOLATION_MAX_LEN,
  sanitizeForReason,
  describeSentinelDiscard,
};

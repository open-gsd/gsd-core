"use strict";
/**
 * Runtime identity — prove which package's `gsd-tools` actually executed (#3146).
 *
 * The predecessor package `get-shit-done-cc` publishes a colliding `gsd-tools`
 * bin (verified 2026-08-24 against 1.42.3: `bin.gsd-tools -> bin/gsd-sdk.js`),
 * and exposes verbs of the same name with different semantics. #3129 is the
 * worked example: `phases.clear` archives here and **deletes** there, and the
 * output is success-shaped either way, so 43 phase directories went missing
 * with no warning.
 *
 * That collision is now prevented in the resolver rather than detected here:
 * the launcher's PATH branch resolves `gsd_run`, which only this package
 * publishes and which self-locates to its sibling shim, so a foreign binary is
 * unreachable from PATH. The path-based branches — a project-local install, a
 * runtime config directory — have no such structural guarantee: they trust
 * their configured location. #3841 closes that remaining route by making the
 * launcher preamble PROBE the resolved tool once, before any verb runs, and
 * warn when it cannot prove it is this package. This module backs both the
 * `runtime-identity` verb the preamble calls and the vocabulary that gate
 * reports in (`IDENTITY_STATUS`).
 *
 * The rollout is warn-then-fail (the #3146 maintainer ruling): the preamble
 * prints one actionable line and proceeds. It cannot hard-fail yet because
 * `no_identity_verb` does not distinguish a foreign package from an
 * `@opengsd/gsd-core` older than the verb — and during rollout the old-version
 * case is the common one, so a hard failure would stop working installs.
 *
 * Parsing is deliberately STRICT. The whole value of the check is telling "us"
 * from "not us"; a lenient parse that accepts the predecessor's usage text as
 * close-enough would reproduce the exact silent success #3129 already produced.
 * Liberality is spent on visibility instead — distinct reason codes, each
 * naming what actually happened.
 *
 * The classifier and the shell preamble are held in agreement by a
 * cross-surface parity test (#3841): both read stdout only and must reach the
 * same verdict for the same payload, or the preamble's warning and this
 * module's diagnostic would silently diverge on the same input.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDENTITY_RAW_PREFIX = exports.IDENTITY_STATUS = exports.EXPECTED_PACKAGE_NAME = void 0;
exports.classifyIdentityProbe = classifyIdentityProbe;
exports.statusForVerdict = statusForVerdict;
exports.buildIdentityPayload = buildIdentityPayload;
exports.explainVerdict = explainVerdict;
exports.cmdRuntimeIdentity = cmdRuntimeIdentity;
const package_identity_cjs_1 = require("./package-identity.cjs");
const capability_loader_cjs_1 = require("./capability-loader.cjs");
/** The package name a legitimate GSD runtime reports. Baked at build time (#498). */
exports.EXPECTED_PACKAGE_NAME = package_identity_cjs_1.packageName;
/**
 * The two-valued status the launcher preamble exports as `GSD_IDENTITY_STATUS`
 * (#3841). Frozen so it is a VALUE a test can assert on: CONTRIBUTING forbids
 * proving the gate fired by matching its human-readable warning prose.
 *
 * Two values, not five: the shell has no use for the distinction between
 * `no_identity_verb` and `unparseable` — it either holds proof or it does not.
 * The five-way {@link IdentityReason} stays the diagnostic vocabulary;
 * {@link statusForVerdict} is the only bridge between them.
 */
exports.IDENTITY_STATUS = Object.freeze({
    OK: 'ok',
    UNVERIFIED: 'unverified',
});
/**
 * The exact byte prefix the preamble anchors its `case` pattern to.
 *
 * ANCHORED, never a substring search. `JSON.stringify` emits keys in insertion
 * order and `buildIdentityPayload` inserts `packageName` first, so a genuine
 * `--raw` payload always STARTS with this. An unanchored match would verify the
 * decoy `{"packageName":"get-shit-done-cc","note":"@opengsd/gsd-core"}`, which
 * is exactly the shape a colliding package could publish.
 *
 * The preamble anchors at BOTH ends: its `case` pattern is this prefix, then
 * anything, then a literal `}`, so a truncated payload fails too. That is safe
 * for any future additive field — a JSON object's own closing brace is always
 * the last character, whatever the last value's type. It also pairs the literal
 * `{` for the raw-text brace guards the preamble is inlined into (#3841); the
 * pairing is a consequence of the stronger check, not the reason for it.
 */
exports.IDENTITY_RAW_PREFIX = `{"packageName":"${exports.EXPECTED_PACKAGE_NAME}"`;
/** Cap on echoed probe output so a warning can never dump a whole usage screen. */
const EVIDENCE_MAX_CHARS = 200;
function excerpt(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > EVIDENCE_MAX_CHARS ? `${flat.slice(0, EVIDENCE_MAX_CHARS)}…` : flat;
}
/**
 * `stdout` as a plain JSON object, or `null` when it is not one.
 *
 * `JSON.parse` accepts `0`, `"str"`, `[]`, `null` and `true`; arrays and `null`
 * are also `object` to `typeof`. All are rejected here so no downstream
 * truthiness check can mistake `[]` for a verified identity.
 */
function parseIdentityRecord(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    return parsed;
}
/**
 * Pure classifier: probe result -> verdict. Total — never throws, for any input.
 *
 * Non-object JSON (`0`, `"str"`, `[]`, `null`, `true`) is `unparseable`, not
 * `ok` and not a crash: `JSON.parse` accepts all of them, so a naive truthiness
 * check would let `[]` through as a verified identity.
 */
function classifyIdentityProbe(probe, expected = exports.EXPECTED_PACKAGE_NAME) {
    if (probe.spawnFailed || probe.timedOut) {
        return {
            reason: 'probe_failed',
            expected,
            detail: probe.timedOut ? 'identity probe timed out' : 'identity probe could not be spawned',
        };
    }
    // PARSE BEFORE CONSULTING THE EXIT CODE (#3841).
    //
    // The exit-code rule below is right for its stated reason -- the predecessor
    // prints a usage screen and exits 1, and that is "something else answered",
    // not a parse problem -- but it used to run FIRST, so it also caught a tool
    // that had already proved its identity and merely exited non-zero afterwards.
    // The shell preamble this module speaks for reads stdout ONLY (its command
    // substitution discards the status), so the two surfaces disagreed on exactly
    // that input: shell `ok`, classifier `no_identity_verb`. Measured against the
    // real snippet, not inferred. Since this classifier is the engine for the
    // announced hard-fail phase, such an install would have flipped from verified
    // to refused at rollout, in the phase where that stops the run.
    //
    // The predecessor defence is unaffected: a usage screen yields no usable
    // payload, so it still falls through to the exit-code branch below.
    const record = parseIdentityRecord(probe.stdout);
    if (record !== null) {
        const actual = record.packageName;
        if (typeof actual === 'string' && actual.length > 0) {
            // Unknown keys are ignored so a future payload addition cannot fail an
            // older check. The shell anchor is deliberately open in the middle for the
            // same reason, and the parity suite pins both halves of that (case P10).
            const version = typeof record.version === 'string' ? record.version : undefined;
            if (actual !== expected)
                return { reason: 'identity_mismatch', expected, actual, version };
            // ANCHOR PARITY (#3841). The shell preamble cannot parse JSON: it matches
            // a `case` pattern anchored at the START of stdout, so a payload only
            // verifies there when it begins at the first byte and serializes
            // `packageName` first. A purely structural parse would accept
            // `{"note":"x","packageName":"<us>"}` and a leading-whitespace payload
            // that the shell rejects -- a FAIL-OPEN disagreement between the two
            // surfaces.
            //
            // Reproduce those two properties SEMANTICALLY rather than byte-matching
            // IDENTITY_RAW_PREFIX. The prefix describes the `--raw` wire format, but
            // this classifier is also handed the DEFAULT pretty serialization
            // (`runtime-identity` with no `--raw`, which is two-space indented) --
            // byte-matching the compact prefix rejected that, which the remote matrix
            // caught. `startsWith('{')` and a first-key check hold for both.
            const firstKey = Object.keys(record)[0];
            if (!probe.stdout.startsWith('{') || firstKey !== 'packageName') {
                return {
                    reason: 'unparseable',
                    expected,
                    detail: 'payload names this package but is not in the anchored wire shape',
                };
            }
            return { reason: 'ok', expected, actual, version };
        }
    }
    // Nothing was proved. NOW the exit status is the discriminator: a non-zero
    // exit means a binary that does not implement this verb answered.
    if (probe.exitCode !== 0) {
        return {
            reason: 'no_identity_verb',
            expected,
            detail: `exit ${String(probe.exitCode)}: ${excerpt(probe.stdout)}`,
        };
    }
    return {
        reason: 'unparseable',
        expected,
        detail: record === null ? excerpt(probe.stdout) : 'payload has no usable packageName',
    };
}
/**
 * Collapse a five-way verdict onto the two-valued shell status.
 *
 * Total by construction: anything that is not `ok` is `unverified`. A future
 * sixth reason code therefore fails CLOSED here rather than silently verifying.
 */
function statusForVerdict(verdict) {
    return verdict.reason === 'ok' ? exports.IDENTITY_STATUS.OK : exports.IDENTITY_STATUS.UNVERIFIED;
}
/**
 * Build this runtime's identity payload.
 *
 * Version is REPORTED but not asserted in the warn phase, so a dev tree
 * reporting readHostVersion()'s fail-closed `0.0.0` still verifies. Carrying it
 * now means the hard-fail phase can gate on compatibility without a payload
 * change (and therefore without a second round of Hyrum's-Law exposure).
 */
function buildIdentityPayload(deps = {}) {
    const readVersion = deps.readVersion ?? (() => (0, capability_loader_cjs_1.readHostVersion)());
    const readName = deps.readPackageName ?? (() => exports.EXPECTED_PACKAGE_NAME);
    return { packageName: readName(), version: readVersion() };
}
/** Render a verdict as the one-line actionable warning the preamble prints. */
function explainVerdict(verdict, resolvedPath) {
    const head = `WARNING: "${resolvedPath}" did not report a ${verdict.expected} identity.`;
    const why = {
        ok: 'identity verified',
        identity_mismatch: `it reported "${verdict.actual ?? '(unknown)'}" instead`,
        no_identity_verb: 'it does not implement the runtime-identity verb — either a different package, or a gsd-core predating the verb',
        unparseable: 'its response could not be parsed as an identity payload',
        probe_failed: 'the identity probe could not be run',
    };
    const tail = 'A workflow shipped by this package may be running against a different tool. ' +
        'See docs/how-to/diagnose-a-foreign-gsd-tools.md';
    const evidence = verdict.detail ? ` (${verdict.detail})` : '';
    return `${head} Reason: ${why[verdict.reason]}${evidence}. ${tail}`;
}
/**
 * CLI arm for `gsd-tools runtime-identity`.
 *
 * Kept on the CJS fast path for the same reason as `current-timestamp`: it is a
 * pure local read, and the launcher preamble spawns it once per workflow run,
 * so SDK bridge startup would be a per-run tax on every workflow.
 */
function cmdRuntimeIdentity(raw = false, deps = {}) {
    const payload = buildIdentityPayload(deps);
    process.stdout.write(`${JSON.stringify(payload, null, raw ? 0 : 2)}\n`);
}

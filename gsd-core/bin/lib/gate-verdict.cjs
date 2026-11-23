"use strict";
/**
 * GateVerdict — the value a gate module returns instead of printing (#5139, epic #5056,
 * ADR-5057 §4 first bullet, design D1).
 *
 * A gate module decides; the command router formats. A gate imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced) — it returns one of two shapes:
 *
 *   - `GateVerdict`      the gate reached an answer. `outcome` names it, `block` is the gate's
 *                        own blocking decision (set explicitly by each arm, never derived from
 *                        `outcome`), and `payload` is the exact ordered object the router
 *                        serializes (insertion order is the wire order).
 *   - `GateUsageFailure` the caller invoked the gate wrongly (missing argument, escaping path).
 *                        The router turns it into `error(message, code)`.
 *
 * Pure: no I/O, no imports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GATE_FAILURE_CODE = void 0;
exports.gateVerdict = gateVerdict;
exports.gateUnreadable = gateUnreadable;
exports.gateUsageFailure = gateUsageFailure;
exports.isGateUsageFailure = isGateUsageFailure;
/**
 * The `GateUsageFailure.failure.code` values a gate module produces. A gate module may not import
 * `./io.cjs` (whose `ERROR_REASON` owns these wire strings), so it names them here; the router
 * hands the code straight to `error()`. Values are pinned equal to `ERROR_REASON.USAGE` /
 * `ERROR_REASON.SDK_MISSING_ARG` / `ERROR_REASON.UNKNOWN` by the cutover-equivalence goldens and
 * the parity test in tests/check-router-cutover-equivalence.test.cjs.
 *
 * `UNKNOWN` is the reason `error()` records when its caller names none: the drift verbs' usage
 * failures never named one (#5219), and the JSON diagnostic's `reason` and the exit-contract v2
 * status (UNKNOWN is FAIL, 1; SDK_MISSING_ARG is USAGE, 64) are observable, so they keep it.
 */
exports.GATE_FAILURE_CODE = Object.freeze({
    USAGE: 'usage',
    SDK_MISSING_ARG: 'sdk_missing_arg',
    UNKNOWN: 'unknown',
});
/**
 * Build a verdict. `payload` is copied (insertion order preserved) and the copy frozen, so a
 * verdict cannot be mutated after the gate returned it.
 */
function gateVerdict(outcome, block, payload) {
    return { outcome, block, payload: Object.freeze({ ...payload }) };
}
/**
 * Build the verdict for evidence that could not be read. `block` is the gate's own policy for that
 * arm (unchanged by this outcome); the exit status is derived from the outcome, never from `block`.
 */
function gateUnreadable(block, payload) {
    return gateVerdict('unreadable', block, payload);
}
/** Build a usage failure: exactly `{ failure: { code, message } }`. */
function gateUsageFailure(code, message) {
    return { failure: { code, message } };
}
/** Narrow a `GateResult` (or any value) to a `GateUsageFailure`. */
function isGateUsageFailure(result) {
    if (result === null || typeof result !== 'object')
        return false;
    const failure = result.failure;
    return typeof failure === 'object' && failure !== null;
}

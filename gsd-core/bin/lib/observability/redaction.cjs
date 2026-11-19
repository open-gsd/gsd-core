"use strict";
/**
 * Arg redaction policy — issue #177 (ADR-457 build-at-publish: the
 * hand-written bin/lib/observability/redaction.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * Privacy default: args are OMITTED from every emitted event (both stderr
 * and file audit). Opt-in: set GSD_AUDIT_ARGS=1 to include args verbatim.
 *
 * This module is deliberately simple and has no side effects — redaction
 * decisions are stateless reads of process.env at call time so that tests
 * can toggle the env var without module-level caching issues.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldIncludeArgs = shouldIncludeArgs;
exports.redactEvent = redactEvent;
/**
 * Returns true when the caller has opted in to including args in events.
 * Only GSD_AUDIT_ARGS === '1' enables inclusion; any other value (including
 * empty string, 'true', 'yes') keeps the default of omitting args.
 */
function shouldIncludeArgs() {
    return process.env.GSD_AUDIT_ARGS === '1';
}
/**
 * Return a redacted copy of a DispatchEvent.
 *
 * If args should be omitted (default), strips the `args` field entirely.
 * If args should be included (GSD_AUDIT_ARGS=1), passes the event through
 * unchanged (args were already set by makeDispatchEvent with includeArgs:true,
 * or absent — in which case they stay absent).
 *
 * The original event object is never mutated (it is frozen by makeDispatchEvent).
 *
 * @param event - A DispatchEvent (frozen or plain).
 * @returns A new plain object with the same fields, minus args when redacted.
 */
function redactEvent(event) {
    if (shouldIncludeArgs()) {
        // Include path: return a shallow copy with args preserved if present
        const copy = Object.assign({}, event);
        return copy;
    }
    // Exclude path: build a copy omitting `args`
    const { args: _dropped, ...rest } = event;
    return rest;
}

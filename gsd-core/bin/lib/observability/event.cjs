"use strict";
/**
 * DispatchEvent shape factory — issue #177 (ADR-0174 P1.3), extended in #178 (P1.4).
 *
 * Creates a structured event record for every Hub dispatch, used by
 * DispatchLogger to emit stderr errors and opt-in file audit trails.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/observability/event.cjs collapsed to a TypeScript source of truth.
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Shape:
 *   traceId:       string           — UUID v4, generated per dispatch
 *   parentTraceId: string|undefined — propagated from the caller when it is a canonical UUID v4
 *                                     (RFC 4122); invalid values are silently coerced to undefined.
 *   command:       string  — the dispatched verb
 *   args?:         unknown — only present when includeArgs === true
 *   result:        { kind: 'ok' | 'UnknownCommand' | 'InvalidArgs' | 'HandlerRefusal' | 'HandlerFailure' | 'VerificationStatusInvalid', ...payload }
 *   timestamp:     string  — ISO 8601
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeDispatchEvent = makeDispatchEvent;
const node_crypto_1 = require("node:crypto");
/**
 * Canonical UUID v4 regex (RFC 4122).
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Returns true only when value is a canonical UUID v4 string.
 */
function isValidParentTraceId(value) {
    return typeof value === 'string' && UUID_V4_REGEX.test(value);
}
/**
 * Create a DispatchEvent.
 */
function makeDispatchEvent({ command, args, result, includeArgs = false, parentTraceId, }) {
    const resolvedParentTraceId = isValidParentTraceId(parentTraceId) ? parentTraceId : undefined;
    const event = {
        traceId: (0, node_crypto_1.randomUUID)(),
        parentTraceId: resolvedParentTraceId,
        command: String(command),
        result,
        timestamp: new Date().toISOString(),
    };
    if (includeArgs && args !== undefined) {
        event.args = args;
    }
    return Object.freeze(event);
}

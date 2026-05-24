'use strict';

/**
 * DispatchEvent shape factory — issue #177 (ADR-0174 P1.3), extended in #178 (P1.4).
 *
 * Creates a structured event record for every Hub dispatch, used by
 * DispatchLogger to emit stderr errors and opt-in file audit trails.
 *
 * Shape:
 *   traceId:       string           — UUID v4, generated per dispatch
 *   parentTraceId: string|undefined — propagated from the caller when it is a canonical UUID v4
 *                                     (RFC 4122); invalid values are silently coerced to undefined.
 *                                     Enables a future init-composer (Phase 2) to correlate child
 *                                     dispatches to their parent via the audit file.
 *   command:       string  — the dispatched verb
 *   args?:         unknown — only present when includeArgs === true
 *   result:        { kind: 'ok' | 'UnknownCommand' | 'InvalidArgs' | 'HandlerRefusal' | 'HandlerFailure', ...payload }
 *   timestamp:     string  — ISO 8601
 */

const { randomUUID } = require('crypto');

/**
 * Canonical UUID v4 regex (RFC 4122).
 * - 36 characters total (32 hex + 4 hyphens)
 * - Version nibble: 4
 * - Variant bits: [89ab]
 * - Case-insensitive: accepts both upper- and lowercase hex
 *
 * Used to validate parentTraceId before propagation. traceId is always
 * generated internally by crypto.randomUUID() and is guaranteed valid.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns true only when value is a canonical UUID v4 string.
 * Any other value (non-string, wrong format, wrong version/variant) → false.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidParentTraceId(value) {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/**
 * Create a DispatchEvent.
 *
 * @param {object} opts
 * @param {string}   opts.command     - The dispatched command verb.
 * @param {unknown}  [opts.args]      - Raw args passed to the hub.
 * @param {object}   opts.result      - The HubResult returned by the hub.
 * @param {boolean}  [opts.includeArgs=false] - When true, include args in the event.
 * @param {string}   [opts.parentTraceId]     - Must be a canonical UUID v4 (RFC 4122).
 *   Invalid values (non-string, wrong format, wrong version/variant) are silently coerced
 *   to undefined — no stderr warn is emitted. This prevents correlation poisoning from
 *   unvalidated caller input while keeping the factory pure and side-effect-free.
 * @returns {object} Immutable DispatchEvent record.
 */
function makeDispatchEvent({ command, args, result, includeArgs = false, parentTraceId }) {
  // Validate parentTraceId against UUID v4 format before propagation.
  // Invalid inputs (empty string, non-UUID, UUID v1, oversized, etc.) are silently
  // coerced to undefined. Silent coercion keeps the factory pure — no side effects,
  // no log spam on bad input, consistent with how non-string values already collapse.
  const resolvedParentTraceId = isValidParentTraceId(parentTraceId) ? parentTraceId : undefined;

  const event = {
    traceId: randomUUID(),
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

module.exports = { makeDispatchEvent };

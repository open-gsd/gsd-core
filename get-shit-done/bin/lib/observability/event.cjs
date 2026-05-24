'use strict';

/**
 * DispatchEvent shape factory — issue #177 (ADR-0174 P1.3).
 *
 * Creates a structured event record for every Hub dispatch, used by
 * DispatchLogger to emit stderr errors and opt-in file audit trails.
 *
 * Shape:
 *   traceId:       string  — UUID v4, generated per dispatch
 *   parentTraceId: undefined — always undefined in P1.3; P1.4 wires the composer
 *   command:       string  — the dispatched verb
 *   args?:         unknown — only present when includeArgs === true
 *   result:        { kind: 'ok' | 'UnknownCommand' | 'InvalidArgs' | 'HandlerRefusal' | 'HandlerFailure', ...payload }
 *   timestamp:     string  — ISO 8601
 */

const { randomUUID } = require('crypto');

/**
 * Create a DispatchEvent.
 *
 * @param {object} opts
 * @param {string}   opts.command     - The dispatched command verb.
 * @param {unknown}  [opts.args]      - Raw args passed to the hub.
 * @param {object}   opts.result      - The HubResult returned by the hub.
 * @param {boolean}  [opts.includeArgs=false] - When true, include args in the event.
 * @param {string}   [opts.parentTraceId]     - Ignored in P1.3; always yields undefined.
 * @returns {object} Immutable DispatchEvent record.
 */
function makeDispatchEvent({ command, args, result, includeArgs = false, parentTraceId: _ignored }) {
  const event = {
    traceId: randomUUID(),
    parentTraceId: undefined,
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

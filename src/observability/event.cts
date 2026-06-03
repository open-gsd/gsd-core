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
 *   result:        { kind: 'ok' | 'UnknownCommand' | 'InvalidArgs' | 'HandlerRefusal' | 'HandlerFailure', ...payload }
 *   timestamp:     string  — ISO 8601
 */

import { randomUUID } from 'node:crypto';

/**
 * Canonical UUID v4 regex (RFC 4122).
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns true only when value is a canonical UUID v4 string.
 */
function isValidParentTraceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/** A HubResult object (open shape — callers supply concrete payloads). */
export type HubResult = Record<string, unknown>;

export interface MakeDispatchEventOpts {
  command: string;
  args?: unknown;
  result: HubResult;
  includeArgs?: boolean;
  parentTraceId?: unknown;
}

/** An immutable DispatchEvent record. */
export interface DispatchEvent {
  readonly traceId: string;
  readonly parentTraceId: string | undefined;
  readonly command: string;
  readonly args?: unknown;
  readonly result: HubResult;
  readonly timestamp: string;
}

/**
 * Create a DispatchEvent.
 */
export function makeDispatchEvent({
  command,
  args,
  result,
  includeArgs = false,
  parentTraceId,
}: MakeDispatchEventOpts): Readonly<DispatchEvent> {
  const resolvedParentTraceId = isValidParentTraceId(parentTraceId) ? parentTraceId : undefined;

  const event: {
    traceId: string;
    parentTraceId: string | undefined;
    command: string;
    result: HubResult;
    timestamp: string;
    args?: unknown;
  } = {
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

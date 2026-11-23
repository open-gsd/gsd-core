"use strict";
/**
 * Resolution Convention — canonical shape for config-interpreting read verbs.
 *
 * Extracted as the anchor for ADR-1411 P3 (Resolution Provenance, #1416).
 * Exports the `Resolution<T>` envelope used when a verb reads and interprets
 * configuration (e.g. agent-skills). Not used by mutation verbs (see
 * capability-writer's `SetCapabilityStateResult` for the mutation shape) or
 * plain read verbs (see capability-state's `ResolveCapabilityRuntimeStateResult`).
 *
 * This is a pure types+builder leaf — no other src/ imports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeResolution = makeResolution;
// ─── Builder ──────────────────────────────────────────────────────────────────
/**
 * Construct a `Resolution<T>` envelope from a value and its provenance fields.
 */
function makeResolution(value, opts) {
    return {
        value,
        configured: opts.configured,
        reason: opts.reason,
        warnings: opts.warnings,
    };
}

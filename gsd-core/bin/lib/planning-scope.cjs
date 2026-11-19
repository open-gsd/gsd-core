"use strict";
/**
 * Planning Scope — shared result discriminator for live-plan scanning.
 *
 * ADR-3180 Decision 2 (docs/adr/3180-planning-semantic-model-single-owner.md):
 * `scanPhasePlans` is the single owner of live-plan counting, and every
 * consumer of that count needs to distinguish a REAL answer from a
 * NON-answer. `SCOPE.COMPLETE` with zero items is a real answer — a phase
 * genuinely has no plans yet. `SCOPE.TRUNCATED`, `SCOPE.UNSCOPED`, and
 * `SCOPE.UNREADABLE` with zero items are NOT — they mean the scan could not
 * see (part of) the phase directory, so a caller must not treat that zero as
 * "this phase has no plans."
 *
 * This is a frozen enum, not a message string: CONTRIBUTING.md bans raw-text
 * matching on outputs and requires a typed IR, so callers branch on the
 * `SCOPE` value rather than pattern-matching prose.
 *
 * PROVISIONAL: this contract is pending this phase's validation and may be
 * revised before the epic (#3180) ships.
 *
 * Dependencies: none — this is a leaf module (mirrors src/phase-id.cts). It
 * imports nothing, so any consumer can depend on it without risking a cycle.
 */
const SCOPE = Object.freeze({
    COMPLETE: 'complete',
    TRUNCATED: 'truncated',
    UNSCOPED: 'unscoped',
    UNREADABLE: 'unreadable',
});
const planningScope = { SCOPE };
module.exports = planningScope;

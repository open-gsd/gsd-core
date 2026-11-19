/**
 * Embedding adapter contract — the common `HostIntegrationInterface` both
 * embedding adapters satisfy (ADR-1239 Phase C-1, #1680).
 *
 * INTENTIONALLY MINIMAL (Phase 3 slice 1). The full six-interface-point binding
 * surface (command / dispatch / model / hooks / state / artifact) is DEFERRED
 * until the imperative adapter (AC2) provides a real consumer that fixes the
 * shape — ADR-1239 lists the wire-shape as an open question:
 *   "Exact wire-shape of the initialize handshake … Where precisely to cut the
 *    engine↔host boundary"
 * (docs/adr/1239-gsd-embeddable-orchestration-engine.md#open-questions-narrowed-by-the-research).
 * Freezing a 6-point contract before the imperative adapter exists would risk
 * rework across Phases 3-6. This slice ships only what the declarative adapter
 * (AC1) needs: the kind discriminator + runtime + install/uninstall entry.
 *
 * Both adapters bind the SAME engine (install-engine.cjs / the loop resolver);
 * they differ in HOW — declarative projects files (lossy: drops loop
 * orchestration), imperative drives host primitives in-process. See ADR-1239
 * "How a capability reaches a host (two adapters, one engine)".
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADAPTER_KINDS = void 0;
// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------
exports.ADAPTER_KINDS = Object.freeze(['declarative', 'imperative']);

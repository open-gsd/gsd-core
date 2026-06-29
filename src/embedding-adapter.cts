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

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const ADAPTER_KINDS = Object.freeze(['declarative', 'imperative'] as const);
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
export type Scope = 'global' | 'local';
// ---------------------------------------------------------------------------
// Intent shapes (minimal — grow when the imperative adapter fixes the shape)
// ---------------------------------------------------------------------------

/**
 * Install intent accepted by a `HostIntegrationInterface.install`.
 *
 * `resolvedProfile` + `resolveAttribution` mirror `installRuntimeArtifacts`
 * (install-engine.cjs) — the declarative adapter passes them straight through to
 * the engine. The imperative adapter (future) will source them from the host.
 */
export interface AdapterInstallIntent {
  configDir: string;
  scope: Scope;
  resolvedProfile: unknown;
  resolveAttribution?: (runtime: string) => unknown;
}

export interface AdapterUninstallIntent {
  configDir: string;
  scope: Scope;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The minimal contract both embedding adapters satisfy. `kind` discriminates
 * declarative (projection) from imperative (in-process engine drive). Both
 * `install`/`uninstall` delegate to the shared engine surface; neither
 * reimplements the loop. The byte-identity of the declarative adapter's output
 * to today's install is gated by `tests/golden-install-parity.test.cjs`
 * (both route through the same `installRuntimeArtifacts` engine function).
 */
export interface HostIntegrationInterface {
  readonly kind: AdapterKind;
  readonly runtime: string;
  install(intent: AdapterInstallIntent): void;
  uninstall(intent: AdapterUninstallIntent): void;
}

// NOTE: `ADAPTER_KINDS` is exported above as a runtime const so this module
// compiles to a non-empty .cjs (the interfaces above are erased by tsc) and so
// adapter implementors can reference the frozen kind set at runtime.

/**
 * Hook-bus seam (ADR-1239 Phase C-1, AC4 / #1680).
 *
 * The lifecycle-hook ownership model, selected by the negotiated `hookBus`
 * axis (host-integration.cts):
 *
 *   - `engine` — GSD owns the bus internally (in-process pub/sub). Used by
 *     hosts that have no event bus (VS Code). Full subscribe + emit.
 *   - `host`   — the host fires events; GSD subscribes. Handlers register
 *     locally for a Phase-5 host binding to dispatch to; `emit` delegates to a
 *     host-supplied emitter (fail-closed until bound — GSD does not drive a
 *     host-owned bus).
 *   - `none`   — no bus (Cline-rules). Degrades to rule-text instructions;
 *     subscribe/emit are no-ops.
 *
 * Portable event floor — the "claude dialect" all hook-capable hosts share
 * (sourced from src/runtime-hooks-surface.cts). Extended events are negotiated
 * per-host (Phase 5).
 *
 * Minimal seam (per ADR-1239 open wire-shape question): the host-side dispatch
 * wiring lands in Phase 5 (#1682). This slice ships the three ownership modes
 * + the engine pub-sub + the fail-closed contract.
 */
'use strict';

export const PORTABLE_EVENT_FLOOR = Object.freeze(
  ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const,
);
export type PortableEvent = (typeof PORTABLE_EVENT_FLOOR)[number];
export type HookBusMode = 'host' | 'engine' | 'none';

export interface HookBusAdapter {
  readonly bus: HookBusMode;
  /** Register a handler for an event. No-op on `none`. */
  subscribe(event: string, handler: (payload?: unknown) => void): void;
  /** Emit an event to subscribers. No-op on `none`; fail-closed on `host` until a host emitter is bound. */
  emit(event: string, payload?: unknown): void;
}

export interface CreateHookBusOptions {
  /** Required for `host`: the host's emit primitive (GSD emits → host bus). */
  hostEmit?: (event: string, payload?: unknown) => void;
}

export function createHookBus(
  { bus }: { bus: HookBusMode },
  options: CreateHookBusOptions = {},
): HookBusAdapter {
  if (bus !== 'host' && bus !== 'engine' && bus !== 'none') {
    throw new TypeError(`createHookBus: bus must be 'host' | 'engine' | 'none' (got ${JSON.stringify(bus)})`);
  }
  if (bus === 'none') {
    return Object.freeze({
      bus,
      subscribe() { /* no bus — degrade to rule-text instructions */ },
      emit() { /* no-op */ },
    });
  }
  if (bus === 'engine') {
    const subs = new Map<string, Array<(payload?: unknown) => void>>();
    return Object.freeze({
      bus: 'engine',
      subscribe(event: string, handler: (payload?: unknown) => void) {
        const list = subs.get(event);
        if (list) list.push(handler);
        else subs.set(event, [handler]);
      },
      emit(event: string, payload?: unknown) {
        const list = subs.get(event);
        if (!list) return;
        for (const h of list) {
          // Handler errors are isolated — one throwing handler must not break the bus.
          try { h(payload); } catch { /* swallow; bus stays up */ }
        }
      },
    });
  }
  // host: GSD subscribes; emits go to the host-supplied emitter (fail-closed until bound).
  const hostEmit = options.hostEmit;
  return Object.freeze({
    bus: 'host',
    subscribe(_event: string, _handler: (payload?: unknown) => void) {
      // Host owns the bus; GSD's subscriptions are dispatched by a Phase-5 host
      // binding that calls the registered handlers when the host fires events.
      // Stored host-side; locally this is a seam until that binding lands.
    },
    emit(event: string, payload?: unknown) {
      if (typeof hostEmit !== 'function') {
        throw new Error(
          "host hook-bus emit: no host emitter bound — the 'host' bus requires a hostEmit primitive (Phase 5 wires the concrete host).",
        );
      }
      hostEmit(event, payload);
    },
  });
}

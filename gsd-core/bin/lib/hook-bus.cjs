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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PORTABLE_EVENT_FLOOR = void 0;
exports.createHookBus = createHookBus;
exports.PORTABLE_EVENT_FLOOR = Object.freeze(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
function createHookBus({ bus }, options = {}) {
    if (bus !== 'host' && bus !== 'engine' && bus !== 'none') {
        throw new TypeError(`createHookBus: bus must be 'host' | 'engine' | 'none' (got ${JSON.stringify(bus)})`);
    }
    if (bus === 'none') {
        return Object.freeze({
            bus,
            subscribe() { },
            emit() { },
        });
    }
    if (bus === 'engine') {
        const subs = new Map();
        return Object.freeze({
            bus: 'engine',
            subscribe(event, handler) {
                const list = subs.get(event);
                if (list)
                    list.push(handler);
                else
                    subs.set(event, [handler]);
            },
            emit(event, payload) {
                const list = subs.get(event);
                if (!list)
                    return;
                for (const h of list) {
                    // Handler errors are isolated — one throwing handler must not break the bus.
                    try {
                        h(payload);
                    }
                    catch { /* swallow; bus stays up */ }
                }
            },
        });
    }
    // host: GSD subscribes; emits go to the host-supplied emitter (fail-closed until bound).
    const hostEmit = options.hostEmit;
    return Object.freeze({
        bus: 'host',
        subscribe(_event, _handler) {
            // Host owns the bus; GSD's subscriptions are dispatched by a Phase-5 host
            // binding that calls the registered handlers when the host fires events.
            // Stored host-side; locally this is a seam until that binding lands.
        },
        emit(event, payload) {
            if (typeof hostEmit !== 'function') {
                throw new Error("host hook-bus emit: no host emitter bound — the 'host' bus requires a hostEmit primitive (Phase 5 wires the concrete host).");
            }
            hostEmit(event, payload);
        },
    });
}

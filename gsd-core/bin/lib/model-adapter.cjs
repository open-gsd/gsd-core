/**
 * Model adapter seam (ADR-1239 Phase C-1, AC3 / #1680).
 *
 * Two model-layer adapters selected by the negotiated `modelMode` axis
 * (host-integration.cts):
 *
 *   - `passive` — GSD can only inject prompts / a per-agent `model` field (the
 *     CLI runtimes: claude/gemini/codex/opencode/cursor/…). Formalizes today's
 *     tier routing from src/model-resolver.cts: `resolveModel` delegates
 *     straight to `resolveModelForTier`, so passive reproduces current behavior
 *     byte-for-behavior.
 *   - `active` — the host exposes a provider `sendRequest` (VS Code `vscode.lm`,
 *     pi providers). GSD calls the model through the host. Ships here as a SEAM:
 *     a host-supplied `sendRequest` slot, fail-closed until a real consumer
 *     binds it (Phase 5 / #1682).
 *
 * Minimal (per ADR-1239 open wire-shape question): one factory, two shapes
 * discriminated by `mode`. Concrete provider protocol (request/response shape)
 * is fixed when a real active host lands in Phase 5.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModelAdapter = createModelAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const modelResolver = require("./model-resolver.cjs");
function createModelAdapter({ modelMode }, options = {}) {
    if (modelMode !== 'passive' && modelMode !== 'active') {
        throw new TypeError(`createModelAdapter: modelMode must be 'passive' | 'active' (got ${JSON.stringify(modelMode)})`);
    }
    if (modelMode === 'passive') {
        return Object.freeze({
            mode: 'passive',
            resolveModel({ cwd, agentType, attempt }) {
                return modelResolver.resolveModelForTier(cwd, agentType, attempt);
            },
        });
    }
    // active: bind the host's sendRequest, fail-closed if absent.
    const sendRequest = options.sendRequest;
    return Object.freeze({
        mode: 'active',
        sendRequest(req) {
            if (typeof sendRequest !== 'function') {
                throw new Error('ActiveModelAdapter.sendRequest: no host provider bound — the active model seam ' +
                    'requires a sendRequest primitive from the host (Phase 5 wires a concrete provider).');
            }
            return sendRequest(req);
        },
    });
}

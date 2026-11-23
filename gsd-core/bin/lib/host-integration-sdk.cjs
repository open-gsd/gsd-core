/**
 * Host-Integration SDK — the published public surface (ADR-1239 Phase E / #1683).
 *
 * External host-plugin authors import ONLY from this entry. It IS the contract:
 * everything it re-exports is public + versioned (PROTOCOL_VERSION governs the
 * set); everything else in gsd-core is internal. An SDK smoke test
 * (tests/sdk-smoke.test.cjs) builds a new host-plugin against this surface only
 * — proving an external author can wire a host without reading gsd-core internals.
 *
 * Surface: the negotiated schema + classification, the five adapters
 * (declarative/imperative/model/hook/state), and the serialized handshake.
 * Frozen so the public shape cannot be mutated by consumers.
 */
'use strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hostIntegration = require("./host-integration.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adapterDeclarative = require("./adapter-declarative.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adapterImperative = require("./adapter-imperative.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const modelAdapter = require("./model-adapter.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hookBus = require("./hook-bus.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stateIo = require("./state-io.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const handshake = require("./handshake-serialized.cjs");
const SDK = Object.freeze({
    // ── Schema + protocol version ────────────────────────────────────────────
    PROTOCOL_VERSION: hostIntegration.PROTOCOL_VERSION,
    HOST_INTEGRATION_AXES: hostIntegration.HOST_INTEGRATION_AXES,
    INTERFACE_POINTS: hostIntegration.INTERFACE_POINTS,
    PROFILE_BASELINES: hostIntegration.PROFILE_BASELINES,
    // ── Negotiation + classification ─────────────────────────────────────────
    negotiateHostCapabilities: hostIntegration.negotiateHostCapabilities,
    profileOf: hostIntegration.profileOf,
    degradationFor: hostIntegration.degradationFor,
    hookEventSurfaceFor: hostIntegration.hookEventSurfaceFor,
    extensionEventSurfaceFor: hostIntegration.extensionEventSurfaceFor,
    shouldFlattenDispatch: hostIntegration.shouldFlattenDispatch,
    // ── Embedding + engine adapters ──────────────────────────────────────────
    createDeclarativeAdapter: adapterDeclarative.createDeclarativeAdapter,
    createImperativeAdapter: adapterImperative.createImperativeAdapter,
    createModelAdapter: modelAdapter.createModelAdapter,
    createHookBus: hookBus.createHookBus,
    createStateIO: stateIo.createStateIO,
    // ── Serialized handshake (out-of-process SDK hosts: pi / VS Code) ─────────
    HANDSHAKE_METHOD: handshake.HANDSHAKE_METHOD,
    buildHandshakeRequest: handshake.buildHandshakeRequest,
    handleHandshakeRequest: handshake.handleHandshakeRequest,
});
module.exports = SDK;

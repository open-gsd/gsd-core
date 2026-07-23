/**
 * Serialized (out-of-process) capability-exchange handshake (ADR-1239 Phase E / #1683).
 *
 * Phase 1's `negotiateHostCapabilities` is IN-PROCESS (a host descriptor merged
 * directly into the engine). Out-of-process SDK hosts (pi, VS Code) cannot share
 * object references with the engine — they exchange a SERIALIZED capability set
 * over a wire boundary (an MCP-style `initialize`). This module is the wire form
 * of that handshake, kept CONSISTENT with the in-process negotiation: a request
 * built + serialized here MUST yield the same NegotiationResult the in-process
 * call produces for the same axes (asserted in tests/handshake-serialized.test.cjs).
 *
 * Wire shape (JSON — no object refs, safe across a process/IPC boundary):
 *
 *   request  = { protocolVersion: number, axes: Partial<HostIntegrationAxes> }
 *   response = NegotiationResult = { protocolVersion, effective, points, warnings }
 *
 * The engine side delegates to negotiateHostCapabilities; the host side builds
 * the request from a descriptor. Both round-trip through JSON so the exchange is
 * strictly serializable (a non-JSON-safe value would break the wire contract).
 *
 * Pure + additive: no I/O, no global state. The companion MCP server (Phase 4)
 * or an SDK host binds this to a real transport.
 */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import hostIntegration = require('./host-integration.cjs');

/** The wire method name for the initialize-style exchange. */
const HANDSHAKE_METHOD = 'gsd/host-initialize';

/**
 * Host side: build a JSON-serializable handshake request from a host descriptor.
 * Accepts either `{ protocolVersion?, axes }` or a bare axes object.
 * Defaults protocolVersion to the engine's current PROTOCOL_VERSION.
 */
function buildHandshakeRequest(hostDescriptor: unknown): { protocolVersion: number; axes: Record<string, unknown> } {
  if (!hostDescriptor || typeof hostDescriptor !== 'object') {
    throw new TypeError('buildHandshakeRequest: host descriptor (object) is required');
  }
  const desc = hostDescriptor as Record<string, unknown>;
  const hasAxes = Object.prototype.hasOwnProperty.call(desc, 'axes');
  const axes = (hasAxes ? desc.axes : desc) as Record<string, unknown>;
  if (!axes || typeof axes !== 'object') {
    throw new TypeError('buildHandshakeRequest: descriptor.axes (object) is required');
  }
  const protocolVersion =
    typeof desc.protocolVersion === 'number' && Number.isFinite(desc.protocolVersion)
      ? desc.protocolVersion
      : hostIntegration.PROTOCOL_VERSION;
  // Force a wire round-trip so a non-JSON-safe descriptor fails HERE, not later.
  return JSON.parse(JSON.stringify({ protocolVersion, axes })) as { protocolVersion: number; axes: Record<string, unknown> };
}

/**
 * Engine side: handle a serialized handshake request → a JSON-serializable
 * NegotiationResult. Delegates to negotiateHostCapabilities, so the result is
 * identical to the in-process negotiation for the same axes.
 */
function handleHandshakeRequest(
  request: unknown,
  engine: unknown = hostIntegration.DEFAULT_ENGINE,
): Record<string, unknown> {
  if (!request || typeof request !== 'object') {
    throw new TypeError('handleHandshakeRequest: request (object) is required');
  }
  const req = request as { protocolVersion?: unknown; axes?: unknown };
  const axes = (req.axes && typeof req.axes === 'object' ? req.axes : {}) as Record<string, unknown>;
  const protocolVersion = req.protocolVersion;
  const result = hostIntegration.negotiateHostCapabilities(
    { ...axes, ...(typeof protocolVersion === 'number' && Number.isFinite(protocolVersion) ? { protocolVersion } : {}) },
    engine as Parameters<typeof hostIntegration.negotiateHostCapabilities>[1],
  );
  // Force a wire round-trip: the response must be strictly JSON-serializable.
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

export = {
  HANDSHAKE_METHOD,
  buildHandshakeRequest,
  handleHandshakeRequest,
};

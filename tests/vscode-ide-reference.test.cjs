'use strict';

/**
 * VS Code IDE reference host — ADR-1239 Phase D / #1933.
 *
 * Completes the IDE profile: proves the Phase-3 engine seams (active model,
 * engine-owned hook bus, sandboxed-storage stateIO, imperative adapter) compose
 * for VS Code end-to-end (#1933 AC: "run GSD inside the VS Code IDE host through
 * its palette/chat command surface, with engine-owned hook bus + active model +
 * sandboxed stateIO (no child_process) handled by the adapters").
 *
 * VS Code is extension-distributed (Marketplace), not file-projected, so it has
 * no runtime descriptor/installer entry — the reference binding + these tests are
 * the provable surface (a live VS Code run is outside CI, same as every reference
 * host). Mock-friendly: vscode.lm + a hostStorage backend are injected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { profileOf, negotiateHostCapabilities } = require('../gsd-core/bin/lib/host-integration.cjs');
const bindGsdToVscode = require('./fixtures/vscode-host-binding.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

test('VS Code IDE axes classify as the ide profile', () => {
  // ide baseline (host-integration.cts PROFILE_BASELINES): imperative + sandboxed-web.
  assert.equal(profileOf({ embeddingMode: 'imperative', runtime: 'sandboxed-web' }), 'ide');
  assert.notEqual(profileOf({ embeddingMode: 'imperative', runtime: 'node' }), 'ide');
});

test('bindGsdToVscode composes the full IDE profile (active model + engine bus + sandboxed state + imperative adapter)', async () => {
  // Real API: vscode.lm.selectChatModels() (async → LanguageModelChat[]); the
  // SELECTED MODEL has .sendRequest, NOT vscode.lm itself (#2103 correction —
  // there is no vscode.lm.sendRequest).
  let lastLmReq = null;
  const vscode = {
    lm: {
      selectChatModels: async () => [
        { sendRequest: (req) => { lastLmReq = req; return 'lm-response'; } },
      ],
    },
  };
  const storageWrites = [];
  const hostStorage = {
    read: (p) => `content-of-${p}`,
    write: (p, c) => { storageWrites.push([p, c]); },
  };

  const host = bindGsdToVscode(vscode, hostStorage);
  assert.equal(host.runtime, 'vscode');

  // Active model routes through vscode.lm.selectChatModels() → model.sendRequest
  // (no system messages — User role only).
  assert.equal(host.model.mode, 'active');
  assert.equal(await host.model.sendRequest({ prompt: 'hi' }), 'lm-response');
  assert.deepEqual(lastLmReq, { prompt: 'hi' });

  // Engine-owned hook bus: in-process pub/sub (VS Code has no host bus).
  assert.equal(host.hookBus.bus, 'engine');
  let received = null;
  host.hookBus.subscribe('PreToolUse', (p) => { received = p; });
  host.hookBus.emit('PreToolUse', { tool: 'Read' });
  assert.deepEqual(received, { tool: 'Read' });

  // Sandboxed-storage routes through the host backend (NOT the filesystem).
  assert.equal(host.stateIO.io, 'sandboxed-storage');
  assert.equal(host.stateIO.read('/plan.md'), 'content-of-/plan.md');
  host.stateIO.write('/plan.md', 'new');
  assert.deepEqual(storageWrites, [['/plan.md', 'new']]);

  // Imperative adapter (engine-as-library) for the VS Code runtime.
  assert.equal(host.adapter.kind, 'imperative');
  assert.equal(host.adapter.runtime, 'vscode');

  // Command surface (palette/chat).
  assert.ok(host.commands['gsd.invoke'], 'palette/chat command surface present');
});

// #2103: proves the binding actually COMPOSES (does not throw) against a
// realistic desktop VS Code `vscode.lm` shape — the whole point of the guard
// fix: a real host has `selectChatModels`, never `sendRequest` directly, and
// the binding must succeed, not silently fail-open at the extension.js layer.
test('#2103: bindGsdToVscode composes successfully against a REALISTIC vscode.lm (selectChatModels only, no vscode.lm.sendRequest)', async () => {
  const vscode = {
    lm: {
      selectChatModels: async () => [{ sendRequest: (req) => Promise.resolve({ echoed: req }) }],
      // Deliberately no top-level sendRequest — matches the real API surface.
    },
  };
  const hostStorage = { read: () => '', write: () => {} };

  let host;
  assert.doesNotThrow(() => { host = bindGsdToVscode(vscode, hostStorage); },
    'bindGsdToVscode must succeed on a realistic host (selectChatModels-only vscode.lm)');
  assert.equal(host.model.mode, 'active');
  const response = await host.model.sendRequest({ prompt: 'hello' });
  assert.deepEqual(response, { echoed: { prompt: 'hello' } });
});

test('bindGsdToVscode is fail-closed without vscode.lm or hostStorage', () => {
  const okStorage = { read() {}, write() {} };
  const okVscode = { lm: { selectChatModels: async () => [] } };
  // vscode.lm missing or incomplete → vscode.lm error
  assert.throws(() => bindGsdToVscode({}, okStorage), /vscode\.lm/);
  assert.throws(() => bindGsdToVscode({ lm: {} }, okStorage), /vscode\.lm/);
  // valid vscode.lm but missing/incomplete hostStorage → hostStorage error
  assert.throws(() => bindGsdToVscode(okVscode, null), /hostStorage/);
  assert.throws(() => bindGsdToVscode(okVscode, { read() {} }), /hostStorage/);
});

test('#2103: bindGsdToVscode still throws when vscode.lm.selectChatModels is ABSENT (a vscode.lm.sendRequest-only mock, matching the OLD incorrect API assumption, must be rejected)', () => {
  const okStorage = { read() {}, write() {} };
  // The pre-#2103 (wrong) shape: sendRequest directly on vscode.lm, no selectChatModels.
  const staleShapeVscode = { lm: { sendRequest: () => 'stale' } };
  assert.throws(() => bindGsdToVscode(staleShapeVscode, okStorage), /selectChatModels/);
});

// ── #2103: negotiate fail-closed for an UNDECLARED vscode axis ──────────────
// negotiateHostCapabilities must never throw and must degrade an undeclared
// (missing) axis to its most-restrictive documented default — the same
// fail-closed contract already proven for the "undocumented" sentinel
// (tests/host-integration-descriptors.test.cjs), but exercised here against a
// genuinely ABSENT key (not the string "undocumented") on vscode's real
// hostIntegration object, to prove the negotiation seam is defensive against
// both failure modes.
//
// #2103 FIX (adversarial review, MINOR): strengthened from a weak
// `!== undefined` check to a STRICT equality against the actual
// most-restrictive value negotiateHostCapabilities produces — the fail-closed
// floor pinned as `SAFE_DEFAULTS` in gsd-core/bin/lib/host-integration.cjs
// (not exported, so the values are pinned here verbatim, verified via node -e
// against the real negotiation output before writing this test — see the PR
// report). A `!== undefined` check would pass even if negotiation regressed
// to a WRONG-but-defined value (e.g. a less-restrictive default) — this
// assertion pins the exact known floor per the AC's own wording
// ("most-restrictive known value").
const HOST_INTEGRATION_SAFE_DEFAULTS = {
  embeddingMode: 'declarative',
  commandSurface: 'prose-only',
  modelMode: 'passive',
  hookBus: 'none',
  stateIO: 'session-log-append',
  transport: 'mcp',
  runtime: 'node',
};
const HOST_INTEGRATION_DISPATCH_SAFE_DEFAULTS = {
  namedDispatch: false,
  nested: false,
  maxDepth: 0,
  background: false,
  subagentToolkit: 'read-only',
  backgroundDispatch: false,
};

test('#2103: negotiateHostCapabilities never throws for vscode with an UNDECLARED axis, and degrades to the EXACT most-restrictive SAFE_DEFAULTS value', () => {
  const realHi = registry.runtimes.vscode.runtime.hostIntegration;
  for (const axis of Object.keys(HOST_INTEGRATION_SAFE_DEFAULTS)) {
    const undeclared = { ...realHi, dispatch: { ...realHi.dispatch } };
    delete undeclared[axis];
    let result;
    assert.doesNotThrow(() => { result = negotiateHostCapabilities(undeclared); },
      `negotiateHostCapabilities must not throw when vscode's "${axis}" axis is entirely absent`);
    assert.strictEqual(result.effective[axis], HOST_INTEGRATION_SAFE_DEFAULTS[axis],
      `effective.${axis} must resolve to the exact most-restrictive SAFE_DEFAULTS value "${HOST_INTEGRATION_SAFE_DEFAULTS[axis]}", got: ${JSON.stringify(result.effective[axis])}`);
  }
});

test('#2103: negotiateHostCapabilities never throws for vscode with an UNDECLARED dispatch sub-axis, and degrades to the EXACT most-restrictive value', () => {
  const realHi = registry.runtimes.vscode.runtime.hostIntegration;
  for (const key of Object.keys(HOST_INTEGRATION_DISPATCH_SAFE_DEFAULTS)) {
    const undeclared = { ...realHi, dispatch: { ...realHi.dispatch } };
    delete undeclared.dispatch[key];
    let result;
    assert.doesNotThrow(() => { result = negotiateHostCapabilities(undeclared); },
      `negotiateHostCapabilities must not throw when vscode's dispatch.${key} is entirely absent`);
    assert.strictEqual(result.effective.dispatch[key], HOST_INTEGRATION_DISPATCH_SAFE_DEFAULTS[key],
      `effective.dispatch.${key} must resolve to the exact most-restrictive value "${HOST_INTEGRATION_DISPATCH_SAFE_DEFAULTS[key]}", got: ${JSON.stringify(result.effective.dispatch[key])}`);
  }
});

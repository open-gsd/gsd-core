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

const { profileOf } = require('../gsd-core/bin/lib/host-integration.cjs');
const bindGsdToVscode = require('./fixtures/vscode-host-binding.cjs');

test('VS Code IDE axes classify as the ide profile', () => {
  // ide baseline (host-integration.cts PROFILE_BASELINES): imperative + sandboxed-web.
  assert.equal(profileOf({ embeddingMode: 'imperative', runtime: 'sandboxed-web' }), 'ide');
  assert.notEqual(profileOf({ embeddingMode: 'imperative', runtime: 'node' }), 'ide');
});

test('bindGsdToVscode composes the full IDE profile (active model + engine bus + sandboxed state + imperative adapter)', () => {
  let lastLmReq = null;
  const vscode = {
    lm: { sendRequest: (req) => { lastLmReq = req; return 'lm-response'; } },
  };
  const storageWrites = [];
  const hostStorage = {
    read: (p) => `content-of-${p}`,
    write: (p, c) => { storageWrites.push([p, c]); },
  };

  const host = bindGsdToVscode(vscode, hostStorage);
  assert.equal(host.runtime, 'vscode');

  // Active model routes through vscode.lm (no system messages — User role only).
  assert.equal(host.model.mode, 'active');
  assert.equal(host.model.sendRequest({ prompt: 'hi' }), 'lm-response');
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

test('bindGsdToVscode is fail-closed without vscode.lm or hostStorage', () => {
  const okStorage = { read() {}, write() {} };
  const okVscode = { lm: { sendRequest() {} } };
  // vscode.lm missing or incomplete → vscode.lm error
  assert.throws(() => bindGsdToVscode({}, okStorage), /vscode\.lm/);
  assert.throws(() => bindGsdToVscode({ lm: {} }, okStorage), /vscode\.lm/);
  // valid vscode.lm but missing/incomplete hostStorage → hostStorage error
  assert.throws(() => bindGsdToVscode(okVscode, null), /hostStorage/);
  assert.throws(() => bindGsdToVscode(okVscode, { read() {} }), /hostStorage/);
});

'use strict';

/**
 * VS Code IDE host binding for GSD (ADR-1239 Phase D / #1933, shipped #2103).
 *
 * VS Code is the IDE-profile reference host. This module composes the Phase-3
 * engine seams for the negotiated `ide` profile (host-integration.cts
 * PROFILE_BASELINES):
 *
 *   - modelMode: 'active'        → createModelAdapter({modelMode:'active'}, {sendRequest})
 *                                  backed by `vscode.lm` (LanguageModelChat). There is NO
 *                                  `vscode.lm.sendRequest` — the real API is
 *                                  `const [model] = await vscode.lm.selectChatModels(selector?);
 *                                  const response = await model.sendRequest(messages, options?, token?);`
 *                                  (Context7-verified #2103). The injected `sendRequest` wrapper
 *                                  below selects a model on every call and delegates to IT. VS Code
 *                                  rejects system-role messages, so the request mapper uses User
 *                                  role only.
 *   - hookBus:   'engine'        → createHookBus({bus:'engine'}) — VS Code has NO host event bus,
 *                                  so GSD owns the bus in-process (full subscribe + emit).
 *   - stateIO:   'sandboxed-storage' → createStateIO({io:'sandboxed-storage'}, {backend}) bound to a
 *                                  host-supplied storage (no arbitrary FS — web/no-child_process safe
 *                                  AT THE STATE-IO SEAM ITSELF; see the DESKTOP-ONLY note below for
 *                                  why the module as a WHOLE is not safe to require from browser.js).
 *   - embeddingMode: 'imperative' → createImperativeAdapter({runtime:'vscode'}) — engine-as-library.
 *
 * Distribution: VS Code is shipped as an EXTENSION (Marketplace), NOT file-projected onto a
 * config dir, so it intentionally has NO runtime descriptor / `--vscode` installer entry — the
 * extension IS the host. This module is the binding `vscode/extension.js` (the Node/desktop
 * `main` entry) runs in activate().
 *
 * DESKTOP-ONLY (#2103 finding — do NOT require this from vscode/browser.js):
 * despite the per-seam design above being conceptually host-agnostic, the CONCRETE engine-lib
 * modules this file requires are NOT web-safe today — each pulls in Node's `fs`/`os`/`path`
 * at module-load time (eagerly, regardless of which code path actually runs):
 *   - gsd-core/bin/lib/state-io.cjs            → requires 'node:fs' directly.
 *   - gsd-core/bin/lib/adapter-imperative.cjs   → requires install-engine.cjs (fs/os/path) and
 *                                                  capability-loader.cjs (fs/os/path).
 *   - gsd-core/bin/lib/model-adapter.cjs        → requires model-resolver.cjs → config-loader.cjs
 *                                                  (fs/os/path) and configuration.cjs (fs/path).
 *   - gsd-core/bin/lib/hook-bus.cjs             → no requires; this one alone is web-safe.
 * In a real VS Code Web Extension host (webworker context) `require('node:fs')` does not
 * resolve — activation would throw immediately. This is why `vscode/browser.js` does NOT
 * require this module (or any of the engine-lib adapters) and instead implements its own
 * minimal, genuinely-zero-Node-API composition directly against `vscode.lm`. See browser.js's
 * header comment for the full rationale. Fixing the engine-lib modules to be fs-free is a
 * separate, much larger engine-wide refactor (config-loader/capability-loader/install-engine
 * all read real files from disk) — out of scope for the extension-surface stage; flagged here
 * for visibility rather than silently routed around.
 *
 * Mock-friendly: takes `vscode` (with `vscode.lm`) + `hostStorage` ({read,write}) so it is
 * behaviorally testable without a live VS Code host.
 *
 * @param {{ lm: { selectChatModels: (selector?: unknown) => Promise<Array<{ sendRequest: (messages: unknown, options?: unknown, token?: unknown) => unknown }>> } }} vscode
 *   VS Code namespace (vscode.lm.selectChatModels — NOT vscode.lm.sendRequest, which does not exist).
 * @param {{ read: (path: string) => string, write: (path: string, content: string) => void }} hostStorage
 *   sandboxed-storage backend (e.g. globalState/workspaceState/secrets).
 * @returns {object} the composed IDE host surface: { runtime, model, hookBus, stateIO, adapter, commands }
 */
module.exports = function bindGsdToVscode(vscode, hostStorage) {
  if (!vscode || !vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    throw new TypeError('bindGsdToVscode: vscode.lm.selectChatModels is required (active model provider — VS Code exposes no vscode.lm.sendRequest; a model is selected via selectChatModels() and ITS sendRequest is called)');
  }
  if (!hostStorage || typeof hostStorage.read !== 'function' || typeof hostStorage.write !== 'function') {
    throw new TypeError('bindGsdToVscode: hostStorage {read,write} is required (sandboxed-storage backend)');
  }

  const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
  const { createModelAdapter } = require('../gsd-core/bin/lib/model-adapter.cjs');
  const { createHookBus } = require('../gsd-core/bin/lib/hook-bus.cjs');
  const { createStateIO } = require('../gsd-core/bin/lib/state-io.cjs');

  // Active model: GSD model calls route through vscode.lm. There is no
  // `vscode.lm.sendRequest` — a model must be selected first
  // (`vscode.lm.selectChatModels()`, async → LanguageModelChat[]), then THAT
  // model's own `.sendRequest(messages, options?, token?)` is called. Selects
  // fresh on every call (no cross-call caching) so a model becoming available/
  // unavailable between calls is always reflected; gsd-core/bin/lib/model-adapter.cjs's
  // ActiveModelAdapter.sendRequest is a plain (non-async) pass-through that
  // returns whatever the injected function returns, so an async injected
  // function composes transparently — no adapter-side change needed (verified
  // by reading model-adapter.cjs: `sendRequest(req) { return sendRequest(req); }`).
  // No system-role messages — VS Code rejects them; a full extension builds
  // LanguageModelChatMessages with User role only.
  const model = createModelAdapter({ modelMode: 'active' }, {
    async sendRequest(req) {
      const models = await vscode.lm.selectChatModels();
      const [chatModel] = models || [];
      if (!chatModel || typeof chatModel.sendRequest !== 'function') {
        throw new Error('bindGsdToVscode: vscode.lm.selectChatModels() returned no usable model (no active model available)');
      }
      return chatModel.sendRequest(req);
    },
  });

  // Engine-owned hook bus: VS Code has no host bus, so GSD owns it in-process.
  const hookBus = createHookBus({ bus: 'engine' });

  // Sandboxed-storage stateIO bound to the host storage backend (no fs / no child_process).
  const stateIO = createStateIO({ io: 'sandboxed-storage' }, { backend: hostStorage });

  // Imperative adapter: the engine-as-library for the VS Code runtime.
  const adapter = createImperativeAdapter({ runtime: 'vscode' });

  // Command surface: Command Palette + Chat participant entries bound to the
  // GSD command-routing hub via the imperative adapter (interface point 1).
  const commands = Object.freeze({
    'gsd.invoke': Object.freeze({ description: 'Invoke a GSD command via the embedded engine (palette/chat).' }),
    'gsd.help': Object.freeze({ description: 'List GSD commands available in the IDE host.' }),
  });

  return Object.freeze({ runtime: 'vscode', model, hookBus, stateIO, adapter, commands });
};

'use strict';

/**
 * Reference VS Code IDE host binding for GSD (ADR-1239 Phase D / #1933).
 *
 * VS Code is the IDE-profile reference host. It composes the Phase-3 engine
 * seams for the negotiated `ide` profile (host-integration.cts PROFILE_BASELINES):
 *
 *   - modelMode: 'active'        → createModelAdapter({modelMode:'active'}, {sendRequest})
 *                                  backed by `vscode.lm` (LanguageModelChat). VS Code rejects
 *                                  system-role messages, so the request mapper uses User role only.
 *   - hookBus:   'engine'        → createHookBus({bus:'engine'}) — VS Code has NO host event bus,
 *                                  so GSD owns the bus in-process (full subscribe + emit).
 *   - stateIO:   'sandboxed-storage' → createStateIO({io:'sandboxed-storage'}, {backend}) bound to a
 *                                  host-supplied storage (no arbitrary FS — web/no-child_process safe).
 *   - embeddingMode: 'imperative' → createImperativeAdapter({runtime:'vscode'}) — engine-as-library.
 *
 * Distribution: VS Code is shipped as an EXTENSION (Marketplace), NOT file-projected onto a
 * config dir, so it intentionally has NO runtime descriptor / `--vscode` installer entry — the
 * extension IS the host. This module is the binding the extension's activate() runs.
 *
 * Mock-friendly: takes `vscode` (with `vscode.lm`) + `hostStorage` ({read,write}) so it is
 * behaviorally testable without a live VS Code host.
 *
 * @param {{ lm: { sendRequest: (req: unknown) => unknown } }} vscode   VS Code namespace (vscode.lm)
 * @param {{ read: (path: string) => string, write: (path: string, content: string) => void }} hostStorage
 *   sandboxed-storage backend (e.g. globalState/workspaceState/secrets).
 * @returns {object} the composed IDE host surface: { runtime, model, hookBus, stateIO, adapter, commands }
 */
module.exports = function bindGsdToVscode(vscode, hostStorage) {
  if (!vscode || !vscode.lm || typeof vscode.lm.sendRequest !== 'function') {
    throw new TypeError('bindGsdToVscode: vscode.lm.sendRequest is required (active model provider)');
  }
  if (!hostStorage || typeof hostStorage.read !== 'function' || typeof hostStorage.write !== 'function') {
    throw new TypeError('bindGsdToVscode: hostStorage {read,write} is required (sandboxed-storage backend)');
  }

  const { createImperativeAdapter } = require('../../gsd-core/bin/lib/adapter-imperative.cjs');
  const { createModelAdapter } = require('../../gsd-core/bin/lib/model-adapter.cjs');
  const { createHookBus } = require('../../gsd-core/bin/lib/hook-bus.cjs');
  const { createStateIO } = require('../../gsd-core/bin/lib/state-io.cjs');

  // Active model: GSD model calls route through vscode.lm. (No system-role
  // messages — VS Code rejects them; a full extension builds LanguageModelChatMessages
  // with User role only and selects a model via vscode.lm.selectChatModels.)
  const model = createModelAdapter({ modelMode: 'active' }, {
    sendRequest(req) {
      return vscode.lm.sendRequest(req);
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

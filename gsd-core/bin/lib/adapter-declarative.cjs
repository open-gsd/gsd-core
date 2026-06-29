/**
 * Declarative embedding adapter (ADR-1239 Phase C-1, AC1 / #1680).
 *
 * NAMES + BOUNDS today's projection path (file emission via install-engine)
 * behind `HostIntegrationInterface`. The declarative adapter is lossy by
 * design: it projects skills/agents/commands and does NOT drive the loop
 * orchestration (that is the imperative adapter's job, AC2 / a later slice).
 *
 * `install`/`uninstall` delegate IN-PROCESS to install-engine's
 * `installRuntimeArtifacts` / `uninstallRuntimeArtifacts` — the SAME engine
 * functions `bin/install.js` uses — so the adapter's output is byte-identical to
 * today's install (the link is gated by `tests/golden-install-parity.test.cjs`).
 * The module-ref call style (`installEngine.fn`) keeps it monkeypatch-friendly
 * for tests, mirroring the install-engine.cts:31-38 pattern.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeclarativeAdapter = createDeclarativeAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installEngine = require("./install-engine.cjs");
function createDeclarativeAdapter({ runtime }) {
    if (!runtime || typeof runtime !== 'string') {
        throw new TypeError('createDeclarativeAdapter: runtime is required (non-empty string)');
    }
    return Object.freeze({
        kind: 'declarative',
        runtime,
        install(intent) {
            installEngine.installRuntimeArtifacts(runtime, intent.configDir, intent.scope, intent.resolvedProfile, intent.resolveAttribution);
        },
        uninstall(intent) {
            installEngine.uninstallRuntimeArtifacts(runtime, intent.configDir, intent.scope);
        },
    });
}

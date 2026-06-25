'use strict';

/**
 * golden-install-parity.test.cjs — ADR-1239 Phase B safety-net harness.
 *
 * Captures a byte-stable manifest of every file emitted by the installer for
 * all 16 runtimes, so a later PR moving installRuntimeArtifacts can prove
 * byte-identical output parity.
 *
 * ## Determinism invariants (empirically established pre-Phase-B)
 *
 * After replacing every occurrence of the temp root path with the literal
 * '<HOME>' in file contents, the install output is byte-identical run-to-run
 * for ALL files EXCEPT exactly two volatile metadata files that are EXCLUDED
 * from the parity manifest:
 *   - gsd-file-manifest.json    (timestamp + install-time absolute paths)
 *   - gsd-install-state.json    (install-time absolute paths)
 *
 * Everything else (≈545–616 files per runtime) is deterministic.
 *
 * ## UPDATE mode
 *
 * Run with UPDATE_GOLDEN=1 to (re-)capture fixtures:
 *   UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { walk, RUNTIME_META, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI). The scoped
// CI test lane does not run build:hooks, so a real install there emits no hooks/
// dir — making the golden (captured with hooks built) report "removed (N) hooks/…".
// Build it idempotently here so the harness is lane-independent (mirrors the
// pattern in bug-1834-sh-hooks-installed and install-minimal-hooks).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

const UPDATE = process.env.UPDATE_GOLDEN === '1';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'golden-install-parity');

// Volatile metadata files always excluded from the parity manifest.
const VOLATILE_FILES = new Set(['gsd-file-manifest.json', 'gsd-install-state.json']);

// Hook-registration config files excluded from the parity manifest. These are
// written by the hook/permission install path (applySettingsJsonHooks /
// finishInstall) — NOT by installRuntimeArtifacts, so they are outside the scope
// of the engine deep-move this harness guards. They also embed the resolved
// node-runner invocation, whose FORM (absolute-quoted "/abs/bin/node" on macOS
// vs bare `node` resolved from PATH on Linux/CI) — not just the binary path —
// varies by platform and cannot be normalized to a single sentinel reliably.
// Their content is asserted directly by the dedicated hook tests
// (install-minimal-hooks, sh-hook-paths, codex-config, etc.). Matched by basename.
// settings.json = Claude/Antigravity/Augment/etc. hook surface; hooks.json =
// Codex/Cursor hook surface — both embed the platform-varying node-runner command.
const HOOK_CONFIG_FILES = new Set(['settings.json', 'hooks.json']);

/**
 * Build a deterministic hash-map of all non-volatile files under configDir.
 *
 * For each file:
 *   - rel  = POSIX-slash relative path from configDir
 *   - hash = sha256(content with root replaced by '<HOME>').slice(0,16)
 *
 * Returns a plain object with sorted keys for stable JSON comparison.
 *
 * @param {string} configDir - absolute path to the installed runtime config dir
 * @param {string} root      - temp root path to replace with '<HOME>'
 * @returns {{ [rel: string]: string }}
 */
function buildParityManifest(configDir, root) {
  const allFiles = walk(configDir);
  const unsorted = {};

  for (const full of allFiles) {
    // Build POSIX-style relative path for cross-platform stability
    const rel = path.relative(configDir, full).split(path.sep).join('/');

    if (VOLATILE_FILES.has(rel)) continue;
    if (HOOK_CONFIG_FILES.has(path.basename(rel))) continue;

    const content = fs.readFileSync(full);
    // Normalize every occurrence of the temp root so hashes are stable across runs.
    // The only other platform-varying content (the node-runner command form) lives
    // exclusively in the excluded HOOK_CONFIG_FILES, so no further normalization is
    // needed — a scan of all 16 installs confirmed no other file embeds it.
    const normalized = content.toString('utf8').split(root).join('<HOME>');
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    unsorted[rel] = hash;
  }

  // Reconstruct with sorted keys for stable JSON serialisation
  const sorted = {};
  for (const key of Object.keys(unsorted).sort()) {
    sorted[key] = unsorted[key];
  }
  return sorted;
}

// Ensure the fixture directory exists (needed for UPDATE mode)
if (UPDATE) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
}

const runtimes = Object.keys(RUNTIME_META);

for (const runtime of runtimes) {
  test(`golden parity — ${runtime}`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
      return;
    }
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    let actual;
    try {
      actual = buildParityManifest(configDir, root);
    } finally {
      cleanup(root);
    }

    const fixturePath = path.join(FIXTURE_DIR, `${runtime}.json`);

    if (UPDATE) {
      fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      const fileCount = Object.keys(actual).length;
      // Report to stdout so the capture run is self-documenting
      process.stdout.write(`  [UPDATE] ${runtime}: wrote ${fileCount} file hashes → ${fixturePath}\n`);
      return;
    }

    // Assert mode: compare against golden fixture
    if (!fs.existsSync(fixturePath)) {
      assert.fail(
        `Golden fixture missing for runtime '${runtime}': ${fixturePath}\n` +
        'Run UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs to capture.'
      );
    }

    const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const goldenKeys = new Set(Object.keys(golden));
    const actualKeys = new Set(Object.keys(actual));

    const added   = [...actualKeys].filter(k => !goldenKeys.has(k));
    const removed = [...goldenKeys].filter(k => !actualKeys.has(k));
    const changed = [...actualKeys].filter(k => goldenKeys.has(k) && actual[k] !== golden[k]);

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      const lines = [`Parity mismatch for runtime '${runtime}':`];
      if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
      if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
      if (changed.length) lines.push(`  changed (${changed.length}): ${changed.join(', ')}`);
      lines.push('Run UPDATE_GOLDEN=1 to recapture if the change is intentional.');
      assert.deepEqual(actual, golden, lines.join('\n'));
    }
  });
}

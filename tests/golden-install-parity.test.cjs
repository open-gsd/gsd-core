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
 * for ALL files EXCEPT the volatile metadata files that are EXCLUDED
 * from the parity manifest:
 *   - gsd-file-manifest.json    (timestamp + install-time absolute paths)
 *   - gsd-install-state.json    (install-time absolute paths)
 *   - .gsd-source               (#1477, claude-global: install-time source path)
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
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { RUNTIME_META, runMinimalInstall, BUILD_SCRIPT, buildParityManifest } = require('./helpers/install-shared.cjs');

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

// The parity-manifest exclusion constants and buildParityManifest builder are
// the canonical single source of truth in tests/helpers/install-shared.cjs
// (issue #2266) — imported above. See that module for the full rationale
// behind each exclusion (VOLATILE_FILES, HOOK_CONFIG_FILES,
// HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES) and the hash formula.
// scripts/gen-golden-install-parity-zcode.cjs imports the same builder so the
// test harness and the fixture generator can never drift again.

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
        'Run "npm run gen:golden" to generate the fixtures (or, for humans, UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs).'
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
      lines.push('If the change is intentional, run "npm run gen:golden" to regenerate the fixtures (works without node --test; humans may also use UPDATE_GOLDEN=1 node --test).');
      assert.deepEqual(actual, golden, lines.join('\n'));
    }
  });
}

// #2086 (EoS/claude): claude is the reference host and the ONLY runtime with a
// distinct LOCAL "legacy flat-commands" layout (commands/gsd-*.md + agents/gsd-*.md).
// The loop above asserts the GLOBAL skills layout; this asserts the LOCAL
// commands/agents layout is byte-identical too, so folding claude's
// `runtime === 'claude'` branches into descriptor-driven hostBehaviors cannot
// silently change the local install output (AC1: "both scopes"). NOTE: the
// settings.local.json ROUTING itself is excluded here (platform-varying node-runner
// path) — that dimension is covered directly by install.test.cjs's #338 suite.
test('golden parity — claude (local legacy layout)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
    return;
  }
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
  let actual;
  try {
    actual = buildParityManifest(configDir, root);
  } finally {
    cleanup(root);
  }

  const fixturePath = path.join(FIXTURE_DIR, 'claude-local.json');

  if (UPDATE) {
    fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    process.stdout.write(`  [UPDATE] claude-local: wrote ${Object.keys(actual).length} file hashes → ${fixturePath}\n`);
    return;
  }

  if (!fs.existsSync(fixturePath)) {
    assert.fail(
      `Golden fixture missing for claude-local: ${fixturePath}\n` +
      'Run "npm run gen:golden" to generate the fixtures (or, for humans, UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs).',
    );
  }

  const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const added   = Object.keys(actual).filter(k => !(k in golden));
  const removed = Object.keys(golden).filter(k => !(k in actual));
  const changed = Object.keys(actual).filter(k => k in golden && actual[k] !== golden[k]);
  if (added.length || removed.length || changed.length) {
    const lines = ['Parity mismatch for claude-local:'];
    if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
    if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
    if (changed.length) lines.push(`  changed (${changed.length}): ${changed.join(', ')}`);
    lines.push('If the change is intentional, run "npm run gen:golden" to regenerate the fixtures (works without node --test; humans may also use UPDATE_GOLDEN=1 node --test).');
    assert.deepEqual(actual, golden, lines.join('\n'));
  }
});

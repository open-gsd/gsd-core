#!/usr/bin/env node
'use strict';
/**
 * Standalone golden-fixture generator for tests/golden-install-parity.
 *
 * This is a BUILD-TIME generation script — NOT a test run. It imports the
 * canonical buildParityManifest builder from tests/helpers/install-shared.cjs
 * (issue #2266 — single source of truth shared with
 * tests/golden-install-parity.test.cjs) and captures the zcode fixture so the
 * parity test (which the gsd-test gate runs) has a committed artifact to
 * compare against. The authoritative test gate remains `gsd-test run`, never
 * a local `node --test`.
 *
 * Usage: node scripts/gen-golden-install-parity-zcode.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// buildParityManifest (and its exclusion constants) is the canonical single
// source of truth in tests/helpers/install-shared.cjs (issue #2266) — the
// generator no longer keeps its own inline copy, which had drifted from the
// test harness's copy (missing the realpath/`<HOME>` normalization) and
// mis-generated the claude-local fixture (#2100).
const { runMinimalInstall, RUNTIME_META, buildParityManifest } = require(path.join(ROOT, 'tests', 'helpers', 'install-shared.cjs'));
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'golden-install-parity');

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Regenerate the fixture for every runtime in RUNTIME_META. Needed when a
// SHARED gsd-core payload file (e.g. model-catalog.json, capability-registry)
// changes content — its hash appears in every runtime's manifest, so all
// fixtures must be recaptured together. Usage:
//   node scripts/gen-golden-install-parity-zcode.cjs [runtime ...]
// With no args, regenerates ALL runtimes. With args, only the named runtimes.
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(RUNTIME_META);
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

for (const runtime of targets) {
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_META, runtime)) {
    process.stderr.write(`[gen] unknown runtime '${runtime}' (not in RUNTIME_META) — skipping\n`);
    continue;
  }
  const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
  let actual;
  try {
    actual = buildParityManifest(configDir, root);
  } finally {
    cleanup(root);
  }
  const fixturePath = path.join(FIXTURE_DIR, `${runtime}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
  process.stdout.write(`[gen] ${runtime}: wrote ${Object.keys(actual).length} file hashes -> ${fixturePath}\n`);
}

// Also regenerate the claude LOCAL legacy-layout fixture (claude-local.json).
// This layout is distinct from the global install (commands/gsd-*.md +
// agents/gsd-*.md) and has its own parity assertion in the test harness.
const { configDir: localConfigDir, root: localRoot } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
let localActual;
try {
  localActual = buildParityManifest(localConfigDir, localRoot);
} finally {
  cleanup(localRoot);
}
const localFixturePath = path.join(FIXTURE_DIR, 'claude-local.json');
fs.writeFileSync(localFixturePath, JSON.stringify(localActual, null, 2) + '\n', 'utf8');
process.stdout.write(`[gen] claude-local: wrote ${Object.keys(localActual).length} file hashes -> ${localFixturePath}\n`);

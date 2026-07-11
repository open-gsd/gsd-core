#!/usr/bin/env node
'use strict';
/**
 * Standalone golden-fixture generator for tests/golden-install-parity.
 *
 * This is a BUILD-TIME generation script — NOT a test run. It replicates the
 * buildParityManifest logic from tests/golden-install-parity.test.cjs and
 * captures the zcode fixture so the parity test (which the gsd-test gate runs)
 * has a committed artifact to compare against. The authoritative test gate
 * remains `gsd-test run`, never a local `node --test`.
 *
 * Usage: node scripts/gen-golden-install-parity-zcode.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { walk, runMinimalInstall, RUNTIME_META } = require(path.join(ROOT, 'tests', 'helpers', 'install-shared.cjs'));
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'golden-install-parity');

const VOLATILE_FILES = new Set([
  'gsd-file-manifest.json',
  'gsd-install-state.json',
  '.gsd-source',
  'gsd-core/CHANGELOG.md',
]);
const HOOK_CONFIG_FILES = new Set(['settings.json', 'hooks.json']);
// Kimi's native config.toml (#2095) — see tests/golden-install-parity.test.cjs'
// HOOK_CONFIG_RELATIVE_PATHS comment for why this is an exact relative-path
// exclusion rather than a HOOK_CONFIG_FILES basename entry (a basename entry
// would also blind Codex's stable, platform-independent config.toml fixture).
const HOOK_CONFIG_RELATIVE_PATHS = new Set(['.kimi/config.toml']);
const EXCLUDED_PREFIXES = ['gsd-core/bin/lib/'];

function buildParityManifest(configDir, root) {
  const allFiles = walk(configDir);
  const unsorted = {};
  for (const full of allFiles) {
    const rel = path.relative(configDir, full).split(path.sep).join('/');
    if (VOLATILE_FILES.has(rel)) continue;
    if (HOOK_CONFIG_FILES.has(path.basename(rel))) continue;
    if (HOOK_CONFIG_RELATIVE_PATHS.has(rel)) continue;
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const content = fs.readFileSync(full);
    const normalized = content.toString('utf8').split(root).join('<HOME>').split(PKG_VERSION).join('<VERSION>');
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    unsorted[rel] = hash;
  }
  const sorted = {};
  for (const key of Object.keys(unsorted).sort()) sorted[key] = unsorted[key];
  return sorted;
}

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

'use strict';
/**
 * feat-443-effort-defaults-drift.test.cjs
 *
 * Drift-guard: asserts that install.js's resolved baseline effort defaults
 * equal config-defaults.manifest.json's effort block. Any future divergence
 * (someone edits the manifest without updating install.js or vice-versa) fails
 * CI immediately rather than silently injecting stale effort values.
 *
 * Real assertions on runtime values — no source-grep.
 */

// MUST be set before require('bin/install.js') so the main install block
// (guarded by !GSD_TEST_MODE) does not execute and perform a real global
// install into $HOME/.claude/ — which would leak gsd-tools.cjs into the
// ambient HOME and break runtime-launcher-parity test (D) in the same
// node --test run (all unit tests share the same HOME on CI).
process.env.GSD_TEST_MODE = '1';

const assert = require('assert');
const path = require('path');

const { test } = require('node:test');

// Load the manifest directly (JSON, not a .cjs source file — allowed by lint rule)
const manifestPath = path.join(
  __dirname,
  '..',
  'get-shit-done',
  'bin',
  'shared',
  'config-defaults.manifest.json'
);
const manifest = require(manifestPath);

// Load install.js exported values (executes the module, not text inspection)
const installPath = path.join(__dirname, '..', 'bin', 'install.js');
const {
  _GSD_EFFORT_MANIFEST_TIER_DEFAULTS,
  _GSD_EFFORT_MANIFEST_DEFAULT,
} = require(installPath);

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light matches manifest effort.routing_tier_defaults.light', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light,
    manifest.effort.routing_tier_defaults.light,
    `install.js tier default for "light" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light}) differs from manifest (${manifest.effort.routing_tier_defaults.light})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard matches manifest effort.routing_tier_defaults.standard', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard,
    manifest.effort.routing_tier_defaults.standard,
    `install.js tier default for "standard" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard}) differs from manifest (${manifest.effort.routing_tier_defaults.standard})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy matches manifest effort.routing_tier_defaults.heavy', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy,
    manifest.effort.routing_tier_defaults.heavy,
    `install.js tier default for "heavy" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy}) differs from manifest (${manifest.effort.routing_tier_defaults.heavy})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_DEFAULT matches manifest effort.default', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_DEFAULT,
    manifest.effort.default,
    `install.js effort default (${_GSD_EFFORT_MANIFEST_DEFAULT}) differs from manifest (${manifest.effort.default})`
  );
});

test('install.js tier-defaults object has exactly the same keys as manifest effort.routing_tier_defaults', () => {
  const installKeys = Object.keys(_GSD_EFFORT_MANIFEST_TIER_DEFAULTS).sort();
  const manifestKeys = Object.keys(manifest.effort.routing_tier_defaults).sort();
  assert.deepStrictEqual(
    installKeys,
    manifestKeys,
    `Key mismatch — install.js: [${installKeys.join(', ')}], manifest: [${manifestKeys.join(', ')}]`
  );
});

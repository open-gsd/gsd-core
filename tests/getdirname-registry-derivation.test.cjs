'use strict';
/**
 * Property test: getDirName is a pure projection of each runtime descriptor's
 * `localConfigDir`. Because 1.7.0 (ADR-1016 / ADR-1239) makes runtimes
 * pluggable data descriptors, this test asserts the DERIVATION CONTRACT —
 * `getDirName(id) === registry.runtimes[id].runtime.localConfigDir` — for
 * EVERY runtime currently in the registry, rather than pinning a frozen
 * per-runtime golden snapshot that would have to be hand-edited every time a
 * runtime is added or removed. Adding a new runtime descriptor requires zero
 * changes here; if the derivation breaks for any runtime, this fails loudly.
 *
 * Also covers:
 *   - the fail-closed fallback (`getDirName('unknown')` / `getDirName('')` → '.claude');
 *   - a structural cross-check that every descriptor's localConfigDir is a
 *     non-empty dot-dir string.
 *
 * ADR-1239 Phase B (#1679). Behavioral tests only: assert on returned values.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getDirName } = runtimeNamePolicy;

const RUNTIME_IDS = Object.keys(registry.runtimes);

test('getDirName(id) projects each descriptor runtime.localConfigDir (derivation contract, count-agnostic)', () => {
  assert.ok(RUNTIME_IDS.length > 0, 'registry must contain at least one runtime');
  for (const id of RUNTIME_IDS) {
    const desc = registry.runtimes[id] && registry.runtimes[id].runtime;
    const expected = desc && desc.localConfigDir;
    assert.ok(typeof expected === 'string' && expected.length > 0,
      `registry.runtimes['${id}'].runtime.localConfigDir must be a non-empty string`);
    assert.strictEqual(
      getDirName(id),
      expected,
      `getDirName('${id}') must equal the descriptor localConfigDir '${expected}'`);
  }
});

test('getDirName fallback: unknown / empty runtime returns ".claude" (fail-closed)', () => {
  assert.strictEqual(getDirName('unknown'), '.claude');
  assert.strictEqual(getDirName(''), '.claude');
  assert.strictEqual(getDirName('__nonexistent_runtime__'), '.claude');
});

test('registry cross-check: every runtimes[id].runtime.localConfigDir is a non-empty dot-dir string', () => {
  for (const [id, entry] of Object.entries(registry.runtimes)) {
    if (!entry || typeof entry !== 'object') continue;
    const runtimeBlock = entry.runtime;
    if (!runtimeBlock || typeof runtimeBlock !== 'object') continue;
    const dir = runtimeBlock.localConfigDir;
    assert.strictEqual(typeof dir, 'string',
      `registry.runtimes['${id}'].runtime.localConfigDir must be a string (got: ${typeof dir})`);
    assert.ok(dir.length > 0,
      `registry.runtimes['${id}'].runtime.localConfigDir must be non-empty`);
    assert.ok(dir.startsWith('.'),
      `registry.runtimes['${id}'].runtime.localConfigDir must start with '.' (got: ${JSON.stringify(dir)})`);
  }
});

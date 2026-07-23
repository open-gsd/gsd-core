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
 * #2103: vscode's `configHome.kind === 'none'` (no file-projected config
 * directory at all) is the first descriptor with `localConfigDir: null` — it
 * is carved out of the "non-empty dot-dir string" invariant below and
 * asserted against getDirName's documented NO_LOCAL_CONFIG_DIR_SENTINEL
 * instead (mirrors the carve-out in
 * tests/non-claude-runtimes-registry-derivation.test.cjs).
 *
 * ADR-1239 Phase B (#1679). Behavioral tests only: assert on returned values.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getDirName, NO_LOCAL_CONFIG_DIR_SENTINEL } = runtimeNamePolicy;

const RUNTIME_IDS = Object.keys(registry.runtimes);

// Runtimes whose configHome.kind === 'none' have NO file-projected config
// directory at all (localConfigDir is legitimately null) — carved out of the
// "non-empty dot-dir string" invariant, the same way dot-home-nested's
// .parent is a conditional carve-out in the validator.
const NO_LOCAL_CONFIG_DIR_RUNTIMES = new Set(
  RUNTIME_IDS.filter((id) => {
    const desc = registry.runtimes[id] && registry.runtimes[id].runtime;
    return !!(desc && desc.configHome && desc.configHome.kind === 'none');
  }),
);

test('getDirName(id) projects each descriptor runtime.localConfigDir (derivation contract, count-agnostic)', () => {
  assert.ok(RUNTIME_IDS.length > 0, 'registry must contain at least one runtime');
  for (const id of RUNTIME_IDS) {
    const desc = registry.runtimes[id] && registry.runtimes[id].runtime;
    if (NO_LOCAL_CONFIG_DIR_RUNTIMES.has(id)) {
      // #2103: no file-projected config dir — getDirName must return the
      // documented sentinel, not the '.claude' default and not null.
      assert.strictEqual(desc.localConfigDir, null,
        `${id}: configHome.kind === 'none' runtimes must declare localConfigDir: null`);
      assert.strictEqual(
        getDirName(id),
        NO_LOCAL_CONFIG_DIR_SENTINEL,
        `getDirName('${id}') must equal the documented no-local-config-dir sentinel`);
      continue;
    }
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

test('registry cross-check: every runtimes[id].runtime.localConfigDir is a non-empty dot-dir string, except configHome.kind==="none" runtimes (localConfigDir: null)', () => {
  for (const [id, entry] of Object.entries(registry.runtimes)) {
    if (!entry || typeof entry !== 'object') continue;
    const runtimeBlock = entry.runtime;
    if (!runtimeBlock || typeof runtimeBlock !== 'object') continue;
    if (NO_LOCAL_CONFIG_DIR_RUNTIMES.has(id)) {
      assert.strictEqual(runtimeBlock.localConfigDir, null,
        `registry.runtimes['${id}'].runtime.localConfigDir must be null (configHome.kind === 'none')`);
      continue;
    }
    const dir = runtimeBlock.localConfigDir;
    assert.strictEqual(typeof dir, 'string',
      `registry.runtimes['${id}'].runtime.localConfigDir must be a string (got: ${typeof dir})`);
    assert.ok(dir.length > 0,
      `registry.runtimes['${id}'].runtime.localConfigDir must be non-empty`);
    assert.ok(dir.startsWith('.'),
      `registry.runtimes['${id}'].runtime.localConfigDir must start with '.' (got: ${JSON.stringify(dir)})`);
  }
});

'use strict';
/**
 * Tests for runtimeFlags (ADR-1239 Phase B / #1679 AC2). Collapses the four
 * duplicated `const isX = runtime === 'x'` declaration blocks in bin/install.js
 * into one helper. Pins: all flags present, exactly one true per known runtime,
 * claude/unknown/empty → all false, frozen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFlags } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const EXPECTED_FLAGS = [
  'isOpencode', 'isKilo', 'isCodex', 'isCopilot', 'isAntigravity',
  'isCursor', 'isWindsurf', 'isAugment', 'isTrae', 'isQwen', 'isHermes',
  'isCodebuddy', 'isCline', 'isKimi', 'isZcode',
];

test('runtimeFlags: every known non-claude runtime sets exactly its own flag true', () => {
  const ids = EXPECTED_FLAGS.map((f) => f.slice(2).toLowerCase());
  for (const id of ids) {
    const flags = runtimeFlags(id);
    const trues = EXPECTED_FLAGS.filter((f) => flags[f] === true);
    assert.deepStrictEqual(trues, ['is' + id.charAt(0).toUpperCase() + id.slice(1)], `runtime '${id}' must set exactly its own flag`);
  }
});

test('runtimeFlags: claude / unknown / empty → all flags false (fail-closed)', () => {
  for (const id of ['claude', 'unknown', '', 'claude-code']) {
    const flags = runtimeFlags(id);
    for (const f of EXPECTED_FLAGS) {
      assert.strictEqual(flags[f], false, `runtime '${id}': ${f} must be false`);
    }
  }
});

test('runtimeFlags: all 15 flags present + boolean + the object is frozen', () => {
  const flags = runtimeFlags('opencode');
  for (const f of EXPECTED_FLAGS) {
    assert.strictEqual(typeof flags[f], 'boolean', `${f} must be boolean`);
  }
  assert.deepStrictEqual(Object.keys(flags).sort(), [...EXPECTED_FLAGS].sort(), 'exactly the 15 flags');
  assert.ok(Object.isFrozen(flags), 'flags object must be frozen');
});

test('runtimeFlags drift guard: covers every registry runtime except claude', () => {
  // Adding a registry runtime that is not claude must get a flag or be added to
  // RUNTIME_FLAG_IDS — pin the set so a new runtime forces a deliberate update.
  const registryNonClaude = Object.keys(registry.runtimes).filter((r) => r !== 'claude').sort();
  const flagIds = EXPECTED_FLAGS.map((f) => f.slice(2).toLowerCase()).sort();
  const missing = registryNonClaude.filter((r) => !flagIds.includes(r));
  assert.deepEqual(missing, [], `registry runtimes missing a runtimeFlags entry: ${missing.join(', ')} — add to RUNTIME_FLAG_IDS`);
});

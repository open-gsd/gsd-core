'use strict';

/**
 * CLI surface registry (#6087, P1a of #6051): GLOBAL_FLAGS / CLI_SURFACE / specFor contract.
 * Matrix rows T-G1..T-G5.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLI_SURFACE,
  GLOBAL_FLAGS,
  UNDECLARED_VERBS,
  specFor,
} = require('../gsd-core/bin/lib/cli-surface.cjs');
const { parseNamedArgs } = require('../gsd-core/bin/lib/command-arg-projection.cjs');

function declaredFlags(spec) {
  return [
    ...(spec.valueFlags ?? []),
    ...(spec.booleanFlags ?? []),
    ...(spec.optionalValueFlags ?? []),
  ];
}

describe('GLOBAL_FLAGS', () => {
  test('declares the value flags main() strips', () => {
    for (const f of ['cwd', 'project-dir', 'ws', 'pick', 'default']) {
      assert.ok(GLOBAL_FLAGS.valueFlags.includes(f), `valueFlags missing ${f}`);
    }
  });

  test('declares the boolean flags main() strips', () => {
    for (const f of ['raw', 'json-errors']) {
      assert.ok(GLOBAL_FLAGS.booleanFlags.includes(f), `booleanFlags missing ${f}`);
    }
  });

  test('declares the =-form-only flags', () => {
    for (const f of ['exit-contract', 'cwd', 'project-dir']) {
      assert.ok(GLOBAL_FLAGS.eqFlags.includes(f), `eqFlags missing ${f}`);
    }
  });
});

describe('CLI_SURFACE registry', () => {
  test('T-G1: global flags are disjoint from every verb declared flag set', () => {
    const globals = new Set([...GLOBAL_FLAGS.valueFlags, ...GLOBAL_FLAGS.booleanFlags]);
    const clashes = [];
    for (const [verb, spec] of Object.entries(CLI_SURFACE)) {
      for (const f of declaredFlags(spec)) {
        if (globals.has(f)) clashes.push(`${verb}: --${f}`);
      }
    }
    assert.deepEqual(clashes, [], `verbs redeclare global flags: ${clashes.join(', ')}`);
  });

  test('T-G2: every spec is accepted by parseNamedArgs (no TypeError)', () => {
    const verbs = Object.keys(CLI_SURFACE);
    assert.ok(verbs.length > 0, 'CLI_SURFACE must not be empty');
    for (const verb of verbs) {
      try {
        parseNamedArgs([], CLI_SURFACE[verb]);
      } catch (err) {
        assert.fail(`spec for ${verb} rejected by assertValidSpec: ${err && err.message}`);
      }
    }
  });

  test('T-G3: specFor throws naming an undeclared verb', () => {
    assert.throws(() => specFor('zz-not-a-verb'), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('zz-not-a-verb'), err.message);
      return true;
    });
  });

  test('T-G4: specFor returns the registry reference and specs are frozen', () => {
    for (const verb of Object.keys(CLI_SURFACE)) {
      assert.equal(specFor(verb), CLI_SURFACE[verb], `${verb}: specFor must not copy`);
      assert.ok(Object.isFrozen(CLI_SURFACE[verb]), `${verb}: spec must be frozen`);
    }
    assert.ok(Object.isFrozen(CLI_SURFACE), 'CLI_SURFACE must be frozen');
    assert.ok(Object.isFrozen(UNDECLARED_VERBS), 'UNDECLARED_VERBS must be frozen');
  });

  test('T-G5: agent-skills is workstream scoped', () => {
    assert.equal(CLI_SURFACE['agent-skills'].workstreamScoped, true);
  });
});

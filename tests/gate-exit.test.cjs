'use strict';

/**
 * Gate exit (#5170, epic #5056, ADR-5057 §4 fourth bullet): the exit status
 * follows the verdict. Matrix rows 7-8 plus the declaration seam in cli-exit.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { gateExitOutcome, declareGateExit } = require('../gsd-core/bin/lib/gate-exit.cjs');
const cliExit = require('../gsd-core/bin/lib/cli-exit.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const OUTCOMES = ['pass', 'skip', 'advisory', 'block', 'unreadable'];
const MODES = ['payload', 'status'];
const SEED = 5170;

/**
 * The invariants a mapping must satisfy, as a fast-check property so the same
 * predicate judges the real mapping and the mutant (the positive control).
 */
function invariantProperty(mapping) {
  return fc.property(fc.constantFrom(...OUTCOMES), fc.constantFrom(...MODES), (outcome, mode) => {
    const result = mapping({ outcome }, mode);
    if (outcome === 'unreadable') return result === 'UNAVAILABLE';
    if (outcome === 'block') return result === (mode === 'status' ? 'FAIL' : 'PASS');
    return result === 'PASS';
  });
}

describe('gate-exit › exit outcome is total and unreadable is never PASS', () => {
  test('gate-exit › exit outcome is total and unreadable is never PASS', () => {
    fc.assert(invariantProperty(gateExitOutcome), { seed: SEED, numRuns: 100 });
  });

  test('gate-exit › every outcome x mode pair is covered by name (the property is not vacuous)', () => {
    const seen = new Set();
    for (const outcome of OUTCOMES) for (const mode of MODES) seen.add(`${outcome}/${mode}:${gateExitOutcome({ outcome }, mode)}`);
    assert.deepEqual([...seen].sort(), [
      'advisory/payload:PASS', 'advisory/status:PASS',
      'block/payload:PASS', 'block/status:FAIL',
      'pass/payload:PASS', 'pass/status:PASS',
      'skip/payload:PASS', 'skip/status:PASS',
      'unreadable/payload:UNAVAILABLE', 'unreadable/status:UNAVAILABLE',
    ]);
  });

  test('gate-exit › positive control', () => {
    // A mapping that lets "could not look" exit 0 must be caught by the property.
    const mutant = (verdict, mode) => (verdict.outcome === 'unreadable' ? 'PASS' : gateExitOutcome(verdict, mode));
    assert.throws(() => fc.assert(invariantProperty(mutant), { seed: SEED, numRuns: 100 }), /Property failed/);
    // And one that lets a negative verdict exit 0 in status mode.
    const lenient = (verdict, mode) => (verdict.outcome === 'block' ? 'PASS' : gateExitOutcome(verdict, mode));
    assert.throws(() => fc.assert(invariantProperty(lenient), { seed: SEED, numRuns: 100 }), /Property failed/);
  });

  test('gate-exit › the projected exit codes are 0 / 1 / 69 under v1 and v2', () => {
    for (const version of ['v1', 'v2']) {
      assert.equal(cliExit.projectOutcome(gateExitOutcome({ outcome: 'pass' }, 'status'), version), 0);
      assert.equal(cliExit.projectOutcome(gateExitOutcome({ outcome: 'block' }, 'status'), version), 1);
      assert.equal(cliExit.projectOutcome(gateExitOutcome({ outcome: 'unreadable' }, 'payload'), version), exitCodeFor('UNAVAILABLE'));
    }
    assert.equal(exitCodeFor('UNAVAILABLE'), 69);
  });
});

describe('gate-exit › declareGateExit writes the pending outcome', () => {
  afterEach(() => { cliExit.setPendingOutcome(undefined); });

  test('gate-exit › unreadable declares UNAVAILABLE in both modes', () => {
    for (const mode of MODES) {
      cliExit.setPendingOutcome(undefined);
      assert.equal(declareGateExit({ outcome: 'unreadable' }, mode), 'UNAVAILABLE');
      assert.equal(cliExit.getPendingOutcome(), 'UNAVAILABLE');
    }
  });

  test('gate-exit › a blocking verdict declares FAIL in status mode only', () => {
    assert.equal(declareGateExit({ outcome: 'block' }, 'status'), 'FAIL');
    assert.equal(cliExit.getPendingOutcome(), 'FAIL');
    cliExit.setPendingOutcome(undefined);
    assert.equal(declareGateExit({ outcome: 'block' }, 'payload'), 'PASS');
    assert.equal(cliExit.getPendingOutcome(), undefined, 'payload-mode block is a delivered verdict: nothing is declared');
  });

  test('gate-exit › a passing verdict leaves the cell exactly as output() wrote it', () => {
    cliExit.setPendingOutcome('DEGRADED');
    assert.equal(declareGateExit({ outcome: 'pass' }, 'status'), 'PASS');
    assert.equal(cliExit.getPendingOutcome(), 'DEGRADED', 'a payload that legitimately carries an error key keeps its contract');
  });

  test('gate-exit › the declaration overrides what output() recorded for an error payload', () => {
    // output({error}) records DEGRADED; the verb declares AFTER output(), so UNAVAILABLE wins.
    cliExit.setPendingOutcome('DEGRADED');
    declareGateExit({ outcome: 'unreadable' }, 'status');
    assert.equal(cliExit.getPendingOutcome(), 'UNAVAILABLE');
  });
});

describe('gate-exit › cli-exit declareOutcome', () => {
  afterEach(() => { cliExit.setPendingOutcome(undefined); });

  test('gate-exit › declareOutcome writes the cell for PASS, FAIL and registered names', () => {
    for (const name of ['PASS', 'FAIL', 'UNAVAILABLE', 'DEGRADED']) {
      cliExit.declareOutcome(name);
      assert.equal(cliExit.getPendingOutcome(), name);
    }
  });

  test('gate-exit › declareOutcome refuses an unregistered or malformed name and leaves the cell untouched', () => {
    cliExit.setPendingOutcome('FAIL');
    for (const bad of ['NOT_A_REGISTERED_OUTCOME', 'unavailable', '', 'pass']) {
      assert.throws(() => cliExit.declareOutcome(bad), /projectOutcome|exitCodeFor/, JSON.stringify(bad));
      assert.equal(cliExit.getPendingOutcome(), 'FAIL', 'a rejected declaration must not clobber the cell');
    }
  });

  test('gate-exit › a declared UNAVAILABLE is what runMain projects for a void main (child process)', () => {
    const { spawnSync } = require('node:child_process');
    const modulePath = require.resolve('../gsd-core/bin/lib/cli-exit.cjs');
    const script = `
      const cliExit = require(${JSON.stringify(modulePath)});
      cliExit.runMain(() => { cliExit.declareOutcome('UNAVAILABLE'); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(result.status, 69, result.stderr);
  });
});

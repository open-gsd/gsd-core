'use strict';

/**
 * Parity test for the gate shell boundary (#5482): `evaluateCheckPredicate` hands ${PHASE_DIR},
 * ${PHASE_NUMBER} and ${PHASE_REQ_IDS} to the real `sh -c` as environment values. A value that holds
 * shell syntax is data, whatever the gate's caller (ship.md step 6, `milestone complete`) derived it from.
 * The owner is `evaluateCommandExitZero`; a caller keeps no guard of its own.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateCheckPredicate } = require('../gsd-core/bin/lib/gate-predicate.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const predicateArgs = (command, phaseDir, phaseNumber = '01') => [
  '--predicate', JSON.stringify({ kind: 'command-exit-zero', command }),
  '--phase-dir', phaseDir,
  '--phase-number', phaseNumber,
];

describe('command-exit-zero placeholders reach sh as data (#5482)', () => {
  let root;
  beforeEach(() => { root = createTempProject(); });
  afterEach(() => cleanup(root));

  const evaluate = (command, phaseDir, phaseNumber) =>
    evaluateCheckPredicate({ projectDir: root, args: predicateArgs(command, phaseDir, phaseNumber) });

  test('a phase directory reached through a symlinked ancestor holding $(...) runs no command', (t) => {
    const hostile = path.join(root, 'ph$(touch PWNED)');
    fs.mkdirSync(path.join(hostile, '01-x'), { recursive: true });
    cleanup(path.join(root, '.planning', 'phases'));
    try {
      fs.symlinkSync(hostile, path.join(root, '.planning', 'phases'), 'dir');
    } catch {
      t.skip('this file system refuses symlinks');
      return;
    }
    const result = evaluate('test -d "${PHASE_DIR}"', path.join(root, '.planning', 'phases', '01-x'));
    assert.equal(result.block, false, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
  });

  test('a phase directory name that splits into find arguments stays one word when quoted', () => {
    const name = '01-x . -exec touch PWNED3 {} +';
    const dir = path.join(root, '.planning', 'phases', name);
    fs.mkdirSync(dir, { recursive: true });
    const result = evaluate('find "${PHASE_DIR}" -maxdepth 0 -type d | grep -q .', dir);
    assert.equal(result.block, false, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(root, 'PWNED3')), false);
  });

  test('a hostile directory name is the exact value the gate reads', () => {
    const dir = path.join(root, '.planning', 'phases', '01-$(touch PWNED) `id` ; # "q" \'s\'');
    fs.mkdirSync(dir, { recursive: true });
    const result = evaluate('touch "${PHASE_DIR}/ok"', dir);
    assert.equal(result.block, false, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(dir, 'ok')), true);
    assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
  });

  test('a single-quoted placeholder with an ordinary value still expands', () => {
    const dir = path.join(root, '.planning', 'phases', '01-x');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(evaluate("test '${PHASE_NUMBER}' = 01", dir).block, false);
    assert.equal(evaluate("test '${PHASE_NUMBER}' = 02", dir).block, true);
  });

  test('an unset placeholder expands to the empty string and other variables are left for sh', () => {
    assert.equal(evaluate('test -z "${PHASE_REQ_IDS}" && test -n "${PATH}"', path.join(root, '.planning', 'phases')).block, false);
  });
});

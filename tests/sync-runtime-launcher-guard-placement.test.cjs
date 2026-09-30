'use strict';

/**
 * scripts/sync-runtime-launcher.cjs keeps the canonical preamble BEHIND a guard
 * that opens its fence (#3861, #5118).
 *
 * execute-phase/steps/code-review-disposition.md opens its second fence with a
 * status guard and carries the launcher preamble after it; the tests extract
 * "everything before the shim" and run it as the guard. A sync that hoisted the
 * preamble to the top of that fence left the guard extraction empty and put the
 * resolver ahead of the guard. The sync must be a no-op on such a fence.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { transformFile, loadPreamble } = require('../scripts/sync-runtime-launcher.cjs');

const preamble = loadPreamble();
const FENCE = '```';

function doc(blockLines) {
  return ['# step', '', FENCE + 'bash', ...blockLines, FENCE, ''].join('\n');
}

const GUARD = ['case "${REVIEW_STATUS:-}" in', '  clean) exit 0 ;;', 'esac'];
const CALL = ['gsd_run query verification status "${PHASE_DIR}" --pick status'];

describe('sync-runtime-launcher — preamble placement', () => {
  test('a fence that opens with a guard keeps the preamble behind it (sync is a no-op)', () => {
    const content = doc([...GUARD, ...preamble, ...CALL]);
    assert.equal(transformFile(content, preamble), null);
  });

  test('a fence whose preamble is already on top is a no-op', () => {
    const content = doc([...preamble, ...GUARD, ...CALL]);
    assert.equal(transformFile(content, preamble), null);
  });

  test('a fence with no preamble gets it at the top', () => {
    const out = transformFile(doc([...GUARD, ...CALL]), preamble);
    assert.notEqual(out, null);
    const lines = out.split('\n');
    const open = lines.indexOf(FENCE + 'bash');
    assert.deepEqual(lines.slice(open + 1, open + 1 + preamble.length), preamble);
  });

  test('a duplicated preamble collapses to the topmost copy', () => {
    const content = doc([...preamble, ...GUARD, ...preamble, ...CALL]);
    const out = transformFile(content, preamble);
    assert.notEqual(out, null);
    const lines = out.split('\n');
    const open = lines.indexOf(FENCE + 'bash');
    const block = lines.slice(open + 1, lines.indexOf(FENCE, open + 1));
    assert.deepEqual(block, [...preamble, ...GUARD, ...CALL]);
  });
});

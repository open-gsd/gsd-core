/**
 * Phase-entry grammar owner (#5763, Phase 3 of epic #5692).
 * One definition of a ROADMAP phase-list entry: marker, box, bold, anchoring.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  phaseEntryPrefixSrc,
  phaseEntryRegExp,
  isPhaseEntryChecked,
  isBoxCharChecked,
  PHASE_ENTRY_BOLD_CLOSE_SRC,
} = require('../gsd-core/bin/lib/phase-entry-grammar.cjs');

const entry = (opts, flags = 'i') => phaseEntryRegExp('Phase\\s+1\\b', flags, opts);

describe('phase-entry grammar (#5763)', () => {
  test('accepts both markers with every gap width', () => {
    for (const marker of ['-', '*']) {
      for (const g1 of ['', ' ', '  ']) {
        for (const g2 of ['', ' ']) {
          assert.ok(entry().test(`${marker}${g1}[ ]${g2}**Phase 1: x**`), `${marker}${g1}[ ]${g2}`);
        }
      }
    }
  });

  test('accepts box states [ ] [x] [X] and reads the tick in one place', () => {
    for (const [box, ticked] of [[' ', false], ['x', true], ['X', true]]) {
      const line = `- [${box}] **Phase 1: x**`;
      assert.ok(entry().test(line));
      assert.equal(isPhaseEntryChecked(line), ticked, line);
      assert.equal(isBoxCharChecked(box), ticked);
    }
    assert.equal(isPhaseEntryChecked('- [?] Phase 1'), false);
    assert.equal(isPhaseEntryChecked('no box here'), false);
  });

  test('bold: optional accepts ** __ and none; required rejects none', () => {
    for (const bold of ['**', '__', '']) {
      assert.ok(entry({ bold: 'optional' }).test(`- [ ] ${bold}Phase 1: x`), `optional ${bold}`);
    }
    assert.ok(entry({ bold: 'required' }).test('- [ ] **Phase 1: x'));
    assert.ok(entry({ bold: 'required' }).test('- [ ] __Phase 1: x'));
    assert.ok(!entry({ bold: 'required' }).test('- [ ] Phase 1: x'));
  });

  test('a single star is not a bold token', () => {
    assert.ok(!entry({ bold: 'required' }).test('- [ ] *Phase 1: x*'));
    assert.ok(!entry().test('- [ ] *Phase 1: x*'));
  });

  test('box: optional admits plain bullets, required does not', () => {
    assert.ok(entry({ box: 'optional', bold: 'required' }).test('- **Phase 1 — x**'));
    assert.ok(entry({ box: 'optional', bold: 'required' }).test('* [x] **Phase 1 — x**'));
    assert.ok(!entry({ box: 'required', bold: 'required' }).test('- **Phase 1 — x**'));
  });

  test('state: unchecked matches only [ ]; captured adds exactly one group', () => {
    assert.ok(entry({ state: 'unchecked' }).test('- [ ] Phase 1: x'));
    assert.ok(!entry({ state: 'unchecked' }).test('- [x] Phase 1: x'));
    const m = entry({ state: 'captured' }).exec('- [X] Phase 1: x');
    assert.equal(m.length, 2);
    assert.equal(m[1], 'X');
  });

  test('indent: spaces and tabs are allowed, the entry still starts its line', () => {
    for (const indent of ['', ' ', '        ', '\t']) {
      assert.ok(entry().test(`prose\n${indent}- [ ] Phase 1: x`), JSON.stringify(indent));
    }
  });

  test('gaps are horizontal only: a newline between marker and box is not an entry', () => {
    assert.ok(!entry().test('-\n[ ] Phase 1: x'));
    assert.ok(!entry().test('- [ ]\nPhase 1: x'));
  });

  test('anchored: a mid-line mention is not an entry', () => {
    assert.ok(!entry().test('see - [ ] Phase 1: x for details'));
    assert.ok(!entry().test('> - [ ] Phase 1: x'));
  });

  test('the m flag is always set so ^ is a line start', () => {
    assert.ok(entry({}, 'i').flags.includes('m'));
    assert.ok(entry({}, 'im').flags.includes('m'));
    assert.ok(phaseEntryPrefixSrc().startsWith('^'));
  });

  test('a leading BOM before the first entry is tolerated', () => {
    assert.ok(entry().test('\uFEFF- [ ] **Phase 1: x**'));
    assert.equal(isPhaseEntryChecked('\uFEFF- [x] **Phase 1: x**'), true);
  });

  test('the closing bold wrapper does not cut a name containing __', () => {
    const re = new RegExp(`Phase\\s+1:\\s*(.+?)${PHASE_ENTRY_BOLD_CLOSE_SRC}`, 'im');
    assert.equal(re.exec('- [ ] **Phase 1: Add __init__ support**')[1], 'Add __init__ support');
    assert.equal(re.exec('- [ ] **Phase 1: Wire __tests__**')[1], 'Wire __tests__');
    assert.equal(re.exec('- [ ] __Phase 1: Name__')[1], 'Name');
  });

  test('other checkbox families never match a Phase tail', () => {
    assert.ok(!entry().test('- [ ] 01-01-PLAN.md'));
    assert.ok(!entry().test('- [ ] **REQ-1**: requirement'));
  });

  test('CRLF: the entry matches and the tick is read', () => {
    const text = 'intro\r\n- [x] **Phase 1: x**\r\n';
    assert.ok(entry().test(text));
    assert.equal(isPhaseEntryChecked('- [x] **Phase 1: x**\r'), true);
  });

  test('a very long blank run does not backtrack', () => {
    const line = `- [ ]${' '.repeat(5000)}x`;
    // Behavioral: a quadratic prefix would make this call hang the runner.
    assert.ok(!entry().test(line));
  });
});

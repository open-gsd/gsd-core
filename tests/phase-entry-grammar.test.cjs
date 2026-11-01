/**
 * Phase-entry grammar owner (#5763, Phase 3 of epic #5692).
 * One definition of a ROADMAP phase-list entry: marker, box, bold, anchoring.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  phaseEntryPrefixSrc,
  phaseEntryRegExp,
  phaseEntrySplitRegExp,
  isPhaseEntryChecked,
  isBoxCharChecked,
  PHASE_ENTRY_BOLD_CLOSE_SRC,
} = require('../gsd-core/bin/lib/phase-entry-grammar.cjs');

const entry = (opts, flags = 'i') => phaseEntryRegExp('Phase\\s+1\\b', flags, opts);

describe('phase-entry grammar (#5763)', () => {
  test('accepts both markers with every gap width', () => {
    for (const marker of ['-', '*']) {
      for (const g1 of [' ', '  ', '\t', '    ']) {
        for (const g2 of ['', ' ']) {
          assert.ok(entry().test(`${marker}${g1}[ ]${g2}**Phase 1: x**`), `${marker}${g1}[ ]${g2}`);
        }
      }
    }
  });

  test('the marker must be followed by 1 to 4 spaces or tabs: `-[ ]` is not a list item (#5764)', () => {
    for (const marker of ['-', '*']) {
      assert.ok(!entry().test(`${marker}[ ] **Phase 1: x**`), 'no gap after the marker');
      assert.ok(!entry().test(`${marker}     [ ] **Phase 1: x**`), 'five spaces start an indented code block');
    }
  });

  test('decorated: any text but `Phase` may sit between the box and the label, the box is still required (#5764)', () => {
    const re = (line) => phaseEntryRegExp('Phase\\s+2\\b', 'i', { decorated: true }).test(line);
    assert.ok(re('- [x] ~~**Phase 2: B**~~'));
    assert.ok(re('* [ ] 🚧 Phase 2: B'));
    assert.ok(!re('- [ ] **Phase 5**: needs Phase 2'), 'the first Phase on the line is the label');
    assert.ok(!re('see - [ ] Phase 2: B'), 'a mention before the box is not an entry');
    assert.ok(!re('Phase 2: B'), 'no box, no entry');
  });

  test('the split regexp keeps the indent and box neighbours in groups 1 and 2 (#5764)', () => {
    const re = phaseEntrySplitRegExp('Phase\\s+1\\b[^\\n]*', 'i', { state: 'unchecked' });
    assert.equal('  * [ ] __Phase 1: x__'.replace(re, '$1x$2'), '  * [x] __Phase 1: x__');
    assert.equal('- [x] **Phase 1: x**'.replace(re, '$1x$2'), '- [x] **Phase 1: x**', 'an unchecked-only split ignores a ticked entry');
    const checked = phaseEntrySplitRegExp('Phase\\s+1\\b', '', { state: 'checked' });
    assert.ok(checked.test('- [X] Phase 1: x'));
    assert.ok(!checked.test('- [ ] Phase 1: x'));
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
    const subject = '- [X] Phase 1: x';
    const m = entry({ state: 'captured' }).exec(subject);
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
    const nameOf = (line) => re.exec(line)[1];
    assert.equal(nameOf('- [ ] **Phase 1: Add __init__ support**'), 'Add __init__ support');
    assert.equal(nameOf('- [ ] **Phase 1: Wire __tests__**'), 'Wire __tests__');
    assert.equal(nameOf('- [ ] __Phase 1: Name__'), 'Name');
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

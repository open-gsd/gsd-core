/**
 * #6238: a requirement traceability Status cell that carries a note beside the
 * status word (`Pending (blocked on an upstream decision)`) must advance like
 * the bare word. `requirements mark-complete` used to refuse it, roll the
 * checkbox back and report the requirement `not_found` although its checkbox
 * and row both exist; `phase complete` skipped the row silently.
 *
 * Both gates read the status word through `leadingRequirementStatus`
 * (src/markdown-table.cts). These tests drive the two commands end to end and
 * the reader as a property.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { leadingRequirementStatus } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

/** [cell, advances in mark-complete, advances in phase complete] */
const CELLS = [
  ['Pending', true, true],
  ['pending', true, true],
  ['PENDING', true, true],
  ['Pending (blocked on an upstream decision)', true, true],
  ['Pending - note', true, true],
  ['Pending: note', true, true],
  ['Pending-review', true, true],
  ['Gaps Found', true, true],
  ['Gaps  Found (reverted)', true, true],
  ['In Progress', false, true],
  ['In Progress (note)', false, true],
  ['Pendingx', false, false],
  ['Pendin', false, false],
  ['In Progres', false, false],
  ['Gaps Foun', false, false],
  ['Blocked (pending)', false, false],
  ['Not Pending', false, false],
  ['Complete', false, false],
  ['Completed', false, false],
  ['Deferred (pending)', false, false],
];

function idOf(i) {
  return `CELL-${String(i + 1).padStart(2, '0')}`;
}

function requirementsText(cells) {
  return [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    ...cells.map(([cell], i) => `- [ ] **${idOf(i)}**: requirement for ${JSON.stringify(cell)}.`),
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    ...cells.map(([cell], i) => `| ${idOf(i)} | Phase 01 | ${cell} |`),
    '',
  ].join('\n');
}

function rowOf(text, id) {
  const line = splitLines(text).find((l) => l.startsWith(`| ${id} |`));
  assert.ok(line, `no traceability row for ${id}`);
  return line.split('|')[3].trim();
}

function checkboxOf(text, id) {
  const m = new RegExp(`^- \\[( |x)\\] \\*\\*${id}\\*\\*`, 'm').exec(text);
  assert.ok(m, `no checkbox for ${id}`);
  return m[1] === 'x';
}

describe('requirements mark-complete reads the Status word (#6238)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  const reqPath = () => path.join(tmpDir, '.planning', 'REQUIREMENTS.md');

  test('mark-complete advances a Pending row that carries a note (#6238)', () => {
    fs.writeFileSync(reqPath(), requirementsText([
      ['Pending (blocked on an upstream decision)'],
      ['Pending'],
    ]));
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01', 'CELL-02'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.marked_complete, ['CELL-01', 'CELL-02']);
    assert.deepEqual(out.not_found, []);
    const after = fs.readFileSync(reqPath(), 'utf-8');
    assert.equal(rowOf(after, 'CELL-01'), 'Complete');
    assert.equal(rowOf(after, 'CELL-02'), 'Complete');
    assert.equal(checkboxOf(after, 'CELL-01'), true);
    assert.equal(checkboxOf(after, 'CELL-02'), true);
  });

  test('mark-complete accepts the status word with or without trailing prose, and refuses every other leading word', () => {
    fs.writeFileSync(reqPath(), requirementsText(CELLS));
    const ids = CELLS.map((_, i) => idOf(i));
    const r = runGsdTools(['requirements', 'mark-complete', ...ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    const after = fs.readFileSync(reqPath(), 'utf-8');
    assert.deepEqual(out.status_refused, CELLS.flatMap(([cell, advances], i) =>
      advances || cell === 'Complete' ? [] : [{ requirement: idOf(i), status: cell }]));
    CELLS.forEach(([cell, advances], i) => {
      const id = idOf(i);
      if (advances) {
        assert.ok(out.marked_complete.includes(id), `${JSON.stringify(cell)} must advance`);
        assert.equal(rowOf(after, id), 'Complete', `${JSON.stringify(cell)} row`);
        assert.equal(checkboxOf(after, id), true, `${JSON.stringify(cell)} checkbox`);
      } else {
        assert.ok(!out.marked_complete.includes(id), `${JSON.stringify(cell)} must stay refused`);
        assert.equal(rowOf(after, id), cell, `${JSON.stringify(cell)} row must be unchanged`);
        assert.equal(checkboxOf(after, id), false, `${JSON.stringify(cell)} checkbox must stay unchecked`);
      }
    });
  });

  test('mark-complete reports a requirement whose row reads `Complete (note)` and whose checkbox is checked as already complete', () => {
    fs.writeFileSync(reqPath(), requirementsText([['Complete (shipped in v1)']]).replace('- [ ] **CELL-01**', '- [x] **CELL-01**'));
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.already_complete, ['CELL-01']);
    assert.deepEqual(out.marked_complete, []);
    assert.deepEqual(out.not_found, []);
    assert.equal(rowOf(fs.readFileSync(reqPath(), 'utf-8'), 'CELL-01'), 'Complete (shipped in v1)');
  });

  test('revert-phase reads the Status word, so `Complete (note)` goes back to Gaps Found and `Completed` is left alone', () => {
    const cells = [['Complete (shipped in v1)'], ['Completed']];
    fs.writeFileSync(reqPath(), requirementsText(cells).replace(/- \[ \]/g, '- [x]'));
    const r = runGsdTools(['requirements', 'revert-phase', 'CELL-01', 'CELL-02'], tmpDir);
    assert.ok(r.success, r.error);
    const after = fs.readFileSync(reqPath(), 'utf-8');
    assert.equal(rowOf(after, 'CELL-01'), 'Gaps Found');
    assert.equal(rowOf(after, 'CELL-02'), 'Completed');
  });

  test('mark-complete still reports a requirement with no row as not_found', () => {
    fs.writeFileSync(reqPath(), requirementsText([['Pending']]));
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-99'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.marked_complete, []);
    assert.deepEqual(out.not_found, ['CELL-99']);
    assert.equal(Object.hasOwn(out, 'status_refused'), false);
    assert.equal(rowOf(fs.readFileSync(reqPath(), 'utf-8'), 'CELL-01'), 'Pending');
  });

  test('mark-complete reports a refused Status separately from an unknown ID (#6651)', () => {
    const before = requirementsText([['Blocked']]);
    fs.writeFileSync(reqPath(), before);
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01', 'CELL-99'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.not_found, ['CELL-99']);
    assert.deepEqual(out.status_refused, [{ requirement: 'CELL-01', status: 'Blocked' }]);
    assert.deepEqual(out.table_unmatched, []);
    assert.equal(out.updated, false);
    assert.equal(fs.readFileSync(reqPath(), 'utf-8'), before);
  });
  test('mark-complete reports refused Status under a positional ID header and rolls back the checkbox (#6651)', () => {
    const before = requirementsText([['Blocked'], ['Blocked (review)'], ['']])
      .replace('| Requirement | Phase | Status |', '| ID | Phase | Status |')
      .replace('- [ ] **CELL-02**', '- [x] **CELL-02**')
      .replace(/^- \[ \] \*\*CELL-03\*\*.*\n/m, '');
    fs.writeFileSync(reqPath(), before);
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01', 'CELL-02', 'CELL-03', 'CELL-99'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.status_refused, [
      { requirement: 'CELL-01', status: 'Blocked' },
      { requirement: 'CELL-02', status: 'Blocked (review)' },
      { requirement: 'CELL-03', status: '' },
    ]);
    assert.deepEqual(out.not_found, ['CELL-99']);
    assert.deepEqual(out.already_complete, []);
    assert.deepEqual(out.marked_complete, []);
    assert.equal(out.updated, false);
    assert.equal(fs.readFileSync(reqPath(), 'utf-8'), before);
  });

  test('mark-complete retains applied writes and reports refusal per input in mixed CRLF results (#6651)', () => {
    const before = requirementsText([['Pending'], ['Complete'], ['In Progress']])
      .replace('- [ ] **CELL-02**', '- [x] **CELL-02**')
      .replace(/\n/g, '\r\n');
    fs.writeFileSync(reqPath(), before);
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01', 'CELL-02', 'CELL-03', 'CELL-99', 'CELL-03'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.updated, true);
    assert.deepEqual(out.marked_complete, ['CELL-01']);
    assert.deepEqual(out.already_complete, ['CELL-02']);
    assert.deepEqual(out.not_found, ['CELL-99']);
    assert.deepEqual(out.status_refused, [
      { requirement: 'CELL-03', status: 'In Progress' },
      { requirement: 'CELL-03', status: 'In Progress' },
    ]);
    assert.equal(out.total, 5);
    assert.equal(out.write_set_complete, false);
    assert.equal(fs.readFileSync(reqPath(), 'utf-8').replace(/\r\n/g, '\n'), before.replace(/\r\n/g, '\n')
      .replace('- [ ] **CELL-01**', '- [x] **CELL-01**')
      .replace('| CELL-01 | Phase 01 | Pending |', '| CELL-01 | Phase 01 | Complete |'));
  });

  test('mark-complete does not invent a refusal for a row with no Status column (#6651)', () => {
    const before = requirementsText([['Blocked']])
      .replace(/^- \[ \] \*\*CELL-01\*\*.*\n/m, '')
      .replace('| Requirement | Phase | Status |', '| Requirement | Phase |')
      .replace('|-------------|-------|--------|', '|-------------|-------|')
      .replace('| CELL-01 | Phase 01 | Blocked |', '| CELL-01 | Phase 01 |');
    fs.writeFileSync(reqPath(), before);
    const r = runGsdTools(['requirements', 'mark-complete', 'CELL-01'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.not_found, ['CELL-01']);
    assert.equal(Object.hasOwn(out, 'status_refused'), false);
    assert.equal(fs.readFileSync(reqPath(), 'utf-8'), before);
  });
});

describe('phase complete reads the Status word (#6238)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = undefined; });

  /** A phase-1 project whose roadmap cites every CELL id, one row per cell. */
  function phaseFixture(cells) {
    tmpDir = createTempProject();
    const planDir = path.join(tmpDir, '.planning');
    const phase1Dir = path.join(planDir, 'phases', '01-preset');
    const phase2Dir = path.join(planDir, 'phases', '02-next');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.mkdirSync(phase2Dir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), requirementsText(cells));
    fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '- [ ] Phase 01: Preset',
      '- [ ] Phase 02: Next',
      '',
      '### Phase 01: Preset',
      '**Goal:** Build preset',
      `**Requirements**: ${cells.map((_, i) => idOf(i)).join(', ')}`,
      '**Plans:** 1 plans',
      '',
      '### Phase 02: Next',
      '**Goal:** whatever',
      '**Requirements:** TBD',
      '**Plans:** 1 plans',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Preset | 0/1 | Not started | - |',
      '| 02. Next | 0/1 | Not started | - |',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(planDir, 'STATE.md'), [
      '---', 'milestone: v1.3', '---',
      '# State',
      '',
      '**Current Phase:** 01',
      '**Completed Phases:** 0',
      '**Total Phases:** 2',
      '**Progress:** 0%',
      '',
    ].join('\n'));
    for (const [dir, n] of [[phase1Dir, '01'], [phase2Dir, '02']]) {
      fs.writeFileSync(path.join(dir, `${n}-01-PLAN.md`), '# Plan\nDo the work.\n');
      fs.writeFileSync(path.join(dir, `${n}-01-SUMMARY.md`), '# Summary\nDone.\n');
    }
    fs.writeFileSync(path.join(phase1Dir, '01-VERIFICATION.md'), ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'));
    fs.writeFileSync(path.join(planDir, 'config.json'), JSON.stringify({ workflow: { security_enforcement: false, nyquist_validation: false } }));
    return path.join(planDir, 'REQUIREMENTS.md');
  }

  test('phase complete advances annotated Pending / In Progress / Gaps Found rows', () => {
    const cells = CELLS.filter(([, , phaseAdvances]) => phaseAdvances);
    const reqFile = phaseFixture(cells);
    const r = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(r.success, r.error);
    const after = fs.readFileSync(reqFile, 'utf-8');
    cells.forEach(([cell], i) => {
      assert.equal(rowOf(after, idOf(i)), 'Complete', `${JSON.stringify(cell)} row`);
      assert.equal(checkboxOf(after, idOf(i)), true, `${JSON.stringify(cell)} checkbox`);
    });
  });

  test('phase complete still leaves a cited requirement that has no traceability row without one', () => {
    const cells = [['Pending (note)'], ['Pending']];
    const reqFile = phaseFixture(cells);
    // CELL-02 stays cited by the roadmap and keeps its checkbox, but loses its row.
    fs.writeFileSync(reqFile, splitLines(fs.readFileSync(reqFile, 'utf-8')).filter((l) => !l.startsWith('| CELL-02 |')).join('\n'));
    const r = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(r.success, r.error);
    const after = fs.readFileSync(reqFile, 'utf-8');
    assert.equal(rowOf(after, 'CELL-01'), 'Complete');
    assert.equal(splitLines(after).some((l) => l.startsWith('| CELL-02 |')), false, 'a missing row must not be invented');
  });

  test('phase complete keeps refusing non-advanceable cells', () => {
    const cells = CELLS.filter(([, , phaseAdvances]) => !phaseAdvances);
    const reqFile = phaseFixture(cells);
    const r = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(r.success, r.error);
    const after = fs.readFileSync(reqFile, 'utf-8');
    cells.forEach(([cell], i) => {
      assert.equal(rowOf(after, idOf(i)), cell, `${JSON.stringify(cell)} row must be unchanged`);
      assert.equal(checkboxOf(after, idOf(i)), false, `${JSON.stringify(cell)} checkbox must stay unchecked`);
    });
  });
});

describe('leadingRequirementStatus (#6238)', () => {
  const ALL = ['pending', 'in progress', 'gaps found'];
  const spelled = { pending: ['pending', 'Pending', 'PENDING'], 'in progress': ['in progress', 'In Progress', 'in  progress'], 'gaps found': ['gaps found', 'Gaps Found', 'gaps\tfound'] };

  test('reads the leading word and ignores what follows (property)', () => {
    fc.assert(fc.property(
      fc.constantFrom(...ALL),
      fc.nat(2),
      fc.string({ maxLength: 40 }),
      fc.constantFrom(' ', ' (', ' - ', ': ', '(', '.', '/'),
      (word, spelling, prose, sep) => {
        const cell = `${spelled[word][spelling]}${sep}${prose}`;
        assert.equal(leadingRequirementStatus(cell, ALL), word);
      },
    ));
  });

  test('a word character glued onto the status word is not a status (limit+1)', () => {
    fc.assert(fc.property(
      fc.constantFrom(...ALL),
      fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/),
      (word, glued) => {
        assert.equal(leadingRequirementStatus(`${word}${glued}`, ALL), null);
      },
    ));
  });

  test('only the words the caller passes advance', () => {
    assert.equal(leadingRequirementStatus('In Progress (note)', ['pending', 'gaps found']), null);
    assert.equal(leadingRequirementStatus('In Progress (note)', ALL), 'in progress');
    assert.equal(leadingRequirementStatus('', ALL), null);
    assert.equal(leadingRequirementStatus('Complete', ALL), null);
    assert.equal(leadingRequirementStatus('Not Pending', ALL), null);
  });
});

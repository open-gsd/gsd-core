'use strict';

/**
 * #5844: Traceability row-existence READ, independent of the table's columns.
 *
 * Consumers: `phase complete` (ghost REQ-ID check) and `requirements
 * mark-complete` (table_unmatched drift bucket). Both used a no-op write through
 * the Status column to ask "is there a row", which answers "no" for a table that
 * has no Status column.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const markdownTable = require('../gsd-core/bin/lib/markdown-table.cjs');

const doc = (tableLines, eol = '\n') =>
  ['# Requirements', '', '- [ ] **KNOWN-01**: a thing', '', '## Traceability', '', ...tableLines, ''].join(eol);

describe('#5844 traceabilityRowExists', () => {
  const exists = (text, id) => {
    assert.strictEqual(typeof markdownTable.traceabilityRowExists, 'function', 'traceabilityRowExists is exported');
    return markdownTable.traceabilityRowExists(text, id);
  };

  test('finds a row in a table that has no Status column', () => {
    assert.strictEqual(exists(doc(['| Requirement | Phase |', '|---|---|', '| KNOWN-01 | Phase 1 |']), 'KNOWN-01'), true);
  });

  test('finds a row in a table that has a Status column', () => {
    assert.strictEqual(exists(doc(['| Requirement | Phase | Status |', '|---|---|---|', '| KNOWN-01 | Phase 1 | Pending |']), 'KNOWN-01'), true);
  });

  test('is case-insensitive on the ID', () => {
    assert.strictEqual(exists(doc(['| Requirement | Phase |', '|---|---|', '| known-01 | Phase 1 |']), 'KNOWN-01'), true);
  });

  test('keys on the first cell only', () => {
    assert.strictEqual(exists(doc(['| Phase | Requirement |', '|---|---|', '| Phase 1 | KNOWN-01 |']), 'KNOWN-01'), false);
  });

  test('an ID absent from every row is not found', () => {
    assert.strictEqual(exists(doc(['| Requirement | Phase |', '|---|---|', '| OTHER-01 | Phase 1 |']), 'KNOWN-01'), false);
  });

  test('a matching first cell in a table OUTSIDE the Traceability section is not a row', () => {
    const text = [
      '# Requirements', '', '## Phase map', '', '| Requirement | Phase |', '|---|---|', '| KNOWN-01 | Phase 1 |', '',
      '## Traceability', '', '| Requirement | Phase |', '|---|---|', '| OTHER-01 | Phase 1 |', '',
    ].join('\n');
    assert.strictEqual(exists(text, 'KNOWN-01'), false);
    assert.strictEqual(exists(text, 'OTHER-01'), true);
  });

  test('with no Traceability heading only the FIRST table counts (parity with updateTraceabilityCell)', () => {
    const text = [
      '# Requirements', '', '| Requirement | Phase |', '|---|---|', '| FIRST-01 | Phase 1 |', '', 'prose', '',
      '| Requirement | Phase |', '|---|---|', '| SECOND-01 | Phase 2 |', '',
    ].join('\n');
    assert.strictEqual(exists(text, 'FIRST-01'), true);
    assert.strictEqual(exists(text, 'SECOND-01'), false);
  });

  test('parity: agrees with the Status-column write probe on every Status table', () => {
    const idArb = fc.stringMatching(/^[A-Z]{2,6}-[0-9]{2}$/);
    fc.assert(
      fc.property(idArb, idArb, fc.boolean(), (id, other, withHeading) => {
        const rows = ['| Requirement | Phase | Status |', '|---|---|---|', `| ${id} | Phase 1 | Pending |`];
        const text = withHeading ? doc(rows) : rows.join('\n') + '\n';
        for (const probe of [id, other]) {
          const writeProbe = markdownTable.updateTraceabilityCell(
            text, (row) => (Object.values(row)[0] ?? '').trim().toLowerCase() === probe.toLowerCase(), 'Status', (c) => c,
          ).ok;
          assert.strictEqual(markdownTable.traceabilityRowExists(text, probe), writeProbe);
        }
      }),
    );
  });

  test('a document with no table is not found', () => {
    assert.strictEqual(exists('# Requirements\n\n- [ ] **KNOWN-01**: x\n', 'KNOWN-01'), false);
  });

  test('CRLF line endings do not change the answer', () => {
    assert.strictEqual(exists(doc(['| Requirement | Phase |', '|---|---|', '| KNOWN-01 | Phase 1 |'], '\r\n'), 'KNOWN-01'), true);
  });

  test('property: a row written under any column set is found, and an absent id is not', () => {
    const idArb = fc.stringMatching(/^[A-Z]{2,6}-[0-9]{2}$/);
    const columnArb = fc.uniqueArray(fc.constantFrom('Phase', 'Status', 'Notes', 'Owner'), { minLength: 0, maxLength: 4 });
    const eolArb = fc.constantFrom('\n', '\r\n');
    fc.assert(
      fc.property(idArb, idArb, columnArb, eolArb, fc.boolean(), (id, other, extra, eol, lower) => {
        fc.pre(id.toLowerCase() !== other.toLowerCase());
        const cols = ['Requirement', ...extra];
        const rowFirst = lower ? id.toLowerCase() : id;
        const text = doc(
          [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, `| ${[rowFirst, ...extra.map(() => 'x')].join(' | ')} |`],
          eol,
        );
        assert.strictEqual(markdownTable.traceabilityRowExists(text, id), true);
        assert.strictEqual(markdownTable.traceabilityRowExists(text, other), false);
      }),
    );
  });
});

describe('#5844 requirements mark-complete on a Status-less Traceability table', () => {
  let tmp;
  beforeEach(() => { tmp = createTempProject('gsd-5844-mc-'); });
  afterEach(() => { cleanup(tmp); });

  const markComplete = (tableLines) => {
    fs.writeFileSync(path.join(tmp, '.planning', 'REQUIREMENTS.md'), doc(tableLines));
    const result = runGsdTools(['requirements', 'mark-complete', 'KNOWN-01'], tmp);
    assert.ok(result.success, `mark-complete failed: ${result.error}`);
    return JSON.parse(result.output);
  };

  test('a row that exists without a Status column is not reported as table_unmatched', () => {
    const out = markComplete(['| Requirement | Phase |', '|---|---|', '| KNOWN-01 | Phase 1 |']);
    assert.deepStrictEqual(out.table_unmatched, []);
    assert.deepStrictEqual(out.marked_complete, ['KNOWN-01']);
  });

  test('an ID with no row at all is still reported as table_unmatched', () => {
    const out = markComplete(['| Requirement | Phase |', '|---|---|', '| OTHER-01 | Phase 1 |']);
    assert.deepStrictEqual(out.table_unmatched, ['KNOWN-01']);
  });

  test('a Status table is unchanged: the row flips to Complete', () => {
    const out = markComplete(['| Requirement | Phase | Status |', '|---|---|---|', '| KNOWN-01 | Phase 1 | Pending |']);
    assert.deepStrictEqual(out.table_unmatched, []);
    assert.deepStrictEqual(out.marked_complete, ['KNOWN-01']);
    assert.match(fs.readFileSync(path.join(tmp, '.planning', 'REQUIREMENTS.md'), 'utf-8'), /\| KNOWN-01 \| Phase 1 \| Complete \|/);
  });
});

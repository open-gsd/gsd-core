'use strict';

/**
 * Behavioral tests for markdown-table.cjs
 *
 * Module: gsd-core/bin/lib/markdown-table.cjs
 * Exports: parseMarkdownTable, matchTableSchema, TABLE_SCHEMAS
 *
 * Covers:
 *   - parseMarkdownTable happy path (4-col + 5-col headers, cells addressed by name)
 *   - BOUNDARY coverage: ragged data rows at limit-1 / limit / limit+1 cell counts
 *   - malformed-input error paths (empty, non-string, no table, missing delimiter row)
 *   - matchTableSchema resolving every canonical variant + null for unknown headers
 *   - fast-check round-trip property test
 *   - registry <-> template/workflow parity guard (ADR-2143 §3 Generative-Fix-
 *     Divergence guard) — every TABLE_SCHEMAS header must appear verbatim in the
 *     source file that generates it
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { parseMarkdownTable, matchTableSchema, TABLE_SCHEMAS, appendQuickTaskRow, findTableBySchema, findTableWithColumns } = require('../gsd-core/bin/lib/markdown-table.cjs');

const ROOT = path.join(__dirname, '..');

// ─── parseMarkdownTable: happy path ───────────────────────────────────────────

describe('parseMarkdownTable: happy path', () => {
  test('parses a 4-column flat RoadmapProgress table, cells addressed by name', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(result.value.rows.length, 2);
    assert.equal(result.value.rows[0]['Phase'], '1. Alpha');
    assert.equal(result.value.rows[0]['Plans Complete'], '2/2');
    assert.equal(result.value.rows[0]['Status'], 'Complete');
    assert.equal(result.value.rows[1]['Status'], 'In Progress');
  });

  test('parses a 5-column milestone-grouped RoadmapProgress table, cells addressed by name', () => {
    const src = [
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '|---|---|---|---|---|',
      '| 1. Alpha | v1.0 | 2/2 | Complete | ✅ |',
      '| 2. Beta | v1.1 | 0/3 | Planned | |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Phase', 'Milestone', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(result.value.rows[0]['Milestone'], 'v1.0');
    assert.equal(result.value.rows[1]['Milestone'], 'v1.1');
    assert.equal(result.value.rows[1]['Status'], 'Planned');
  });

  test('finds the FIRST table when the section has leading prose', () => {
    const src = [
      'Some intro prose before the table.',
      '',
      '| Requirement | Phase | Status |',
      '| --- | --- | --- |',
      '| R1 | 1 | Done |',
    ].join('\n');

    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.columns, ['Requirement', 'Phase', 'Status']);
    assert.equal(result.value.rows[0]['Requirement'], 'R1');
  });
});

// ─── BOUNDARY coverage: ragged data rows ──────────────────────────────────────

describe('parseMarkdownTable: boundary coverage (ragged rows)', () => {
  const header = '| Phase | Plans Complete | Status | Completed |';
  const delimiter = '| --- | --- | --- | --- |';

  test('limit-1: a 3-cell data row (one short of the 4-column header) is a typed error', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.match(result.reason, /row 1 has 3 cells, expected 4/);
  });

  test('limit: a 4-cell data row (exactly matching the 4-column header) parses ok', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete | ✅ |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, true);
    assert.equal(result.value.rows.length, 1);
  });

  test('limit+1: a 5-cell data row (one over the 4-column header) is a typed error', () => {
    const src = [header, delimiter, '| 1. Alpha | 2/2 | Complete | ✅ | extra |'].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.match(result.reason, /row 1 has 5 cells, expected 4/);
  });
});

// ─── Malformed input ──────────────────────────────────────────────────────────

describe('parseMarkdownTable: malformed input', () => {
  test('empty string returns a typed error', () => {
    const result = parseMarkdownTable('');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('whitespace-only string returns a typed error', () => {
    const result = parseMarkdownTable('   \n  \n  ');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('non-string input returns a typed error, does not throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseMarkdownTable(42);
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty or non-string input');
  });

  test('content with no pipe table returns a typed error', () => {
    const result = parseMarkdownTable('# Heading\n\nJust some prose, no table here.\n');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no table found');
  });

  test('missing delimiter row returns a typed error', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing delimiter row');
  });

  test('delimiter row present but column count mismatch returns a typed error', () => {
    const src = [
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');
    const result = parseMarkdownTable(src);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'delimiter/header column count mismatch');
  });
});

// ─── matchTableSchema ──────────────────────────────────────────────────────────

describe('matchTableSchema', () => {
  test('resolves every canonical variant header to its {id,label}', () => {
    for (const [id, variants] of Object.entries(TABLE_SCHEMAS)) {
      for (const variant of variants) {
        const match = matchTableSchema(variant.columns);
        assert.deepEqual(
          match,
          { id, label: variant.label },
          `expected ${id}/${variant.label} to resolve for columns ${JSON.stringify(variant.columns)}`,
        );
      }
    }
  });

  test('returns null for an unknown header', () => {
    const match = matchTableSchema(['Foo', 'Bar', 'Baz']);
    assert.equal(match, null);
  });

  test('returns null when column order differs from every variant', () => {
    const match = matchTableSchema(['Status', 'Phase', 'Plans Complete', 'Completed']);
    assert.equal(match, null);
  });

  test('returns null when column count differs from every variant', () => {
    const match = matchTableSchema(['Phase', 'Plans Complete', 'Status']);
    assert.equal(match, null);
  });
});

// ─── Property test: round-trip render -> parse ────────────────────────────────

describe('parseMarkdownTable: property-based round-trip', () => {
  // Safe cell text: no '|' or newline, non-empty, bounded length.
  const safeCell = fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((s) => !s.includes('|') && !s.includes('\n') && !s.includes('\r') && s.trim().length > 0)
    .map((s) => s.trim());

  const safeColumnName = fc
    .string({ minLength: 1, maxLength: 6 })
    .filter((s) => !s.includes('|') && !s.includes('\n') && !s.includes('\r') && s.trim().length > 0)
    .map((s) => s.trim());

  function renderTable(columns, rows) {
    const lines = [];
    lines.push(`| ${columns.join(' | ')} |`);
    lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      lines.push(`| ${row.join(' | ')} |`);
    }
    return lines.join('\n');
  }

  // A table's rows depend on its column count, so derive the rows arbitrary
  // from the generated columns via .chain() (dependent arbitrary generation) —
  // never fc.sample() inside a property, which breaks shrinking/reproducibility.
  const tableArb = fc.uniqueArray(safeColumnName, { minLength: 1, maxLength: 4 }).chain((columns) =>
    fc.tuple(
      fc.constant(columns),
      fc.array(fc.array(safeCell, { minLength: columns.length, maxLength: columns.length }), { maxLength: 4 }),
    ),
  );

  test('property: rendering a table then parsing it round-trips columns and row values', () => {
    fc.assert(
      fc.property(tableArb, ([columns, rows]) => {
        const src = renderTable(columns, rows);

        const result = parseMarkdownTable(src);
        assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
        assert.deepEqual(result.value.columns, columns);
        assert.equal(result.value.rows.length, rows.length);
        rows.forEach((cells, i) => {
          columns.forEach((col, j) => {
            assert.equal(result.value.rows[i][col], cells[j]);
          });
        });
      }),
    );
  });
});

// ─── appendQuickTaskRow (#2133) ────────────────────────────────────────────────

describe('appendQuickTaskRow (#2133)', () => {
  const noStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  const withStatusState = [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Status | Directory |',
    '|---|-------------|------|--------|--------|-----------|',
    '| 1 | fix typo | 2026-01-01 | abc1234 | Pass | — |',
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');

  test('5-col no-status table: appends a 5-cell row, content contains it, variant is no-status', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'add missing import',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.variant, 'no-status');
    assert.equal(result.value.row, '| 2 | add missing import | 2026-07-13 | a574966 | — |');
    assert.ok(result.value.content.includes(result.value.row));
  });

  test('6-col with-status table: appends a 6-cell row, variant is with-status', () => {
    const result = appendQuickTaskRow(withStatusState, {
      description: 'bump version',
      date: '2026-07-13',
      commit: 'b6fc5f6',
      status: 'Needs Review',
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.variant, 'with-status');
    assert.equal(result.value.row, '| 2 | bump version | 2026-07-13 | b6fc5f6 | Needs Review | — |');
    assert.ok(result.value.content.includes(result.value.row));
  });

  test('unknown/garbled header (4-col table): fails loud with a reason instead of silently skipping', () => {
    const garbled = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| Foo | Bar | Baz | Qux |',
      '|---|---|---|---|',
      '| 1 | 2 | 3 | 4 |',
    ].join('\n');
    const result = appendQuickTaskRow(garbled, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unrecognized Quick Tasks schema/);
  });

  test('no "Quick Tasks Completed" section: fails loud with a reason', () => {
    const noSection = '# STATE\n\n### Blockers/Concerns\nNone\n';
    const result = appendQuickTaskRow(noSection, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no Quick Tasks Completed section/);
  });

  test('boundary: next row number is 1 with zero data rows, 3 with two data rows', () => {
    const zeroRows = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
    ].join('\n');
    const zeroResult = appendQuickTaskRow(zeroRows, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(zeroResult.ok, true);
    assert.match(zeroResult.value.row, /^\| 1 \|/);

    const twoRows = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Directory |',
      '|---|-------------|------|--------|-----------|',
      '| 1 | first | 2026-01-01 | aaa1111 | — |',
      '| 2 | second | 2026-01-02 | bbb2222 | — |',
    ].join('\n');
    const twoResult = appendQuickTaskRow(twoRows, { description: 'x', date: '2026-07-13', commit: 'abc' });
    assert.equal(twoResult.ok, true);
    assert.match(twoResult.value.row, /^\| 3 \|/);
  });

  test('appended row cell count equals the header column count (round-trips via parseMarkdownTable)', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'round trip check',
      date: '2026-07-13',
      commit: 'ccc3333',
    });
    assert.equal(result.ok, true);
    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.value.rows.length, 2);
    for (const row of reparsed.value.rows) {
      assert.equal(Object.keys(row).length, reparsed.value.columns.length);
    }
  });

  // ─── Regression: cell-value escaping (#2242 review Fix 1) ──────────────────
  // A raw `|` or newline in `description` used to be inserted verbatim,
  // corrupting the table (extra column / a fake extra row) — the now-fail-loud
  // parseMarkdownTable rejects the resulting ragged row.

  test('description containing "|" round-trips: ok:true, no ragged row, cell value preserved', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'fix a | b bug',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'fix a | b bug');
  });

  // ─── Regression: backslash escaping (CodeQL js/incomplete-sanitization) ────
  // escapeCell used to escape `|` -> `\|` without first escaping a literal `\`,
  // so a description with a raw backslash (e.g. a Windows path) could produce
  // an escape sequence that splitTableRow misreads on unescape. escapeCell now
  // escapes `\` -> `\\` before `|` -> `\|`, and splitTableRow reverses both.

  test('description containing a literal backslash round-trips byte-for-byte', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'fix C:\\path bug',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'fix C:\\path bug');
  });

  test('description containing backslash-pipe ("a\\|b") round-trips to exactly "a\\|b"', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'a\\|b',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'a\\|b');
  });

  test('description containing a newline collapses to a single-line cell and round-trips', () => {
    const result = appendQuickTaskRow(noStatusState, {
      description: 'line one\nline two',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);
    // Collapsed to a single line: the row itself must not contain a newline.
    assert.ok(!result.value.row.includes('\n'));

    const section = result.value.content.split('### Blockers/Concerns')[0];
    const reparsed = parseMarkdownTable(section);
    assert.equal(reparsed.ok, true, `expected ok:true (not a ragged-row error), got ${JSON.stringify(reparsed)}`);
    assert.equal(reparsed.value.rows.length, 2);
    assert.equal(reparsed.value.rows[1]['Description'], 'line one line two');
  });

  // ─── Regression: CRLF preservation (#2242 review Fix 3) ─────────────────────
  // section.body used to be split on /\r?\n/ and rejoined with '\n', downgrading
  // a CRLF section to mixed EOL.

  test('CRLF-input STATE.md keeps \\r\\n in the touched section (no mixed EOL)', () => {
    const crlfState = noStatusState.replace(/\n/g, '\r\n');
    const result = appendQuickTaskRow(crlfState, {
      description: 'crlf check',
      date: '2026-07-13',
      commit: 'a574966',
    });
    assert.equal(result.ok, true);

    const section = result.value.content.split('### Blockers/Concerns')[0];
    // No mixed EOL: every line break in the touched section is \r\n, and there
    // must be no bare \n (i.e. no \n NOT preceded by \r).
    assert.ok(!/(?<!\r)\n/.test(section), 'expected no bare \\n (mixed EOL) in the touched section');
    assert.ok(section.includes('\r\n'), 'expected \\r\\n to be preserved in the touched section');
  });
});

// ─── findTableBySchema (#2242 review Fix 4) ────────────────────────────────────

describe('findTableBySchema', () => {
  test('finds a RoadmapProgress table that appears after other content, not under a "## Progress" heading', () => {
    const doc = [
      '# Roadmap',
      '',
      '## Overview',
      '',
      'Some prose describing the roadmap. No table here.',
      '',
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
    ].join('\n');

    const table = findTableBySchema(doc, 'RoadmapProgress');
    assert.notEqual(table, null);
    assert.deepEqual(table.columns, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
  });

  test('finds a RoadmapProgress table that is not the first table in the document', () => {
    const doc = [
      '# Roadmap',
      '',
      '## Legend',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');

    const table = findTableBySchema(doc, 'RoadmapProgress');
    assert.notEqual(table, null);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
  });

  test('returns null when no table matches the given schema', () => {
    const doc = [
      '# Roadmap',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
    ].join('\n');

    assert.equal(findTableBySchema(doc, 'RoadmapProgress'), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(findTableBySchema(undefined, 'RoadmapProgress'), null);
  });
});

// ─── findTableWithColumns (#2242: column-order/count-invariant reader seam) ──

describe('findTableWithColumns', () => {
  test('finds a table whose header has the required columns in shuffled order, plus extra/injected columns', () => {
    const doc = [
      '## Progress',
      '',
      '| Status | Foo | Phase | Plans Complete | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| Complete | x | 1. Alpha | 2/2 | ✅ |',
      '| In Progress | x | 2. Beta | 1/2 | |',
    ].join('\n');

    const table = findTableWithColumns(doc, ['Phase', 'Plans Complete', 'Status', 'Completed']);
    assert.notEqual(table, null);
    assert.deepEqual(table.columns, ['Status', 'Foo', 'Phase', 'Plans Complete', 'Completed']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]['Phase'], '1. Alpha');
    assert.equal(table.rows[0]['Status'], 'Complete');
    assert.equal(table.rows[1]['Plans Complete'], '1/2');
  });

  test('returns null when a required column is absent from every table header', () => {
    const doc = [
      '## Progress',
      '',
      '| Phase | Owner | Completed |',
      '| --- | --- | --- |',
      '| 1. Alpha | jo | ✅ |',
    ].join('\n');

    assert.equal(findTableWithColumns(doc, ['Phase', 'Plans Complete', 'Status', 'Completed']), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(findTableWithColumns(undefined, ['Phase']), null);
  });
});

// ─── PARITY / DRIFT guard: registry <-> template/workflow source files ───────

describe('TABLE_SCHEMAS parity: registry headers must appear verbatim in their source templates', () => {
  /**
   * Build the `| a | b | c |` header line for a variant and assert the given
   * source file contains it verbatim (whitespace around pipes normalized so
   * template formatting quirks don't cause false failures).
   */
  function assertHeaderInFile(relPath, variant) {
    const fullPath = path.join(ROOT, relPath);
    const content = fs.readFileSync(fullPath, 'utf8'); // allow-test-rule: runtime-contract-is-the-product — template/registry parity (#2242)
    const expectedHeader = `| ${variant.columns.join(' | ')} |`;
    const normalize = (s) => s.replace(/[ \t]*\|[ \t]*/g, '|').trim();
    const normalizedExpected = normalize(expectedHeader);
    const found = content
      .split(/\r?\n/)
      .some((line) => normalize(line) === normalizedExpected);
    assert.ok(
      found,
      `expected header ${JSON.stringify(expectedHeader)} to appear verbatim in ${relPath}`,
    );
  }

  test('RoadmapProgress variants appear in gsd-core/templates/roadmap.md', () => {
    for (const variant of TABLE_SCHEMAS.RoadmapProgress) {
      assertHeaderInFile('gsd-core/templates/roadmap.md', variant);
    }
  });

  test('RequirementsTraceability variant appears in gsd-core/templates/requirements.md', () => {
    for (const variant of TABLE_SCHEMAS.RequirementsTraceability) {
      assertHeaderInFile('gsd-core/templates/requirements.md', variant);
    }
  });

  test('QuickTasks variants appear in gsd-core/workflows/quick.md', () => {
    for (const variant of TABLE_SCHEMAS.QuickTasks) {
      assertHeaderInFile('gsd-core/workflows/quick.md', variant);
    }
  });

  test('Security variants appear in gsd-core/templates/SECURITY.md', () => {
    for (const variant of TABLE_SCHEMAS.Security) {
      assertHeaderInFile('gsd-core/templates/SECURITY.md', variant);
    }
  });
});

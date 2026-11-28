'use strict';

/**
 * #6787: the artifact registry in gsd-core/templates/README.md names the commands that write each file.
 * Every command it names must be a registered live command, and the rows that once named the wrong producer
 * must name the right ones. Command existence goes through the shared live-command resolver, not filenames:
 * six command files (the ns-* routers) register a slug that differs from their basename.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { getLiveCommandTokens } = require('./helpers/live-command-registry.cjs');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'README.md'), 'utf8');

const COLON_RE = /\/gsd:([a-z0-9-]+)/g;
const HYPHEN_RE = /\/gsd-(?![a-z0-9-]+\.(?:md|cjs)\b)[a-z0-9-]+/;
const SEPARATOR_ROW_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Rows of tables that carry a `Produced by` column, as `{ file, producers, producerCell }`: `file` is the first
 * cell's code span, `producers` the sorted unique command slugs named in that row's Produced-by cell only — a
 * `/gsd:` mention in the Template or Purpose column is not a producer claim.
 */
function registryRows(markdown) {
  const rows = [];
  let producerIdx = null;
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) { producerIdx = null; continue; }
    if (SEPARATOR_ROW_RE.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const hdr = cells.findIndex((c) => /^produced by$/i.test(c));
    if (hdr >= 0) { producerIdx = hdr; continue; }
    if (producerIdx === null || cells.length <= producerIdx) continue;
    const file = /^`([^`]+)`$/.exec(cells[0]);
    if (!file) continue;
    const producers = [...new Set([...cells[producerIdx].matchAll(COLON_RE)].map((m) => m[1]))].sort();
    rows.push({ file: file[1], producers, producerCell: cells[producerIdx] });
  }
  return rows;
}

describe('templates registry producers (#6787)', () => {
  const rows = registryRows(README);
  const live = getLiveCommandTokens();

  test('the registry has rows that name producers', () => {
    assert.ok(rows.some((r) => r.producers.length > 0));
  });

  test('every command the page names is a live registered command', () => {
    for (const m of README.matchAll(COLON_RE)) {
      assert.ok(live.has('/gsd:' + m[1]), `${m[0]} is not a live command`);
    }
  });

  test('producer cells name commands in the colon form the source artifacts carry', () => {
    for (const row of rows) {
      assert.equal(HYPHEN_RE.test(row.producerCell), false, `${row.file} producer cell uses the hyphen form`);
    }
  });

  test('the corrected rows name their real producers', () => {
    const producersOf = (file) => (rows.find((r) => r.file === file) || { producers: [] }).producers;
    assert.deepEqual(producersOf('NN-UAT.md'), ['execute-phase', 'verify-work']);
    assert.deepEqual(producersOf('NN-VALIDATION.md'), ['plan-phase', 'validate-phase']);
    assert.deepEqual(producersOf('CLAUDE.md'), ['new-project', 'profile-user']);
  });
});

describe('registryRows properties', () => {
  const cellArb = fc.oneof(
    fc.constantFrom('`/gsd:alpha`', '`/gsd:beta` (Nyquist)', '`/gsd:alpha`, `/gsd:alpha`', 'nothing', '`alpha.md`', '`/gsd:alpha` `x`'),
  );
  const tableArb = fc.tuple(cellArb, cellArb, cellArb).map(([a, b, c]) =>
    '| File | Template | Produced by | Purpose |\n|---|---|---|---|\n| `F.md` | ' + a + ' | ' + b + ' | ' + c + ' |');

  test('every captured producer is a colon token present in the Produced-by cell, unique and sorted', () => {
    fc.assert(
      fc.property(tableArb, (table) => {
        const parsed = registryRows(table);
        const { producers, producerCell } = parsed[0];
        return producers.every((p, n) => producerCell.includes('/gsd:' + p)
          && (n === 0 || producers[n - 1] < p)
          && new Set(producers).size === producers.length);
      }),
    );
  });
});

'use strict';

// 6420-plan-document-linear.test.cjs — parsePlanDocument must stay linear on
// two malformed shapes: an unclosed `<task ` run, and `<objective>` followed
// by a long newline run. The budgets are deliberately generous (tens of times
// the expected linear time, below the quadratic time measured at base in
// 10-diagnosis.md); every budget row ALSO asserts the exact result, so an
// early return cannot pass by skipping work.
//
// Timing-rule note: CLAUDE.md's clock-seam rule governs
// logic that reads the clock; this is a performance-boundary assertion the
// issue's acceptance criteria demand verbatim ("finish within a fixed
// generous budget in a regression test").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { parsePlanDocument } = require('../gsd-core/bin/lib/plan-document.cjs');

const BUDGET_MS = 5000;

function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
}

test('100k unclosed <task openings parse within budget with zero matches (#6420)', () => {
  const doc = '<task '.repeat(100000);
  const { ms, value } = timed(() => parsePlanDocument(doc));
  // Performance budget required verbatim by #6420's acceptance criterion; the fixed
  // bound is ~50x the expected linear time so CI variance cannot flake it, and the
  // result assertion below keeps an early return from passing.
  // eslint-disable-next-line local/no-elapsed-assertion -- required perf-budget boundary for #6420, not a flaky duration check
  assert.ok(ms < BUDGET_MS, `quadratic scan: ${ms.toFixed(0)}ms for 100k unclosed openings`);
  assert.equal(value.taskCount, 0);
});

test('100k newlines after <objective> parse within budget with no objective (#6420)', () => {
  const doc = '<objective>' + '\n'.repeat(100000);
  const { ms, value } = timed(() => parsePlanDocument(doc));
  // eslint-disable-next-line local/no-elapsed-assertion -- required perf-budget boundary for #6420, not a flaky duration check
  assert.ok(ms < BUDGET_MS, `quadratic scan: ${ms.toFixed(0)}ms for 100k newlines`);
  assert.equal(value.objective, null);
});

// ─── characterization: results identical to today's for near-boundary shapes ──

test('closed-then-unclosed openings keep the closed match and its attributes (#6420)', () => {
  const r = parsePlanDocument('<task type="auto"><name>A</name></task>\n<task ');
  assert.equal(r.taskCount, 1);
  assert.equal(r.tasks[0].name, 'A');
  assert.equal(r.tasks[0].type, 'auto');
});

test('two closed openings yield two rows bounded by the next opening (#6420)', () => {
  const r = parsePlanDocument('<task><name>A</name><task><name>B</name></task>');
  assert.equal(r.taskCount, 2);
});

test('multi-newline, spaces-only, and whitespace-tail objectives keep today results (#6420)', () => {
  assert.equal(parsePlanDocument('<objective>\n\n\n  real text\nmore').objective, 'real text');
  assert.equal(parsePlanDocument('<objective>   spaced').objective, 'spaced');
  assert.equal(parsePlanDocument('<objective>\n\n\n').objective, null);
});

test('objective matching stays case-sensitive (#6420)', () => {
  assert.equal(parsePlanDocument('<OBJECTIVE>x</OBJECTIVE>').objective, null);
});

test('objective line ends at CR as well as LF (#6420)', () => {
  assert.equal(parsePlanDocument('<objective>a\rb').objective, 'a');
  assert.equal(parsePlanDocument('<objective>\r\ntext').objective, 'text');
});

// ─── oracle parity (parser ⇒ fast-check required by CLAUDE.md) ────────────────

// The pre-fix regexes, kept here as reference oracles (precedent: the parse()
// reference in tests/jsonc-edit.test.cjs). Generated documents are short, so
// the quadratic oracle stays cheap.
const SEED = 6420;
const NUM_RUNS = 300;
const docArb = fc
  .array(
    fc.constantFrom('<task ', '<task>', '>', '\n', '\r', '\t', ' ', 'x', '<objective>', '</task>'),
    { minLength: 0, maxLength: 40 }
  )
  .map((tokens) => tokens.join(''));

test('linear scans agree with the pre-fix regexes on generated documents (#6420)', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      const r = parsePlanDocument(doc);
      const expectedCount = [...doc.matchAll(/<task(?=[\s>])[^>]*>/gi)].length;
      assert.equal(r.taskCount, expectedCount, `task count diverges on ${JSON.stringify(doc)}`);
      const m = doc.match(/<objective>\s*\n?\s*(.+)/);
      // Public chain is `extractObjective(content) || fm.objective || null`
      // (generated docs carry no frontmatter), so an empty trim collapses to null.
      assert.equal(r.objective, m ? (m[1].trim() || null) : null, `objective diverges on ${JSON.stringify(doc)}`);
    }),
    { seed: SEED, numRuns: NUM_RUNS }
  );
});

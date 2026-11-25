'use strict';

// 5990-unterminated-block-comment-parity.test.cjs — the three JSONC readers must agree.
//
// #5990: the block-comment skip in each reader (bin/install.js stripJsonComments,
// src/settings-jsonc.cts stripJsonComments, src/jsonc-edit.cts parseJsonc) walked
// to the end of input without verifying the closing delimiter, so a truncated
// block comment was dropped and the file parsed as if the comment were closed.
// All three must throw SyntaxError on the same inputs and keep parsing every
// terminated form. Parity test per the #5989 precedent; corpus lives in
// tests/fixtures/adversarial/config/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { parseJsonc: parseSharedJsonc } = require('../gsd-core/bin/lib/settings-jsonc.cjs');
const { parseJsonc: parseJsoncEdit } = require('../gsd-core/bin/lib/jsonc-edit.cjs');

let installExports;
{
  process.env.GSD_TEST_MODE = '1';
  const _origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true; // suppress banner (tests/settings-jsonc.test.cjs pattern)
  try {
    installExports = require('../bin/install.js');
  } finally {
    process.stdout.write = _origWrite;
  }
}
const { stripJsonComments } = installExports;

// The three exported reader surfaces, at the altitude callers use them.
const READERS = [
  ['install.js', (doc) => JSON.parse(stripJsonComments(doc))],
  ['settings-jsonc', (doc) => parseSharedJsonc(doc)],
  ['jsonc-edit', (doc) => parseJsoncEdit(doc)],
];

function attempt(fn, doc) {
  try {
    return { ok: true, value: fn(doc) };
  } catch (err) {
    return { ok: false, errorName: err.constructor.name };
  }
}

// Hand-authored corpus, one file per case (provenance rule CONTRIBUTING #2371).
// Files carry NO trailing newline: the EOF boundary is the behavior under test.
// expect null = every reader must throw.
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'config');
const CASES = [
  { file: 'unterminated-bare.json', expect: null },
  { file: 'unterminated-slash.json', expect: null },
  { file: 'unterminated-star.json', expect: null },
  { file: 'unterminated-word.json', expect: null },
  { file: 'minimal-closer.json', expect: { a: 1 } },
  { file: 'exact-eof-comment.json', expect: { a: 1 } },
  { file: 'star-run-closer.json', expect: { a: 1 } },
  { file: 'opener-inside-string.json', expect: { a: '/*' } },
];
const CORPUS = CASES.map(({ file, expect }) => ({
  doc: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
  expect,
}));

test('all three JSONC readers agree on the #5990 corpus', () => {
  for (const { doc, expect } of CORPUS) {
    const results = READERS.map(([name, fn]) => ({ name, ...attempt(fn, doc) }));
    const first = results[0];
    for (const r of results.slice(1)) {
      assert.deepStrictEqual(
        { ok: r.ok, errorName: r.errorName, value: r.value },
        { ok: first.ok, errorName: first.errorName, value: first.value },
        `readers diverge on ${JSON.stringify(doc)}: ${JSON.stringify(results)}`
      );
    }
    if (expect === null) {
      assert.equal(first.ok, false, `expected all readers to throw on ${doc}, ${first.name} parsed it`);
      assert.equal(first.errorName, 'SyntaxError', `expected SyntaxError on ${doc}, got ${first.errorName}`);
    } else {
      assert.equal(first.ok, true, `expected all readers to parse ${doc}, ${first.name} threw`);
      assert.deepStrictEqual(first.value, expect, `wrong value for ${doc}`);
    }
  }
});

// Deterministic per CONTRIBUTING: pinned integer seed, bounded iterations.
const SEED = 5990;
const NUM_RUNS = 200;
// Comment bodies built from spaces, stars, letters and newlines that never
// contain the two-char closing delimiter — the one-short side of the boundary.
const bodyArb = fc
  .array(fc.constantFrom(' ', '*', 'x', 'a', '\n'), { minLength: 0, maxLength: 10 })
  .map((chars) => chars.join(''))
  .filter((body) => !body.includes('*/'));

test('generated unterminated bodies throw and terminated ones parse in all three readers (#5990)', () => {
  fc.assert(
    fc.property(bodyArb, (body) => {
      const open = '{"a":1} /*' + body;
      const closed = open + '*/';
      const openResults = READERS.map(([name, fn]) => ({ name, ...attempt(fn, open) }));
      for (const r of openResults) {
        assert.equal(r.ok, false, `expected throw on ${JSON.stringify(open)}, ${r.name} parsed it`);
        assert.equal(r.errorName, 'SyntaxError', `expected SyntaxError on ${JSON.stringify(open)}, got ${r.errorName}`);
      }
      const closedResults = READERS.map(([name, fn]) => ({ name, ...attempt(fn, closed) }));
      for (const r of closedResults) {
        assert.deepStrictEqual(
          { ok: r.ok, value: r.value },
          { ok: true, value: { a: 1 } },
          `expected parse of ${JSON.stringify(closed)}, ${r.name} gave ${JSON.stringify(r)}`
        );
      }
    }),
    { seed: SEED, numRuns: NUM_RUNS }
  );
});

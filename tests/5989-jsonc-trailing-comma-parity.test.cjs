'use strict';

/**
 * 5989-jsonc-trailing-comma-parity.test.cjs — the three JSONC readers must agree.
 *
 * #5989: each reader (bin/install.js stripJsonComments, src/settings-jsonc.cts
 * parseJsonc, src/jsonc-edit.cts parseJsonc) removed trailing commas with a
 * regex that ran after comment stripping, where string interiors are
 * indistinguishable from structure — `{"a":"x,}y"}` lost the comma. A parity
 * test fails if the readers diverge on this behavior, and a generated test
 * covers strings made of comma, brace, bracket and quote sequences with
 * comments and real trailing commas around them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

// The three exported reader surfaces, at the altitude callers use them:
// readSettings does JSON.parse(stripJsonComments(raw)) after the strict fast
// path fails; the other two expose parseJsonc directly.
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

// Adversarial fixtures per CONTRIBUTING → Parser and project-file inputs:
// raw JSONC documents under tests/fixtures/adversarial/config/, loaded
// verbatim. Every document carries a comment so all three readers take the
// strip path (jsonc-edit has no strict fast path; the other two would
// short-circuit on valid strict JSON and never reach the cleanup).
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'config');
const CASES = [
  { file: 'issue-example.json', expect: { a: 'x,}y', b: 1 } },
  { file: 'comma-bracket-in-string.json', expect: { a: 'p,]q' } },
  { file: 'escaped-quote-corruptor.json', expect: { a: 'say "x,}" ok' } },
  { file: 'real-trailing-commas.json', expect: { a: 1, b: [2] } },
  { file: 'trailing-comma-before-line-comment.json', expect: { a: 1 } },
  { file: 'comma-brace-in-line-comment.json', expect: { a: 1 } },
  { file: 'array-corruptor.json', expect: { arr: ['x,]', 'y'] } },
  { file: 'double-comma-object.json', expect: null }, // null = every reader must throw
  { file: 'double-comma-array.json', expect: null },
  { file: 'eof-comma.json', expect: null },
  { file: 'comma-before-number.json', expect: [1, 2] },
];
const CORPUS = CASES.map(({ file, expect }) => ({
  doc: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
  expect,
}));

test('all three JSONC readers agree on the #5989 corpus', () => {
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
    } else {
      assert.equal(first.ok, true, `expected all readers to parse ${doc}, ${first.name} threw`);
      assert.deepStrictEqual(first.value, expect, `wrong value for ${doc}`);
    }
  }
});

test('the strict-JSON fast path of the shared parser is unchanged (#5989)', () => {
  // Valid strict JSON with a corruptor string: JSON.parse handles it directly;
  // the fix must not touch this path.
  assert.deepStrictEqual(parseSharedJsonc('{"a":"x,}y","b":1}'), { a: 'x,}y', b: 1 });
});

// Deterministic per CONTRIBUTING: pinned seed, bounded iterations; fast-check
// prints the failing input plus a replay command.
const SEED = 5989;
const NUM_RUNS = 200;
const valueArb = fc
  .array(fc.constantFrom(',', '}', ']', '"', '\\', 'a', ' '), { minLength: 0, maxLength: 12 })
  .map((chars) => chars.join(''));

// A document with a comment and real trailing commas in both the object and
// the array, wrapping a generated string value.
function docFor(value) {
  return '{"a":' + JSON.stringify(value) + ',"b":[1,], /*tail*/}';
}

test('generated comma/brace/bracket/quote strings survive all three readers (#5989)', () => {
  fc.assert(
    fc.property(valueArb, (value) => {
      const doc = docFor(value);
      const expected = { a: value, b: [1] };
      const results = READERS.map(([name, fn]) => ({ name, ...attempt(fn, doc) }));
      for (const r of results) {
        assert.deepStrictEqual(
          { ok: r.ok, errorName: r.errorName, value: r.value },
          { ok: results[0].ok, errorName: results[0].errorName, value: results[0].value },
          `readers diverge on ${doc}`
        );
      }
      assert.deepStrictEqual(
        { ok: results[0].ok, value: results[0].value },
        { ok: true, value: expected },
        `value corrupted: ${doc}`
      );
    }),
    { seed: SEED, numRuns: NUM_RUNS }
  );
});

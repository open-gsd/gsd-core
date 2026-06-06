// allow-test-rule: source-text-is-the-product
// review.md is a workflow file whose deployed text IS the runtime contract; the
// agy -p invocation cannot be run in CI, so we assert on its content (issue #687).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reviewPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const read = () => fs.readFileSync(reviewPath, 'utf-8');

describe('bug #687: agy print mode must be bounded via its native --print-timeout', () => {
  test('invokes agy with its own --print-timeout flag (not an external killer)', () => {
    assert.match(read(), /agy --print-timeout \d+s? -p "\$\(cat/,
      'review.md must cap agy through `agy --print-timeout <N> -p …` (the tool\'s own mechanism)');
  });

  test('discards partial output on non-zero exit so the fallback fires', () => {
    const c = read();
    assert.match(c, /_AGY_RC.*-ne 0/, 'review.md must check the agy exit code');
    assert.match(c, /: > \/tmp\/gsd-review-antigravity-/,
      'review.md must truncate the output file when agy timed out / failed');
  });

  test('agy is bounded only by its own --print-timeout, not an external process killer', () => {
    const c = read();
    // Print-mode reviewers invoke the tool directly; agy must self-terminate via
    // --print-timeout, never via an external SIGKILL/timeout binary wrapped around it.
    assert.doesNotMatch(c, /-s KILL/, 'must not SIGKILL agy from the outside');
    // Any external timeout binary wrapping agy — `timeout 300s agy …`,
    // `gtimeout 300 agy …`, `timeout -s KILL 300 agy …`. The lookbehind keeps
    // agy's own `--print-timeout` flag from tripping it.
    assert.doesNotMatch(c, /(?<!print-)\bg?timeout[ \t]+[^\n]*\bagy\b/,
      'must not wrap agy in an external timeout binary — use its --print-timeout flag');
    assert.doesNotMatch(c, /kill -9 "\$_AGY/, 'must not use a kill -9 watchdog on agy');
  });

  test('no unguarded bare "agy -p" invocation remains at line start', () => {
    // A bare `agy -p "$(cat …)"` with no cap was the original hang.
    assert.doesNotMatch(read(), /^agy -p "\$\(cat/m,
      'review.md must not invoke agy -p without --print-timeout');
  });
});

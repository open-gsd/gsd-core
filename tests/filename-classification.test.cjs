'use strict';

/**
 * filename-classification.test.cjs
 *
 * Unit tests for hooks/lib/filename-classification.js. Exports one pure,
 * inert helper used to classify `.env.<suffix>` basenames by their FINAL
 * extension only:
 *
 *   finalExtension(name) -> segment after the LAST dot; the whole string
 *                           when there is no dot; '' for empty/non-string.
 *
 * #4580 was caused by comparing the whole tail after the first dot (e.g.
 * `local.example`) against a set of final extensions (e.g. `example`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { finalExtension, normalizeWindowsBasename } = require('../hooks/lib/filename-classification.js');

test('finalExtension: a dotless string is its own final extension', () => {
  assert.equal(finalExtension('example'), 'example');
});

test('finalExtension: single dot returns the segment after it', () => {
  assert.equal(finalExtension('local.example'), 'example');
});

test('finalExtension: multi-segment returns only the LAST segment', () => {
  assert.equal(finalExtension('a.b.c.d'), 'd');
});

test('finalExtension: empty string returns empty string', () => {
  assert.equal(finalExtension(''), '');
});

test('finalExtension: a trailing dot yields an empty final extension', () => {
  assert.equal(finalExtension('example.'), '');
});

test('finalExtension: a leading dot yields the segment after it', () => {
  assert.equal(finalExtension('.example'), 'example');
});

test('finalExtension: non-string / nullish inputs are inert, never throw', () => {
  assert.equal(finalExtension(null), '');
  assert.equal(finalExtension(undefined), '');
  assert.equal(finalExtension(42), '');
});

test('finalExtension returns the last segment, not the whole multi-dot suffix (#4580)', () => {
  // #4580: the guard compared `local.example` (everything after the first
  // dot) against a set of final extensions like `example`, so a correct
  // implementation must return the last segment, not the whole token.
  assert.equal(finalExtension('local.example'), 'example');
  assert.notEqual(finalExtension('local.example'), 'local.example');
});

test('fc: finalExtension never contains a dot, is always a suffix of the input, and preserves content', () => {
  fc.assert(
    fc.property(
      fc.string(),
      (s) => {
        const ext = finalExtension(s);
        assert.equal(ext.includes('.'), false);
        assert.equal(s.endsWith(ext), true);
        const i = s.lastIndexOf('.');
        const expected = i === -1 ? s : s.slice(i + 1);
        assert.equal(ext, expected);
      },
    ),
    { seed: 42, numRuns: 200 },
  );
});

test('normalizeWindowsBasename: strips a single trailing dot', () => {
  assert.equal(normalizeWindowsBasename('.env.'), '.env');
});

test('normalizeWindowsBasename: strips repeated trailing dots', () => {
  assert.equal(normalizeWindowsBasename('.env..'), '.env');
});

test('normalizeWindowsBasename: strips a trailing space', () => {
  assert.equal(normalizeWindowsBasename('.env '), '.env');
});

test('normalizeWindowsBasename: strips a trailing dot-then-space', () => {
  assert.equal(normalizeWindowsBasename('.env. '), '.env');
});

test('normalizeWindowsBasename: strips a trailing space-then-dot', () => {
  assert.equal(normalizeWindowsBasename('.env .'), '.env');
});

test('normalizeWindowsBasename: strips a trailing dot off .secrets', () => {
  assert.equal(normalizeWindowsBasename('.secrets.'), '.secrets');
});

test('normalizeWindowsBasename: strips only the trailing dot, not interior dots', () => {
  assert.equal(normalizeWindowsBasename('.env.local.'), '.env.local');
});

test('normalizeWindowsBasename: all dots strips to empty string', () => {
  assert.equal(normalizeWindowsBasename('...'), '');
});

test('normalizeWindowsBasename: a name with no trailing dot/space is unchanged', () => {
  assert.equal(normalizeWindowsBasename('.env'), '.env');
});

test('normalizeWindowsBasename: .envrc is unchanged', () => {
  assert.equal(normalizeWindowsBasename('.envrc'), '.envrc');
});

test('normalizeWindowsBasename: empty string returns empty string', () => {
  assert.equal(normalizeWindowsBasename(''), '');
});

test('normalizeWindowsBasename: non-string / nullish inputs are inert, never throw', () => {
  assert.equal(normalizeWindowsBasename(null), '');
  assert.equal(normalizeWindowsBasename(undefined), '');
  assert.equal(normalizeWindowsBasename(42), '');
});

test('fc: normalizeWindowsBasename never ends with a dot or space, is always a prefix of the input, and only removes trailing dot/space characters', () => {
  fc.assert(
    fc.property(
      fc.string(),
      (s) => {
        const n = normalizeWindowsBasename(s);
        assert.equal(n.endsWith('.'), false);
        assert.equal(n.endsWith(' '), false);
        assert.equal(s.startsWith(n), true);
        const removed = s.slice(n.length);
        assert.match(removed, /^[. ]*$/);
        if (!/[. ]$/.test(s)) assert.equal(n, s);
      },
    ),
    { seed: 42, numRuns: 200 },
  );
});

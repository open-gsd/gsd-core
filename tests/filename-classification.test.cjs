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
const { spawnSync } = require('node:child_process');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { finalExtension, normalizeWindowsBasename, lastSegment } = require('../hooks/lib/filename-classification.js');

test('lastSegment: the text after the last / or \\, trailing separators ignored', () => {
  assert.equal(lastSegment('a/b/c'), 'c');
  assert.equal(lastSegment('a\\b'), 'b');
  assert.equal(lastSegment('a/b//'), 'b');
  assert.equal(lastSegment('a\\b/\\'), 'b');
  assert.equal(lastSegment('abc'), 'abc');
  assert.equal(lastSegment('///'), '');
  assert.equal(lastSegment(''), '');
});

// The Bash guard calls lastSegment on every command word, and an env -S split can
// make a long run of separators one word. The regex form of the strip was quadratic
// in such a run (minutes at this size). Run in a child so a regression fails at the
// timeout rather than hanging the file.
test('lastSegment: a 1,000,000-separator run inside a word, in linear time', () => {
  const lib = require.resolve('../hooks/lib/filename-classification.js');
  const script = `const { lastSegment } = require(${JSON.stringify(lib)});
    process.stdout.write(lastSegment('foo' + '/'.repeat(1000000) + 'x') + '|' + lastSegment('foo' + '\\\\/'.repeat(500000)));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: QUICK_SPAWN_TIMEOUT_MS });
  assert.equal(r.signal, null, 'lastSegment did not finish within the timeout');
  assert.equal(r.stdout, 'x|foo');
});

test('fc: lastSegment matches the regex strip it replaced', () => {
  const reference = (tok) => {
    const s = tok.replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i === -1 ? s : s.slice(i + 1);
  };
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('/', '\\', 'a', '.', ' ', 'é'), { maxLength: 16 }).map((a) => a.join('')),
      (s) => assert.equal(lastSegment(s), reference(s)),
    ),
    { seed: 42, numRuns: 500 },
  );
});

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

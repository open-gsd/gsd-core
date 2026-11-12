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
// make a long run of separators one word. The regex form of the strip,
// `/[\\/]+$/`, retried from each position of a run that does not end the word, so
// it was quadratic in the run (minutes at 1,000,000). Pinned by a step count, not
// a clock. The word is a proxy that answers every String method: each
// single-character read (`word[i]`, `charAt`, `charCodeAt`, `codePointAt`, `at`)
// counts, and the first read past twice the word's length throws, so a quadratic
// strip fails at once; a call that takes a regex over the word (`replace`,
// `replaceAll`, `match`, `matchAll`, `search`, or `split` by a RegExp) throws
// too, because no read count can see a backtracking regex. So does converting
// the word to a string or iterating it (`String(word)`, a template literal,
// `RE.exec(word)`, `[...word]`): past a conversion nothing is counted. A method
// that copies the whole word out (`word.slice(0)`) still escapes the count.
function countedWord(word) {
  const bound = 2 * word.length;
  let reads = 0;
  const read = () => {
    if (++reads > bound) throw new Error(`more than ${bound} character reads for a ${word.length}-character word`);
  };
  const regexMethods = new Set(['replace', 'replaceAll', 'match', 'matchAll', 'search']);
  const charMethods = new Set(['charAt', 'charCodeAt', 'codePointAt', 'at']);
  const conversions = new Set([Symbol.toPrimitive, Symbol.iterator, 'toString', 'valueOf', 'toLocaleString']);
  return new Proxy(Object.create(null), {
    get(_, key) {
      if (key === 'length') return word.length;
      if (conversions.has(key)) {
        return () => { throw new Error(`the word was converted or iterated (${String(key)}), past what this test counts`); };
      }
      if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
        read();
        return word[key];
      }
      if (charMethods.has(key)) return (i) => { read(); return word[key](i); };
      if (regexMethods.has(key)) return () => { throw new Error(`String.prototype.${key} ran a regex over the word`); };
      if (key === 'split') {
        return (sep, limit) => {
          if (sep instanceof RegExp) throw new Error('String.prototype.split ran a regex over the word');
          return word.split(sep, limit);
        };
      }
      const value = word[key];
      return typeof value === 'function' ? value.bind(word) : value;
    },
  });
}

test('lastSegment: reads each character of a long separator run at most twice, with no regex', () => {
  const cases = [
    ['foo' + '/'.repeat(100000) + 'x', 'x'],
    ['foo' + '\\/'.repeat(50000), 'foo'],
    ['x' + '/'.repeat(100000), 'x'],
  ];
  for (const [word, expected] of cases) {
    assert.equal(String(lastSegment(countedWord(word))), expected);
  }
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

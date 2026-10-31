'use strict';

// #4039: `shellSingleQuote` is the ONE POSIX single-quote implementation, owned by the
// shell-command projection seam. capability-lifecycle used to carry a private copy (#1460);
// these tests pin the shared export's behavior so the removed copy's output is preserved
// byte-for-byte.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const projection = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const { shellSingleQuote, escapeSingleQuotedShellLiteral } = projection;

// The exact expression of the private helper #4039 removed from capability-lifecycle.cts.
function referenceQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Decode ONE POSIX shell word made only of single-quoted runs and backslash-escaped
// single quotes (the only forms shellSingleQuote emits). Returns null when the word is
// anything else, so a malformed token fails the round-trip instead of decoding loosely.
function decodePosixSingleQuotedWord(word) {
  let out = '';
  let i = 0;
  while (i < word.length) {
    if (word[i] === "'") {
      const close = word.indexOf("'", i + 1);
      if (close === -1) return null;
      out += word.slice(i + 1, close);
      i = close + 1;
    } else if (word[i] === '\\' && word[i + 1] === "'") {
      out += "'";
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}

describe('shellSingleQuote (#4039)', () => {
  test('is exported by the shell-command projection module', () => {
    assert.equal(typeof shellSingleQuote, 'function');
  });

  test('empty string becomes an empty quoted token', () => {
    assert.equal(shellSingleQuote(''), "''");
  });

  test('plain path is wrapped in single quotes', () => {
    assert.equal(shellSingleQuote('/a/b'), "'/a/b'");
  });

  test('a path with a space stays one token (#1460 install-prefix shape)', () => {
    assert.equal(shellSingleQuote('/Users/Bob Smith/.claude/x.js'), "'/Users/Bob Smith/.claude/x.js'");
  });

  test('embedded quote count boundaries: 0, 1, 2', () => {
    assert.equal(shellSingleQuote('ab'), "'ab'");
    assert.equal(shellSingleQuote("a'b"), "'a'\\''b'");
    assert.equal(shellSingleQuote("a''b"), "'a'\\'''\\''b'");
  });

  test('leading and trailing quotes are escaped', () => {
    assert.equal(shellSingleQuote("'x'"), "''\\''x'\\'''");
  });

  test('shell metacharacters, newline and tab pass through verbatim inside the quotes', () => {
    const hostile = '$(rm -rf ~); `id` "x" \\ & | * ? < > # ! \n\t';
    assert.equal(shellSingleQuote(hostile), "'" + hostile + "'");
  });

  test('inner escape stays unwrapped (its callers supply their own quotes)', () => {
    assert.equal(escapeSingleQuotedShellLiteral("a'b"), "a'\\''b");
  });

  test('property: output is byte-identical to the removed capability-lifecycle helper', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        assert.equal(shellSingleQuote(s), referenceQuote(s));
      }),
      { seed: 4039, numRuns: 500 },
    );
  });

  test('property: output is one POSIX word that decodes back to the input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const quoted = shellSingleQuote(s);
        assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
        assert.equal(decodePosixSingleQuotedWord(quoted), s);
      }),
      { seed: 4039, numRuns: 500 },
    );
  });
});

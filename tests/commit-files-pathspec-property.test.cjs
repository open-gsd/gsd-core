'use strict';
// #5211: property tests for the commit guard's spellings (`bash -<cluster>c` payloads, unquoted $-word pathspecs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { unscopedGitCommits } = require('./helpers/shipped-command-scan.cjs');

const word = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/);
const varName = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,7}$/);
const cluster = fc.stringMatching(/^[a-z]{0,3}$/).map((s) => `-${s}c`);
const shell = fc.constantFrom('bash', 'sh', 'zsh');

test('property: a bash -<cluster>c payload is scanned like the bare command', () => {
  fc.assert(fc.property(shell, cluster, word, fc.array(word, { minLength: 0, maxLength: 3 }), (sh, flag, m, paths) => {
    const cmd = `git commit -m ${m}${paths.length ? ` -- ${paths.join(' ')}` : ''}`;
    assert.equal(unscopedGitCommits(`${sh} ${flag} '${cmd}'`).length, paths.length === 0 ? 1 : 0);
  }), { seed: 5211, numRuns: 100 });
});

test('property: a pathspec made only of unquoted $-words is flagged; quoted $-words and a literal path are not', () => {
  fc.assert(fc.property(word, fc.array(varName, { minLength: 1, maxLength: 3 }), (m, vars) => {
    assert.equal(unscopedGitCommits(`git commit -m ${m} -- ${vars.map((v) => `$${v}`).join(' ')}`).length, 1);
    assert.equal(unscopedGitCommits(`git commit -m ${m} -- ${vars.map((v) => `"$${v}"`).join(' ')}`).length, 0);
    assert.equal(unscopedGitCommits(`git commit -m ${m} -- ${vars.map((v) => `$${v}`).join(' ')} ${m}`).length, 0);
  }), { seed: 5211, numRuns: 100 });
});

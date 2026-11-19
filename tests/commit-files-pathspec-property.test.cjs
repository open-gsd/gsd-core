'use strict';
// #5211: property tests for the commit guard's spellings (`bash -<cluster>c` payloads, unquoted $-word pathspecs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { unscopedGitCommits, isDeclared } = require('./helpers/shipped-command-scan.cjs');

// A `# gsd-scan-ignore: #5211` marker on a shipped command line declares that unscoped commit deliberate. Each file this PR marks keeps its markers, and the scan reports no commit on a marked line.
const MARKED = [
  'agents/gsd-executor.md',
  'gsd-core/references/planning-config.md',
  'gsd-core/workflows/complete-milestone/detail/elaboration.md',
  'gsd-core/workflows/execute-phase.md',
  'gsd-core/workflows/fast.md',
  'gsd-core/workflows/pr-branch.md',
  'gsd-core/workflows/ship.md',
  'gsd-core/workflows/undo.md',
  'pi/package-agents/gsd-executor.md',
];

test('shipped #5211 declarations: each marked file keeps its markers and no marked line is flagged', () => {
  for (const f of MARKED) {
    // The scanner's own predicate decides what a declaration is, so this test holds no second copy of the marker grammar.
    const lines = splitLines(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).filter(isDeclared);
    assert.ok(lines.length > 0, `${f} declares no marker`);
    for (const l of lines) assert.deepEqual(unscopedGitCommits(l), [], `${f}: marked line still flagged: ${l}`);
  }
});

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

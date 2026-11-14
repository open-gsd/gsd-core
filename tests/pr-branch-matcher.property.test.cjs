'use strict';

/**
 * #5469: property tests for the rewritten-history matcher of `/gsd-pr-branch` — the shipped
 * awk program that reads the L, R, D, F, P and N sections and prints `OK <base>` or `WARN` —
 * and for `picked`, the one owner of the pick rule that both the pick list and the matcher use.
 *
 * The shell text is extracted from `gsd-core/workflows/pr-branch.md`, so the tests run the
 * shipped code. The matcher input is built in the shape `git rev-list`, `git log --name-only
 * --format=%x09%H` and `git patch-id --stable` print.
 *
 * Properties:
 *   (a) a linear rebase of published, unpublished, planning-only and unpicked commits: the
 *       base is the last commit of the leading published-or-unpicked run, or WARN when a
 *       published copy sits above an unpublished commit;
 *   (b) file names that spell the section markers or a `commit <sha>` line never change
 *       the verdict;
 *   (c) a picked commit that has no patch-id (a failed or empty patch walk) always gives WARN;
 *   (d) `picked`, the per-commit count of analyze_commits, and `classifyCommit`
 *       agree on any file list, in both modes.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { readWorkflowText, extractBashBlockContaining, extractDeclarationLines, PRECONDITIONS_MARKER, runBashFile, classifyCommit, readWorkflow } = require('./helpers/pr-branch-filter.cjs');

// Reads of the workflow are lazy, so a moved marker fails the named test that needs it, not the file load.
const lazy = (f) => { let v; return () => (v === undefined ? (v = f()) : v); };
const workflowText = lazy(readWorkflowText);
const awkProgram = lazy(() => {
  const block = extractBashBlockContaining(workflowText(), 'REWRITE=$(printf');
  const m = block.slice(block.indexOf('REWRITE=$(printf')).match(/awk '([^']*)'/);
  assert.ok(m, 'matcher awk program not found in pr-branch.md');
  return m[1];
});

// The one bash runner: `files` (name -> content) and `script` go into a fresh dir, bash runs the script there
// under the isolated env and must exit 0; returns the trimmed stdout.
function runBash(prefix, files, script) {
  const r = runBashFile(script, { prefix, files, env: (home) => isolatedEnv({ home }) });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout.trim();
}

// Runs the shipped awk over `input` through bash, as the workflow does (input and program via files).
const match = (input) => runBash('gsd-prmatcher-', { 'in.txt': input, 'prog.awk': awkProgram() }, 'awk -f prog.awk < in.txt');

const hex = (prefix, i) => `${prefix}${i.toString(16).padStart(39, '0')}`;
// Names that spelled the old section markers, plus ordinary ones.
const NAMES = ['P', 'D', 'F', 'L', 'R', `commit ${'a'.repeat(40)}`, 'src/a.txt', 'b.txt'];

// One rebased history: left = the published commits, right = the rebased branch, oldest first.
// kind: 'pub' (copy of left[ref]), 'unpub' (new patch), 'empty' (only filtered paths: no files, no patch-id; not picked),
// 'unpicked' (kept files and a new patch, but the pick list skips it, e.g. .planning/config.json in default mode).
const NOT_PICKED = new Set(['empty', 'unpicked']);
function render({ left, right, dropPid = -1 }) {
  const lines = { L: [], R: [], F: [], P: [], N: [] };
  left.forEach((c) => {
    lines.L.push(c.sha);
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    lines.P.push(`${c.pid} ${c.sha}`);
  });
  right.forEach((c, i) => {
    lines.R.unshift(c.sha); // rev-list prints newest first
    if (NOT_PICKED.has(c.kind)) lines.N.push(c.sha);
    if (c.kind === 'empty') return;
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    if (i !== dropPid) lines.P.push(`${c.pid} ${c.sha}`);
  });
  const sec = (k, arr) => `\t${k}\n${arr.join('\n')}\n`;
  return ['L', 'R'].map((k) => sec(k, lines[k])).join('') + sec('D', []) + ['F', 'P', 'N'].map((k) => sec(k, lines[k])).join('');
}

const history = fc.record({
  nLeft: fc.integer({ min: 1, max: 4 }),
  right: fc.array(fc.record({
    kind: fc.constantFrom('pub', 'unpub', 'empty', 'unpicked'),
    ref: fc.nat(),
    files: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }),
  }), { maxLength: 6 }),
  leftFiles: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }),
}).map(({ nLeft, right, leftFiles }) => {
  const left = Array.from({ length: nLeft }, (_, i) => ({ sha: hex('a', i), pid: hex('f', i), files: leftFiles }));
  return {
    left,
    right: right.map((c, i) => ({
      ...c,
      sha: hex('b', i),
      pid: c.kind === 'pub' ? left[c.ref % nLeft].pid : hex('e', i),
    })),
  };
});

// The model: the leading run of published or unpicked commits gives the base; a published copy after an unpublished commit warns.
function expected({ right }) {
  let tip = '-';
  let stopped = false;
  for (const c of right) {
    if (!stopped && c.kind !== 'unpub') { tip = c.sha; continue; }
    stopped = true;
    if (c.kind === 'pub') return 'WARN';
  }
  return `OK ${tip}`;
}

describe('pr-branch rewritten-history matcher (property)', () => {
  test('the base ends the leading published-or-unpicked run; a published copy above an unpublished commit warns', () => {
    fc.assert(fc.property(history, (h) => {
      assert.equal(match(render(h)), expected(h));
    }), { numRuns: 40 });
  });

  test('a picked commit with no patch-id always warns (fail closed)', () => {
    const withFiles = history.filter((h) => h.right.some((c) => !NOT_PICKED.has(c.kind)));
    fc.assert(fc.property(withFiles, fc.nat(), (h, n) => {
      const idx = h.right.map((c, i) => (NOT_PICKED.has(c.kind) ? -1 : i)).filter((i) => i >= 0);
      assert.equal(match(render({ ...h, dropPid: idx[n % idx.length] })), 'WARN');
    }), { numRuns: 30 });
  });

  test('a marker-side range with no non-merge commit warns', () => {
    assert.equal(match('\tL\n\n\tR\n\n\tD\n\n\tF\n\n\tP\n\n'), 'WARN');
  });
});

// The shipped `picked` function, with `_to` standing in for the bounded `git diff-tree` read.
const pickedFn = lazy(() => extractDeclarationLines(workflowText(), PRECONDITIONS_MARKER, ['picked() {'])[0]);
// The shipped per-commit counts of analyze_commits, with `git` standing in for `git diff-tree`.
const countsBlock = lazy(() => extractBashBlockContaining(workflowText(), 'NON_PLANNING=$('));
// One bash run per mode: for each file list, picked's verdict (1 pick, 0 skip) and the three shipped counts the arms read,
// then picked's verdict on a failed lookup.
function verdicts(lists, strict) {
  const { structuralRe } = readWorkflow();
  // NUL-terminated, as `git -z --name-only` prints: the shipped `| tr '\0' '\n'` must split it.
  const files = Object.fromEntries(lists.map((l, i) => [`${i}.txt`, l.map((p) => `${p}\0`).join('')]));
  return runBash('gsd-prpicked-', files, [
    `PR_STRICT=${strict}`,
    `STRUCTURAL_RE='${structuralRe}'`,
    pickedFn(),
    `for i in $(seq 0 ${lists.length - 1}); do`,
    // A read without -z prints each name quoted, as git does for a non-ASCII path, so dropping -z from a shipped read fails.
    `  fake() { case " $* " in *" -z "*) cat "$i.txt" ;; *) tr '\\0' '\\n' < "$i.txt" | sed 's/.*/"&"/' ;; esac; }; _to() { fake "$@"; }; git() { fake "$@"; }; HASH=x`,
    '  P=$(picked x && echo 1 || echo 0)',
    countsBlock(),
    '  echo "$P $NON_PLANNING $STRUCTURAL $PLANNING_COUNT"',
    'done',
    '_to() { return 124; }; picked x && echo 1 || echo 0', // a failed lookup picks the commit
  ].join('\n')).split(/\r?\n/);
}

const PATHS = ['-n', 'src/a.js', 'src/é.js', 'README.md', '.planningX/a', '.planning/STATE.md', '.planning/STATEX.md', '.planning/ROADMAP.md',
  '.planning/config.json', '.planning/notes-é.md', '.planning/intel/x.md', '.planning/phases/01/PLAN.md', '.planning/milestones/v1-ROADMAP.md',
  '.planning/milestones/v1-phases/p.md', '.planning/workstreams/w.md'];

describe('pr-branch pick rule (property)', () => {
  test('a lone code path named like an echo option is picked and counted', () => {
    assert.deepEqual(verdicts([['-n'], ['-e'], ['-E']], false), ['1 1 0 0', '1 1 0 0', '1 1 0 0', '1']); // picked, and counted as one non-planning path
  });

  for (const strict of [true, false]) {
    test(`picked agrees with the classification and the shipped count sees the code paths in ${strict ? 'strict' : 'default'} mode; a failed lookup picks`, () => {
      const { structuralRe, transientDirs } = readWorkflow();
      fc.assert(fc.property(fc.array(fc.uniqueArray(fc.constantFrom(...PATHS), { maxLength: 4 }), { minLength: 1, maxLength: 8 }), (lists) => {
        const structural = new RegExp(structuralRe);
        const want = lists.map((l) => `${classifyCommit(l, { strict, structuralRe, transientDirs }) === 'include' ? 1 : 0} ${l.filter((p) => !p.startsWith('.planning/')).length} ${l.filter((p) => structural.test(p)).length} ${l.filter((p) => p.startsWith('.planning/')).length}`);
        assert.deepEqual(verdicts(lists, strict), [...want, '1']);
      }), { numRuns: 15 });
    });
  }
});

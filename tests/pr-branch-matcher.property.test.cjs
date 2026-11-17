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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
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
// A left commit is 'pick' (default), 'unpicked' or 'nopid' (picked, no patch-id); `inD` puts its own file in D,
// the paths the marker tip and the target differ in (its content is not proven merged).
const NOT_PICKED = new Set(['empty', 'unpicked']);
function render({ left, right, dropPid = -1 }) {
  const lines = { L: [], R: [], F: [], P: [], N: [], D: [] };
  left.forEach((c) => {
    lines.L.push(c.sha);
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    if (c.kind !== 'nopid') lines.P.push(`${c.pid} ${c.sha}`);
    if (c.kind === 'unpicked') lines.N.push(c.sha);
    if (c.inD) lines.D.push(c.files[0]);
  });
  right.forEach((c, i) => {
    lines.R.unshift(c.sha); // rev-list prints newest first
    if (NOT_PICKED.has(c.kind)) lines.N.push(c.sha);
    if (c.kind === 'empty') return;
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    if (i !== dropPid) lines.P.push(`${c.pid} ${c.sha}`);
  });
  const sec = (k, arr) => `\t${k}\n${arr.join('\n')}\n`;
  return ['L', 'R', 'D', 'F', 'P', 'N'].map((k) => sec(k, lines[k])).join('');
}

// Left patch ids come from a pool of two, so one patch is published more than once; 'pub' copies pick a published patch.
const history = fc.record({
  left: fc.array(fc.record({
    kind: fc.constantFrom('pick', 'pick', 'unpicked', 'nopid'),
    pidIx: fc.nat(1),
    inD: fc.boolean(),
  }), { minLength: 1, maxLength: 4 }),
  right: fc.array(fc.record({
    kind: fc.constantFrom('pub', 'unpub', 'empty', 'unpicked'),
    ref: fc.nat(),
    files: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }),
  }), { maxLength: 6 }),
  leftFiles: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }),
}).map(({ left, right, leftFiles }) => {
  const published = left.map((c, i) => ({ ...c, sha: hex('a', i), pid: hex('f', c.pidIx), files: [`l${i}.txt`, ...leftFiles] }));
  const withPid = published.filter((c) => c.kind !== 'nopid');
  return {
    left: published,
    right: right.map((c, i) => ({
      ...c,
      sha: hex('b', i),
      // A 'pub' copy needs a published patch to copy; with none it is a new patch.
      kind: c.kind === 'pub' && !withPid.length ? 'unpub' : c.kind,
      pid: c.kind === 'pub' && withPid.length ? withPid[c.ref % withPid.length].pid : hex('e', i),
    })),
  };
});

// The model, from the rules in the workflow text. A left commit that was picked and is not matched on the right warns
// when its content is not proven merged (a file in D), or at once when it has no patch-id. The base is the last commit
// of the leading run of unpicked commits and published copies; each published patch matches one copy per time it was
// published; a published copy after an unpublished commit warns.
function expected({ left, right }) {
  const rightPids = new Set(right.filter((c) => c.kind !== 'empty').map((c) => c.pid));
  for (const c of left) {
    if (c.kind === 'unpicked') continue;
    if (c.kind === 'nopid' || (!rightPids.has(c.pid) && c.inD)) return 'WARN';
  }
  const leftN = new Map();
  for (const c of left) if (c.kind !== 'nopid') leftN.set(c.pid, (leftN.get(c.pid) ?? 0) + 1);
  let tip = '-';
  let stopped = false;
  for (const c of right) {
    const np = NOT_PICKED.has(c.kind);
    const free = (leftN.get(c.pid) ?? 0) > 0;
    if (!stopped && (np || free)) {
      if (!np) leftN.set(c.pid, leftN.get(c.pid) - 1);
      tip = c.sha;
      continue;
    }
    stopped = true;
    if (free) return 'WARN';
  }
  return `OK ${tip}`;
}

describe('pr-branch rewritten-history matcher (property)', () => {
  test('the base ends the leading published-or-unpicked run; a published copy above an unpublished commit warns', () => {
    fc.assert(fc.property(history, (h) => {
      assert.equal(match(render(h)), expected(h));
    }), { numRuns: 100 });
  });

  test('a picked commit with no patch-id always warns (fail closed)', () => {
    const withFiles = history.filter((h) => h.right.some((c) => !NOT_PICKED.has(c.kind)));
    fc.assert(fc.property(withFiles, fc.nat(), (h, n) => {
      const idx = h.right.map((c, i) => (NOT_PICKED.has(c.kind) ? -1 : i)).filter((i) => i >= 0);
      assert.equal(match(render({ ...h, dropPid: idx[n % idx.length] })), 'WARN');
    }), { numRuns: 30 });
  });

  // Round 1 published A (adds a line) and B (removes it); round 2's C adds the line again, so C has A's patch id.
  // After a rebase the right side is A', B', C': the published patch A matches once, so C' is unpublished.
  test('a patch published once matches one rebased copy: a repeat of it stays unpublished', () => {
    const f = ['x.txt'];
    const left = [{ sha: hex('a', 0), pid: hex('f', 0), files: f }, { sha: hex('a', 1), pid: hex('f', 1), files: f }];
    const right = [['pub', hex('f', 0)], ['pub', hex('f', 1)], ['unpub', hex('f', 0)]].map(([kind, pid], i) => ({ kind, pid, sha: hex('b', i), files: f }));
    assert.equal(match(render({ left, right })), `OK ${hex('b', 1)}`);
  });

  // A patch published n times and present n-1, n and n+1 times on the right.
  for (const [times, base] of [[1, 0], [2, 1], [3, 1]]) {
    test(`a patch published twice and present ${times} time(s) on the right: the base is copy ${base}`, () => {
      const left = [0, 1].map((i) => ({ sha: hex('a', i), pid: hex('f', 0), files: ['x.txt'] }));
      const right = Array.from({ length: times }, (_, i) => ({ kind: 'pub', pid: hex('f', 0), sha: hex('b', i), files: ['x.txt'] }));
      assert.equal(match(render({ left, right })), `OK ${hex('b', base)}`);
    });
  }

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
  return splitLines(runBash('gsd-prpicked-', files, [
    `PR_STRICT=${strict}`,
    `STRUCTURAL_RE='${structuralRe}'`,
    // BSD tr stops on a byte its locale rejects (a non-UTF-8 path under a UTF-8 locale); GNU tr never does, so stand in for it:
    // the shipped path split must run under LC_ALL=C or this `tr` fails and picked picks the commit.
    `tr() { [ "\${LC_ALL:-}" = C ] || { echo 'tr: Illegal byte sequence' >&2; return 1; }; command tr "$@"; }`,
    pickedFn(),
    `for i in $(seq 0 ${lists.length - 1}); do`,
    // A read without -z prints each name quoted, as git does for a non-ASCII path, so dropping -z from a shipped read fails.
    `  fake() { case " $* " in *" -z "*) cat "$i.txt" ;; *) command tr '\\0' '\\n' < "$i.txt" | sed 's/.*/"&"/' ;; esac; }; _to() { fake "$@"; }; git() { fake "$@"; }; HASH=x`,
    '  P=$(picked x && echo 1 || echo 0)',
    countsBlock(),
    '  echo "$P $NON_PLANNING $STRUCTURAL $PLANNING_COUNT"',
    'done',
    '_to() { return 124; }; picked x && echo 1 || echo 0', // a failed lookup picks the commit
  ].join('\n')));
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

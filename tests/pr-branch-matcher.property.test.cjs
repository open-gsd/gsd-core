'use strict';

/**
 * #5469 / #5486 review 2026-11-08 (Minor 12, Minor 13, Major 1): property tests for the
 * rewritten-history matcher of `/gsd-pr-branch` — the shipped awk program that reads the
 * L, R, D, F and P sections and prints `OK <base>` or `WARN`.
 *
 * The awk text is extracted from `gsd-core/workflows/pr-branch.md`, so the test runs the
 * shipped matcher. Its input is built in the shape `git rev-list`, `git log --name-only
 * --format=%x09%H` and `git patch-id --stable` print.
 *
 * Properties:
 *   (a) a linear rebase of published, unpublished and planning-only commits: the base is
 *       the last commit of the leading published-or-empty run, or WARN when a published
 *       copy sits above an unpublished commit;
 *   (b) file names that spell the section markers or a `commit <sha>` line never change
 *       the verdict;
 *   (c) a commit that lists kept files but has no patch-id (a failed or empty patch walk)
 *       always gives WARN.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { WORKFLOW_PATH, extractBashBlockContaining } = require('./helpers/pr-branch-filter.cjs');

const AWK = (() => {
  const block = extractBashBlockContaining(fs.readFileSync(WORKFLOW_PATH, 'utf-8'), 'REWRITE=$(printf');
  const m = block.slice(block.indexOf('REWRITE=$(printf')).match(/awk '([^']*)'/);
  assert.ok(m, 'matcher awk program not found in pr-branch.md');
  return m[1];
})();

// Runs the shipped awk over `input` through bash, as the workflow does (input and program via files).
function match(input) {
  const tmp = createTempDir('gsd-prmatcher-');
  try {
    fs.writeFileSync(path.join(tmp, 'in.txt'), input);
    fs.writeFileSync(path.join(tmp, 'prog.awk'), AWK);
    fs.writeFileSync(path.join(tmp, 'run.sh'), 'awk -f prog.awk < in.txt\n');
    const r = runHook(path.join(tmp, 'run.sh'), [], { interpreter: 'bash', cwd: tmp });
    assert.equal(r.exitCode, 0, r.stderr);
    return r.stdout.trim();
  } finally { cleanup(tmp); }
}

const hex = (prefix, i) => `${prefix}${i.toString(16).padStart(39, '0')}`;
// Names that spelled the old section markers, plus ordinary ones.
const NAMES = ['P', 'D', 'F', 'L', 'R', `commit ${'a'.repeat(40)}`, 'src/a.txt', 'b.txt'];

// One rebased history: left = the published commits, right = the rebased branch, oldest first.
// kind: 'pub' (copy of left[ref]), 'unpub' (new patch), 'empty' (only filtered paths: no files, no patch-id).
function render({ left, right, dropPid = -1 }) {
  const lines = { L: [], R: [], F: [], P: [] };
  left.forEach((c) => {
    lines.L.push(c.sha);
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    lines.P.push(`${c.pid} ${c.sha}`);
  });
  right.forEach((c, i) => {
    lines.R.unshift(c.sha); // rev-list prints newest first
    if (c.kind === 'empty') return;
    lines.F.push(`\t${c.sha}`, '', ...c.files);
    if (i !== dropPid) lines.P.push(`${c.pid} ${c.sha}`);
  });
  const sec = (k, arr) => `\t${k}\n${arr.join('\n')}\n`;
  return sec('L', lines.L) + sec('R', lines.R) + sec('D', []) + sec('F', lines.F) + sec('P', lines.P);
}

const history = fc.record({
  nLeft: fc.integer({ min: 1, max: 4 }),
  right: fc.array(fc.record({
    kind: fc.constantFrom('pub', 'unpub', 'empty'),
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

// The model: the leading run of published or empty commits gives the base; a published copy after an unpublished commit warns.
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
  test('the base ends the leading published-or-empty run; a published copy above an unpublished commit warns', () => {
    fc.assert(fc.property(history, (h) => {
      assert.equal(match(render(h)), expected(h));
    }), { numRuns: 40 });
  });

  test('a commit with kept files but no patch-id always warns (fail closed)', () => {
    const withFiles = history.filter((h) => h.right.some((c) => c.kind !== 'empty'));
    fc.assert(fc.property(withFiles, fc.nat(), (h, n) => {
      const idx = h.right.map((c, i) => (c.kind === 'empty' ? -1 : i)).filter((i) => i >= 0);
      assert.equal(match(render({ ...h, dropPid: idx[n % idx.length] })), 'WARN');
    }), { numRuns: 30 });
  });

  test('a marker-side range with no non-merge commit warns', () => {
    assert.equal(match('\tL\n\n\tR\n\n\tD\n\n\tF\n\n\tP\n\n'), 'WARN');
  });
});

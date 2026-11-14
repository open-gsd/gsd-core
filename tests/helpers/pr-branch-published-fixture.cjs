'use strict';

/**
 * Shared fixtures of the #5469 `/gsd-pr-branch` published-marker tests
 * (`tests/pr-branch-published-marker-*.test.cjs`): the shipped bash blocks of
 * `gsd-core/workflows/pr-branch.md` (pr-branch-filter seam), run in order against real git
 * fixtures. The tests run in several files because each publish spawns bash, which costs
 * seconds on Windows: one file held about 24 minutes of Windows runtime, past the 10 minute
 * per-chunk timeout of `scripts/run-tests.cjs`.
 */

const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup, createTempDir } = require('../helpers.cjs');
const { toLegacyResult } = require('./git-fixture.cjs');
const { createFixture } = require('../fixtures/index.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');
const { gitChildEnv, gitIn, refOf } = require('./isolated-env.cjs');

const {
  readWorkflowText,
  extractPickLoop,
  extractBashBlockContaining,
  extractDeclarationLines,
  extractFunction,
  runBashFile,
  TRANSIENT_DIRS_MARKER,
  FILTER_PATHS_MARKER,
  PRECONDITIONS_MARKER,
} = require('./pr-branch-filter.cjs');

const MARKER = 'refs/gsd/pr-published/strict/main/feature';
const PENDING = 'refs/gsd/pr-built/strict/main/feature';
const BUILT = 'refs/gsd/pr-built-head/strict/main/feature';
const HOSTILE = 'a;b$c'; // a branch name that holds shell metacharacters

function git(dir, ...args) {
  return gitIn(dir)(args).trim();
}

function refkeyFn() {
  const text = readWorkflowText();
  return extractDeclarationLines(text, PRECONDITIONS_MARKER, ['refkey() {'])[0];
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildRepo(branch = 'feature') {
  const dir = createFixture({ prefix: 'gsd-prmarker-', git: true, planning: false, projectDoc: false, gitEnv: gitChildEnv });
  git(dir, 'branch', '-M', 'main');
  write(dir, 'code.txt', 'v0\n');
  write(dir, '.planning/STATE.md', 's0\n');
  commitAll(dir, 'chore: base');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

// One code+planning commit and one planning-only commit, both tagged rN.
function commitRound(dir, n, file = 'code.txt') {
  write(dir, file, `v${n}\n`);
  write(dir, `r${n}.txt`, `round ${n}\n`); // the replayed rounds are read off the -pr tree
  write(dir, `.planning/phases/r${n}.md`, `plan ${n}\n`);
  commitAll(dir, `feat: r${n}`);
  write(dir, '.planning/STATE.md', `s${n}\n`);
  commitAll(dir, `docs: r${n}`);
}

// Runs the shipped blocks in workflow order under pr_strict.
function publish(dir, target = 'main', { branch = 'feature', mode = 'true', gh = 'return 1', prelude = '', arms = '', afterPre = '', cwd = dir } = {}) {
  const text = readWorkflowText();
  const b = (marker) => extractBashBlockContaining(text, marker);
  const script = [
    `CURRENT_BRANCH='${branch}'`,
    `TARGET=${target}`,
    // run-with-timeout <secs> -- cmd...: log the call, then exec cmd (the real verb bounds it; the log proves it was used).
    // `arms` are case arms matched against the command (after the bound), to make one call fail, time out or lose output.
    `gsd_run() { if [ "$1" = run-with-timeout ]; then echo "$*" >> .git/rwt.log; shift 3; case "$*" in ${arms} esac; "$@"; else echo ${mode}; fi; }`,
    prelude || `gh() { ${gh}; }`, // hermetic: no network lookup unless a test supplies one
    b('PR_STRICT=$(gsd_run query config-get'), // the mode and the filter projections come first; the preconditions read them
    b(TRANSIENT_DIRS_MARKER),
    b(FILTER_PATHS_MARKER),
    b(PRECONDITIONS_MARKER),
    afterPre, // stands in for the outward steps (handle_sub_repos) that run between the preconditions and the build
    b('git log --oneline'),
    b('# Create PR branch from target'),
    extractPickLoop(text),
    b('git checkout "$CURRENT_BRANCH"'),
    b('{ DIFF_PATHS=$('),
    b('git update-ref "$PENDING_REF"'),
  ].join('\n');
  return runSh(script, cwd);
}

// `status` is null for a killed or timed-out run, so a fail-closed test cannot pass on one. Without `cwd` the script
// runs in the dir that holds `files` (name -> content).
function runSh(script, cwd, files) {
  return toLegacyResult(runBashFile(script, { prefix: 'gsd-prmarker-script-', cwd, files, env: (dir) => gitChildEnv(cwd ?? dir) }));
}

// Keys for `inputs`, one per line, through the shipped refkey function `fn`.
const refKeys = (fn, inputs) => {
  const r = runSh(`${fn}\nwhile IFS= read -r l; do refkey "$l"; echo; done < in.txt`, undefined, { 'in.txt': inputs.join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr);
  return splitLines(r.stdout).slice(0, inputs.length);
};

// Fast-forward the bare target to the published -pr branch (a merged PR).
function mergePr(dir, target = 'main') {
  git(dir, 'merge-base', '--is-ancestor', target, 'feature-pr');
  git(dir, 'update-ref', `refs/heads/${target}`, 'refs/heads/feature-pr');
}

// The shipped pr_merged (and its _to helper), for calling it directly.
const prMergedFns = () => {
  const text = readWorkflowText();
  const [toFn] = extractDeclarationLines(text, 'pr_merged() {', ['_to() {']);
  return [toFn, extractFunction(text, 'pr_merged() {', 'pr_merged')].join('\n');
};

// Runs the shipped pr_merged on feature-pr in `cwd`: MERGED or UNMERGED. `pre` stubs gh and gsd_run (the default runs
// the command unbounded: without a gsd_run every `_to` call fails and any probe reads UNMERGED).
const probePrMerged = (cwd, pre = 'gsd_run() { shift 3; "$@"; }\ngh() { return 1; }') => {
  const r = runSh(`TARGET=main TARGET_SHA=main PR_BRANCH=feature-pr PR_BASE=main\n${pre}\n${prMergedFns()}\npr_merged feature-pr && echo MERGED || echo UNMERGED`, cwd);
  assert.doesNotMatch(r.stderr, /fatal: Needed a single revision/, 'the ref lookups of pr_merged are quiet');
  return r.stdout.trim();
};

// The command a refusal prints on its `  <label>: <cmd>` line, so tests run what a user would paste.
const printedCmd = (stderr, label) => {
  const line = splitLines(stderr).find((l) => l.startsWith(`  ${label}: `));
  assert.ok(line, `no "${label}:" line in: ${stderr}`);
  return line.slice(label.length + 4);
};

const markerOf = (dir) => refOf(dir, MARKER);
const pendingOf = (dir) => refOf(dir, PENDING);
const builtOf = (dir) => refOf(dir, BUILT);
// The refs a run may change: the three recorded refs and the -pr branch.
const refsOf = (dir) => [markerOf(dir), pendingOf(dir), builtOf(dir), refOf(dir, 'refs/heads/feature-pr')];
// A rebase-merge of the published -pr onto a moved target: main gains an unrelated commit, then the -pr commits are cherry-picked.
const rebaseMergePr = (dir) => {
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'other.txt', 'x\n');
  commitAll(dir, 'chore: unrelated');
  git(dir, 'cherry-pick', ...splitLines(git(dir, 'log', '--reverse', '--format=%H', 'feature-pr', '--not', 'main~1')));
};
const changed = (dir) => splitLines(git(dir, 'diff', '--name-only', 'main', 'feature-pr')).sort();
// Rounds whose code reached the -pr tree (state, not log text).
const replayed = (dir) => changed(dir).filter((f) => /^r\d+\.txt$/.test(f));

// main takes round 1's code as one new commit (squash merge); `later` then edits the same file.
function squashMerge(dir, { later = false, deletePr = false } = {}) {
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', 'feature-pr', '--', 'code.txt', 'r1.txt');
  commitAll(dir, 'feat: squashed r1');
  if (later) { write(dir, 'code.txt', 'v1-edited\n'); commitAll(dir, 'chore: later edit'); }
  git(dir, 'checkout', '-q', 'feature');
  if (deletePr) git(dir, 'branch', '-D', 'feature-pr');
}

const onlyRound2 = (r, dir) => {
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(replayed(dir), ['r2.txt']);
};

// Executable gh on PATH (a shell function cannot be bounded, so pr_merged never queries one).
const ghPrelude = (repo, sha, base = 'main') => {
  const bin = createTempDir('gsd-prmarker-bin-');
  repo.keep(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n: > .git/gh-called\n[ "$*" = "pr list --state merged --head feature-pr --base ${base} --json headRefOid --jq .[].headRefOid" ] && echo ${sha}\n`, { mode: 0o755 });
  return `PATH="${bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}:$PATH"`;
};

// A -pr amended after the build (the built tip is no longer in it), merged by merge commit; `edit` then changes code.txt on main.
const amendedMerged = (repo, edit) => {
  const dir = repo();
  commitRound(dir, 1);
  assert.equal(publish(dir).status, 0);
  const tip1 = git(dir, 'rev-parse', 'feature');
  git(dir, 'checkout', '-q', 'feature-pr');
  write(dir, 'code.txt', 'v1-fixed\n');
  git(dir, 'commit', '-q', '-a', '--amend', '-m', 'feat: r1 amended');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pr', 'feature-pr');
  if (edit) { write(dir, edit.file, edit.text); commitAll(dir, 'chore: later target edit'); }
  git(dir, 'checkout', '-q', 'feature');
  commitRound(dir, 2, 'two.txt');
  return { dir, tip1 };
};

// Round 1 published and reported merged by gh, so the marker is promoted on the next run; main moves on with an unrelated commit.
function publishedWhileMainMoves(repo) {
  const dir = repo();
  commitRound(dir, 1);
  assert.equal(publish(dir).status, 0);
  const prelude = ghPrelude(repo, builtOf(dir));
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'other.txt', 'x\n');
  commitAll(dir, 'chore: unrelated');
  git(dir, 'checkout', '-q', 'feature');
  return { dir, prelude };
}

const WARNED = /not an ancestor of feature/;

// Each new exit 1 path prints its message and changes no ref.
const noRefs = (dir) => {
  assert.equal(git(dir, 'for-each-ref', 'refs/gsd'), '');
  assert.equal(refOf(dir, 'refs/heads/feature-pr'), '');
};

const renameFixture = (repo) => {
  const dir = repo();
  write(dir, 'old.txt', 'a\nb\nc\nd\ne\nf\n');
  commitAll(dir, 'chore: add old');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'feature');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'mv', 'old.txt', 'new.txt');
  write(dir, 'code.txt', 'v1\n');
  commitAll(dir, 'feat: r1 rename');
  assert.equal(publish(dir).status, 0);
  return dir;
};

// Call inside a describe: returns `repo(branch)`, a fresh fixture repo that is removed after each test.
function useRepos() {
  const dirs = [];
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
  const repo = (branch) => { const d = buildRepo(branch); dirs.push(d); return d; };
  repo.keep = (dir) => { dirs.push(dir); return dir; }; // also remove a dir the test made
  return repo;
}

module.exports = {
  MARKER,
  PENDING,
  BUILT,
  HOSTILE,
  git,
  refkeyFn,
  commitAll,
  write,
  commitRound,
  publish,
  runSh,
  refKeys,
  mergePr,
  prMergedFns,
  probePrMerged,
  printedCmd,
  markerOf,
  pendingOf,
  builtOf,
  refsOf,
  rebaseMergePr,
  changed,
  replayed,
  buildRepo,
  squashMerge,
  onlyRound2,
  ghPrelude,
  amendedMerged,
  publishedWhileMainMoves,
  WARNED,
  noRefs,
  renameFixture,
  useRepos,
};

'use strict';

/**
 * `check tdd-review-checkpoint` review findings (#5139, epic #5056, ADR-5057 Phase 6):
 *
 *   H1  `type: tdd` detection is byte-equivalent to the old `^type:\s*tdd\s*$` multiline regex in
 *       its three pathological forms (a duplicate `type:` key with tdd second, the value on the
 *       next line, and `type : tdd`, which does NOT match).
 *   H2  the plan id (a plan FILE NAME) reaches `git log --grep` as a LITERAL: a metacharacter in it
 *       can no longer satisfy RED/GREEN with an unrelated commit, while an ordinary id like
 *       `03.1-02` still matches its own commits.
 *   #5354 the seal (`TDD-REVIEW-SEAL.json`, `--record`), the `NotEvaluable` row for a squashed-away plan,
 *       the SUMMARY task-commit heuristic, hostile seals derived from a valid one, write-path faults and the `ship.md` seal step.
 *       The owners it uses are tested in their own files: `commitReachability` / `commitIsGone` in gate-tdd-review-seal.test.cjs, `isFullSha` in
 *       gate-evaluation-scope.test.cjs, `readSmallRegularFile` strict in capability-ledger.test.cjs and
 *       `isPlainObject` in gate-evidence.test.cjs.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { runHook } = require('./helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const shell = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const { SUMMARY_REFS_MAX, REPO_TEXT_MAX_BYTES, SEAL_FILE } = require('../gsd-core/bin/lib/gate-tdd-review-seal.cjs');
const { evaluateTddReviewCheckpoint, TDD_ROW_REASON, TDD_NOT_EVALUABLE_WHY } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, env: isolatedEnv({ home: dir }), encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  ).trim();
}

function withProject(planFiles, commits, fn) {
  const dir = createTempGitProject('gate-tdd-hardening-');
  try {
    for (const [name, content] of Object.entries(planFiles)) {
      const file = path.join(dir, '.planning', 'phases', '01-x', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    // The gate scopes `git log` to `-- .`, so each commit must touch a file (an empty one is invisible).
    commits.forEach((message, index) => {
      fs.writeFileSync(path.join(dir, `commit-${index}.txt`), `${message}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', message);
    });
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

const plan = (typeLines) => `---\nphase: 1\nplan: 1\n${typeLines}\n---\n# Plan\n`;

function review(dir) {
  const result = evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1'] });
  assert.equal(result.failure, undefined, 'not a usage failure');
  return result.payload;
}

const PHASE = '.planning/phases/01-x';
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function w(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

/** A SUMMARY whose `## Task Commits` lists one row per hash. */
const summaryOf = (hashes) => `# done\n\n## Task Commits\n\n${hashes.map((h, i) => `${i + 1}. **Task ${i + 1}: x** - \`${h}\``).join('\n')}\n`;

function cloneDepthOne(src, dest, branch) {
  gitOrThrow(['clone', '-q', '--depth', '1', ...(branch ? ['--branch', branch] : []), pathToFileURL(src).href, dest], { cwd: path.dirname(dest), env: isolatedEnv({ home: src }) });
}

function commit(dir, file, msg) {
  w(dir, file, msg);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

/** Squash `feature` onto `base` as one commit on a new `merged` branch. */
function squash(dir, base, subject = 'feat: squashed') {
  git(dir, 'checkout', '-q', '-b', 'merged', base);
  git(dir, 'merge', '--squash', 'feature');
  git(dir, 'commit', '-q', '-m', subject);
}

const run = (dir, ...args) => evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1', ...args] });

describe('H1 type: tdd detection equals the old regex in its pathological forms', () => {
  const CASES = [
    ['a duplicate type key with tdd second', 'type: execute\ntype: tdd', 1],
    ['the value on the next line', 'type:\ntdd', 1],
    ['a space before the colon (`type : tdd`)', 'type : tdd', 0],
    ['a quoted value', 'type: "tdd"', 0],
    ['a trailing comment', 'type: tdd # note', 0],
    ['plain', 'type: tdd', 1],
  ];
  for (const [label, typeLines, tddPlans] of CASES) {
    test(`${label} -> ${tddPlans} tdd plan(s)`, () => {
      withProject({ '01-01-PLAN.md': plan(typeLines) }, [], (dir) => {
        assert.equal(review(dir).tddPlans, tddPlans);
      });
    });
  }
});

// `*` and `?` are not valid in a Windows file name, and a symlink or FIFO needs POSIX: those tests are skipped there.
const posixOnly = { skip: process.platform === 'win32' };

describe('H2 the plan id is matched literally in the git --grep pattern', () => {
  test('an ordinary id with a dot (`03.1-02`) still matches its own RED and GREEN commits', () => {
    withProject({ '03.1-02-PLAN.md': plan('type: tdd') }, ['test(03.1-02): red', 'feat(03.1-02): green'], (dir) => {
      const out = review(dir);
      assert.equal(out.rows[0].planId, '03.1-02');
      assert.equal(out.rows[0].red, true);
      assert.equal(out.rows[0].green, true);
      assert.equal(out.violations, 0);
    });
  });

  test('`.` is a literal dot: an unrelated id (`03x1-02`) does not satisfy plan `03.1-02`', () => {
    withProject({ '03.1-02-PLAN.md': plan('type: tdd') }, ['test(03x1-02): red', 'feat(03x1-02): green'], (dir) => {
      const row = review(dir).rows[0];
      assert.equal(row.red, false);
      assert.equal(row.green, false);
      assert.deepStrictEqual(row.missing, ['RED', 'GREEN']);
    });
  });

  test('a bracket id (`a[b]`) matches its own commits and not `ab`', () => {
    withProject({ 'a[b]-PLAN.md': plan('type: tdd') }, ['test(ab): r', 'feat(ab): g'], (dir) => {
      assert.equal(review(dir).rows[0].red, false);
    });
    withProject({ 'a[b]-PLAN.md': plan('type: tdd') }, ['test(a[b]): r', 'feat(a[b]): g', 'refactor(a[b]): t'], (dir) => {
      const row = review(dir).rows[0];
      assert.equal(row.red, true);
      assert.equal(row.green, true);
      assert.equal(row.refactor, true);
    });
  });

  test('parentheses, plus, caret, dollar and braces in an id are literal', () => {
    for (const id of ['a(b', 'a)b', 'a+b', 'a^b', 'a$b', 'a{1}']) {
      withProject({ [`${id}-PLAN.md`]: plan('type: tdd') }, [`test(${id}): r`, `feat(${id}): g`], (dir) => {
        const row = review(dir).rows[0];
        assert.equal(row.planId, id);
        assert.equal(row.red, true, `${id}: its own RED commit matches`);
        assert.equal(row.green, true, `${id}: its own GREEN commit matches`);
      });
    }
    // `a+b` would (as an extended regex) match `aab`; `a{1}` would match `a`.
    withProject({ 'a+b-PLAN.md': plan('type: tdd') }, ['test(aab): r', 'feat(aab): g'], (dir) => {
      assert.equal(review(dir).rows[0].red, false);
    });
    withProject({ 'a{1}-PLAN.md': plan('type: tdd') }, ['test(a): r', 'feat(a): g'], (dir) => {
      assert.equal(review(dir).rows[0].red, false);
    });
  });

  test('a plan named `x.*` (wildcard) is not satisfied by unrelated commits', posixOnly, () => {
    withProject({ 'x.*-PLAN.md': plan('type: tdd') }, ['test(xyz): red', 'feat(xyz): green', 'test(x): red'], (dir) => {
      const row = review(dir).rows[0];
      assert.equal(row.planId, 'x.*');
      assert.equal(row.red, false);
      assert.equal(row.green, false);
      assert.equal(review(dir).violations, 1);
    });
    withProject({ 'x.*-PLAN.md': plan('type: tdd') }, ['test(x.*): red', 'feat(x.*): green'], (dir) => {
      const row = review(dir).rows[0];
      assert.equal(row.red, true);
      assert.equal(row.green, true);
    });
  });
});

describe('#5354 tdd review checkpoint seal', () => {
  function fixture(subjects, { summary = true, refs = false, plan: hasPlan = true } = {}) {
    const dir = createTempGitProject('gate-5354-');
    dirs.push(dir);
    if (!hasPlan) w(dir, `${PHASE}/.keep`, '');
    if (hasPlan) w(dir, `${PHASE}/01-01-PLAN.md`, plan('type: tdd'));
    if (summary) w(dir, `${PHASE}/01-01-SUMMARY.md`, '# done\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'docs: plans');
    const base = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-b', 'feature');
    subjects.forEach((s, i) => commit(dir, `f${i}.txt`, s));
    if (refs) {
      const shas = git(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
      w(dir, `${PHASE}/01-01-SUMMARY.md`, summaryOf(shas));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'docs: summary');
    }
    return { dir, base };
  }
  function sealCommit(dir) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'docs(01-01): seal');
  }
  function sealThenSquash(dir, base, subject) {
    run(dir, '--record');
    sealCommit(dir);
    squash(dir, base, subject);
  }
  function shallowClone(dir, suffix = '', branch) {
    const clone = path.join(path.dirname(dir), `${path.basename(dir)}-shallow${suffix}`);
    dirs.push(clone);
    cloneDepthOne(dir, clone, branch);
    return clone;
  }
  const ghostSummary = (dir) => w(dir, `${PHASE}/01-01-SUMMARY.md`, summaryOf(['d'.repeat(40)]));
  const SEAL = path.join(PHASE, SEAL_FILE);
  const sha = (c) => c.repeat(40);
  const sealOf = (red, green) => JSON.stringify({ plans: { '01-01': { red, green } } });
  const padTo = (text, size) => text + ' '.repeat(size - Buffer.byteLength(text));
  const RG = ['test(01-01): red', 'feat(01-01): green'];
  const PLAN_02 = '---\nphase: 1\nplan: 2\ntype: tdd\n---\n# Plan\n';
  const summaryFile = (dir) => path.join(dir, PHASE, '01-01-SUMMARY.md');
  // The SUMMARY names `hashes`, then the branch is squashed: no listed commit is reachable.
  const abbreviated = (dir, base) => git(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n').map((h) => h.slice(0, 7));
  function squashWithSummary(hashes, transform = (text) => text) {
    return (dir, base, title) => {
      w(dir, `${PHASE}/01-01-SUMMARY.md`, transform(summaryOf(hashes)));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'docs: summary');
      squash(dir, base, title);
    };
  }

  // One table, one runner: each case builds a history, `setup` may return another directory to review (a clone, a copy
  // that is no repo), and `expect` names the row the gate must report. Every limit is pinned at limit-1, limit and limit+1.
  const PASS = { status: 'Pass', violations: 0, block: false };
  const SQUASHED = { status: 'NotEvaluable', reason: TDD_ROW_REASON.UNSEALED_SUMMARY_UNREACHABLE, violations: 0, block: false };
  const SCENARIOS = [
    // A record written before a squash survives it, whatever the squash is titled or followed by (#5354).
    { name: 'a sealed plan squashed under a plan-scoped title passes', setup: (d, b) => sealThenSquash(d, b, 'feat(01-01): phase one'), expect: PASS },
    { name: 'a sealed scoped squash followed by fix(01-01): typo still passes', setup: (d, b) => { sealThenSquash(d, b, 'feat(01-01): phase one'); commit(d, 'typo.txt', 'fix(01-01): typo'); }, expect: PASS },
    { name: 'a sealed plan squashed with a test(01-01): squash title still passes', setup: (d, b) => sealThenSquash(d, b, 'test(01-01): phase one'), expect: PASS },
    { name: 'a sealed plan squashed with a later test(01-01): commit still passes', setup: (d, b) => { sealThenSquash(d, b, 'feat(01-01): phase one'); commit(d, 'after.txt', 'test(01-01): add case'); }, expect: PASS },
    // The squash is told by the seal's RED no longer being reachable: a reachable one, or none sealed, credits nothing.
    { name: 'a seal whose RED is still reachable credits nothing: live commits that lack GREEN fail', subjects: ['test(01-01): red'], opts: { summary: false }, setup: (d) => w(d, SEAL, sealOf(git(d, 'rev-parse', 'HEAD'), sha('b'))), expect: { status: 'FAIL', missing: ['GREEN'] } },
    { name: 'a plan without a live RED whose seal names reachable commits credits nothing', subjects: ['chore: x'], opts: { summary: false }, setup: (d) => w(d, SEAL, sealOf(git(d, 'rev-parse', 'HEAD'), git(d, 'rev-parse', 'HEAD~1'))), expect: { status: 'FAIL', missing: ['RED', 'GREEN'] } },
    { name: 'a scoped squash title without a seal fails (live plan commit, nothing sealed)', opts: { refs: true }, setup: (d, b) => squash(d, b, 'feat(01-01): squashed'), expect: { status: 'FAIL', missing: ['RED'] } },
    // No seal, task commits gone: not evaluable, never a failure.
    { name: 'no record and no reachable commits but a SUMMARY is not evaluable, not a failure', opts: { refs: true }, setup: (d, b) => squash(d, b), expect: { ...SQUASHED, outcome: 'advisory' } },
    { name: 'fabricated SUMMARY ids (no such object) are not evaluable, like a squashed-and-collected commit', subjects: ['chore: x'], setup: (d) => ghostSummary(d), expect: { status: 'NotEvaluable' } },
    // The SUMMARY id grammar (extractTaskCommitRefs): 7 to 40 lowercase hex in backticks, CRLF lines allowed.
    { name: 'a 7-char SUMMARY id of a squashed-away commit is not evaluable', opts: { refs: true }, setup: (d, b) => squashWithSummary(abbreviated(d, b))(d, b), expect: SQUASHED },
    { name: 'a SUMMARY that lists a squashed-away commit and an unknown id is not evaluable, though its subject survives', subjects: ['chore: red', 'chore: green'], setup: (d, b) => { const squashed = git(d, 'rev-parse', 'HEAD'); squashWithSummary([squashed, 'd'.repeat(40)])(d, b, 'chore: green'); }, expect: { status: 'NotEvaluable', violations: 0 } },
    { name: 'a 7-char SUMMARY id git does not know is not evaluable', subjects: ['chore: x'], setup: (d) => w(d, `${PHASE}/01-01-SUMMARY.md`, summaryOf(['abcdef0'])), expect: { status: 'NotEvaluable' } },
    { name: 'an uppercase SUMMARY id lists no hash, so the plan fails', subjects: ['chore: x'], setup: (d) => w(d, `${PHASE}/01-01-SUMMARY.md`, summaryOf(['D'.repeat(40)])), expect: { status: 'FAIL' } },
    { name: 'a SUMMARY with CRLF line endings is read like one with LF', opts: { refs: true }, setup: (d, b) => { squashWithSummary(abbreviated(d, b), (t) => t.replace(/\n/g, '\r\n'))(d, b); }, expect: SQUASHED },
    { name: 'a squash whose title repeats one task subject is still not evaluable', subjects: ['chore: red', 'chore: green'], opts: { refs: true }, setup: (d, b) => squash(d, b, 'chore: green'), expect: { status: 'NotEvaluable', violations: 0 } },
    {
      name: 'a plan with one task rewritten and one gone is not evaluable, not a rewrite',
      subjects: ['chore: red', 'chore: green'], opts: { refs: true },
      setup: (d, b) => {
        git(d, 'checkout', '-b', 'partial', b);
        w(d, 'f0.txt', 'different content'); // same content and parent would reproduce the original sha
        git(d, 'add', '-A');
        git(d, 'commit', '-m', 'chore: red');
        git(d, 'checkout', 'feature', '--', `${PHASE}/01-01-SUMMARY.md`);
        git(d, 'commit', '-m', 'docs: summary');
      },
      expect: { status: 'NotEvaluable', violations: 0 },
    },
    { name: 'an absent primary SUMMARY falls through to a later candidate name that holds the task commits', opts: { refs: true }, setup: (d, b) => { squash(d, b); fs.renameSync(summaryFile(d), path.join(d, PHASE, '01-01-PLAN-SUMMARY.md')); }, expect: { status: 'NotEvaluable' } },
    { name: 'a seal holding only a sibling plan entry does not rule out not evaluable', opts: { refs: true }, setup: (d, b) => { squash(d, b); w(d, SEAL, JSON.stringify({ plans: { '01-99': { red: sha('a'), green: sha('b') } } })); }, expect: { status: 'NotEvaluable' } },
    // A seal entry that credits nothing, or a live commit, makes the plan an ordinary failure.
    { name: 'a seal entry that credits nothing (red equal to green) still rules out not evaluable', opts: { refs: true }, setup: (d, b) => { squash(d, b); w(d, SEAL, sealOf(sha('a'), sha('a'))); }, expect: { status: 'FAIL' } },
    { name: 'a seal with two distinct non-hex values credits nothing, and its entry rules out not evaluable', opts: { refs: true }, setup: (d, b) => { squash(d, b); w(d, SEAL, sealOf('zz', 'yy')); }, expect: { status: 'FAIL', missing: ['RED', 'GREEN'], violations: 1 } },
    { name: 'a seal with only red does not make the plan not evaluable', opts: { refs: true }, setup: (d, b) => { w(d, SEAL, JSON.stringify({ plans: { '01-01': { red: sha('a') } } })); git(d, 'add', '-A'); git(d, 'commit', '-m', 'seal'); squash(d, b); }, expect: { status: 'FAIL' } },
    { name: 'a plan with reachable commits lacking test()/feat() still fails', subjects: ['docs(01-01): notes'], opts: { summary: false }, expect: { status: 'FAIL', missing: ['RED', 'GREEN'], violations: 1, block: true } },
    { name: 'no commits, no SUMMARY, no seal still fails', subjects: [], opts: { summary: false }, expect: { status: 'FAIL', violations: 1 } },
    { name: 'a plan with only a docs commit and a SUMMARY naming a nonexistent id fails (live plan commit)', subjects: ['docs(01-01): notes'], setup: (d) => ghostSummary(d), expect: { status: 'FAIL', missing: ['RED', 'GREEN'] } },
    { name: 'a live RED and a SUMMARY naming a nonexistent id fails missing GREEN (live evidence is never overridden)', subjects: ['test(01-01): red'], setup: (d) => ghostSummary(d), expect: { status: 'FAIL', missing: ['GREEN'] } },
    { name: 'an un-squashed plan whose SUMMARY hashes are reachable and has no test() fails', subjects: ['docs(01-01): notes'], opts: { refs: true }, expect: { status: 'FAIL', block: true } },
    {
      name: 'unscoped commits cherry-picked onto a moved base are a rewrite, not a squash: FAIL',
      subjects: ['chore: a', 'chore: b'], opts: { refs: true },
      setup: (d, b) => { git(d, 'checkout', '-b', 'rebased', b); commit(d, 'moved.txt', 'chore: moved base'); git(d, 'cherry-pick', `${b}..feature`); },
      expect: { status: 'FAIL', missing: ['RED', 'GREEN'] },
    },
    {
      name: 'a rebased plan whose SUMMARY hashes are unreachable but whose commits are still reachable fails, not evaluable',
      subjects: ['docs(01-01): notes'], opts: { refs: true },
      setup: (d, b) => {
        git(d, 'checkout', '-b', 'rebased', b);
        commit(d, 'f0.txt', 'docs(01-01): notes');
        w(d, 'f0.txt', 'different content');
        git(d, 'add', '-A');
        git(d, 'commit', '--amend', '-m', 'docs(01-01): notes');
        git(d, 'checkout', 'feature', '--', `${PHASE}/01-01-SUMMARY.md`);
        git(d, 'commit', '-m', 'docs: summary');
      },
      expect: { status: 'FAIL', violations: 1 },
    },
    { name: 'a dependent plan feat() does not mask a missing RED', subjects: ['feat(01-02): green'], opts: { summary: false }, setup: (d) => w(d, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: execute\ndepends_on: [01-01]\n---\n'), expect: { status: 'FAIL', missing: ['RED'] } },
    // The primary SUMMARY is unreadable, so a later candidate name must not turn the plan into NotEvaluable (execute-mvp-tdd.md: ordinary failure).
    ...[
      ['symlinked', true, (d) => { const real = path.join(d, 'real-summary.md'); fs.renameSync(summaryFile(d), real); fs.symlinkSync(real, summaryFile(d)); }],
      ['oversized', false, (d) => fs.writeFileSync(summaryFile(d), padTo(fs.readFileSync(summaryFile(d), 'utf8'), REPO_TEXT_MAX_BYTES + 1))],
    ].map(([label, posix, damage]) => ({
      name: `a ${label} primary SUMMARY fails even when a later candidate name holds task commits`, posix, opts: { refs: true },
      setup: (d, b) => { squash(d, b); fs.copyFileSync(summaryFile(d), path.join(d, PHASE, '01-01-PLAN-SUMMARY.md')); damage(d); },
      expect: { status: 'FAIL' },
    })),
    { name: 'a seal entry with red equal to green and no commits or SUMMARY is ignored', subjects: [], opts: { summary: false }, setup: (d) => w(d, SEAL, sealOf(sha('a'), sha('a'))), expect: { status: 'FAIL' } },
    // A shallow clone cannot tell a squash from an un-squashed skipper; outside a repository nothing can be told.
    {
      name: 'a sealed pair with red equal to green in a shallow clone is a failure, not "sealed_shallow_history"',
      setup: (d, b) => { squash(d, b); w(d, SEAL, sealOf(sha('a'), sha('a'))); git(d, 'add', '-A'); git(d, 'commit', '-m', 'docs: seal'); return shallowClone(d, '-equal', 'merged'); },
      expect: { status: 'FAIL', missing: ['RED', 'GREEN'] },
    },
    { name: 'a shallow clone does not read an absent seal RED as squashed: a live RED without GREEN still fails', subjects: ['test(01-01): red'], setup: (d) => { const clone = shallowClone(d); w(clone, SEAL, sealOf(sha('a'), sha('b'))); return clone; }, expect: { status: 'FAIL', missing: ['GREEN'] } },
    { name: 'a sealed squashed plan in a shallow clone is not evaluable, not a failure', setup: (d, b) => { sealThenSquash(d, b); return shallowClone(d, '-sealed', 'merged'); }, expect: { status: 'NotEvaluable', reason: TDD_ROW_REASON.SEALED_SHALLOW_HISTORY, block: false } },
    { name: 'a shallow clone cannot tell squashed from un-squashed: an un-squashed skipper still FAILs', subjects: ['docs(01-01): notes'], opts: { refs: true }, setup: (d) => shallowClone(d), expect: { status: 'FAIL', block: true } },
    {
      name: 'outside a git repository an un-squashed skipper still FAILs',
      subjects: ['docs(01-01): notes'], opts: { refs: true },
      setup: (d) => { const bare = path.join(path.dirname(d), `${path.basename(d)}-nogit`); fs.cpSync(path.join(d, '.planning'), path.join(bare, '.planning'), { recursive: true }); dirs.push(bare); return bare; },
      expect: { status: 'FAIL' },
    },
    // Limits: the SUMMARY text, the seal text, the SUMMARY hash count (each distinct hash costs git spawns) and the sealed hash shape.
    ...[['limit-1', REPO_TEXT_MAX_BYTES - 1, 'NotEvaluable'], ['limit', REPO_TEXT_MAX_BYTES, 'NotEvaluable'], ['limit+1', REPO_TEXT_MAX_BYTES + 1, 'FAIL']].map(([label, size, status]) => ({
      // The Task Commits section comes first so an unread SUMMARY (FAIL) is told from a read one (NotEvaluable).
      name: `a SUMMARY at ${label} bytes is ${status === 'FAIL' ? 'not read (no task commits)' : 'still read'}`,
      opts: { refs: true },
      setup: (d, b) => { squash(d, b); fs.writeFileSync(summaryFile(d), padTo(fs.readFileSync(summaryFile(d), 'utf8'), size)); },
      expect: { status },
    })),
    ...[['limit-1', REPO_TEXT_MAX_BYTES - 1, 'Pass'], ['limit', REPO_TEXT_MAX_BYTES, 'Pass'], ['limit+1', REPO_TEXT_MAX_BYTES + 1, undefined]].map(([label, size, status]) => ({
      name: `seal size ${label} (${size} bytes) -> ${status ?? 'unreadable'}`,
      subjects: [], opts: { summary: false },
      setup: (d) => w(d, SEAL, padTo(sealOf(sha('a'), sha('b')), size)),
      expect: status ? { status } : { outcome: 'unreadable' },
    })),
    ...[['limit-1', SUMMARY_REFS_MAX - 1, 'NotEvaluable'], ['limit', SUMMARY_REFS_MAX, 'NotEvaluable'], ['limit+1', SUMMARY_REFS_MAX + 1, 'FAIL']].map(([label, count, status]) => ({
      name: `SUMMARY with ${label} (${count}) distinct unreachable task commits -> ${status}`,
      setup: squashWithSummary(Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(40, 'f'))),
      expect: { status },
    })),
    // The cap alone bounds the id lists of the three `git log` calls of the subject check, so the limit must pass through them with ids git knows.
    { name: `SUMMARY with ${SUMMARY_REFS_MAX} real task commits that a squash dropped -> NotEvaluable`, subjects: Array.from({ length: SUMMARY_REFS_MAX }, (_, i) => `chore: task ${i + 1}`), opts: { refs: true }, setup: (d, b) => squash(d, b), expect: { status: 'NotEvaluable' } },
    { name: 'a duplicated SUMMARY hash counts once against the cap', setup: squashWithSummary(Array.from({ length: SUMMARY_REFS_MAX + 1 }, () => 'e'.repeat(40))), expect: { status: 'NotEvaluable' } },
    ...[['39 hex', 'a'.repeat(39), 'FAIL'], ['40 hex', 'a'.repeat(40), 'Pass'], ['41 hex', 'a'.repeat(41), 'FAIL'], ['uppercase', 'A'.repeat(40), 'FAIL']].map(([label, hash, status]) => ({
      name: `sealed red hash: ${label} -> ${status}`, subjects: [], opts: { summary: false }, setup: (d) => w(d, SEAL, sealOf(hash, sha('b'))), expect: { status },
    })),
  ];
  for (const { name, posix, subjects = RG, opts, setup, expect } of SCENARIOS) {
    test(name, posix ? posixOnly : {}, () => {
      const made = fixture(subjects, opts);
      const r = run(setup?.(made.dir, made.base) ?? made.dir);
      assert.equal(r.payload.rows[0]?.status, expect.status);
      for (const key of ['missing', 'reason']) if (key in expect) assert.deepEqual(r.payload.rows[0][key], expect[key]);
      if ('violations' in expect) assert.equal(r.payload.violations, expect.violations);
      for (const key of ['block', 'outcome']) if (key in expect) assert.equal(r[key], expect[key]);
    });
  }

  // A git call that gives no answer is not "squashed": the plan stays an ordinary failure.
  const GIT_NO_ANSWER = { exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null, timedOut: false };
  function failGit(t, matches, result) {
    const real = shell.execGit;
    t.mock.method(shell, 'execGit', (args, opts) => (matches(args) ? result : real(args, opts)));
  }

  test('a timed-out object lookup for a SUMMARY commit is a failure, not "squashed" (#5354)', (t) => {
    const { dir } = fixture([], { summary: false });
    w(dir, `${PHASE}/01-01-SUMMARY.md`, summaryOf(['a'.repeat(40)]));
    failGit(t, (args) => args.includes('--verify'), { ...GIT_NO_ANSWER, exitCode: 1, signal: 'SIGTERM', timedOut: true });
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.violations, 1);
  });

  test('a subject listing git cannot deliver is a failure, not "squashed" (#5354)', (t) => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    failGit(t, (args) => args[0] === 'log' && args.includes('--no-walk=unsorted') && args.some((a) => a.includes('%s')), GIT_NO_ANSWER);
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.violations, 1);
  });

  test('two plans in one run probe the shallow-clone state once', (t) => {
    const { dir } = fixture([], { summary: false });
    const fake = (c) => summaryOf([c.repeat(40)]);
    w(dir, `${PHASE}/01-01-SUMMARY.md`, fake('a'));
    w(dir, `${PHASE}/01-02-PLAN.md`, PLAN_02);
    w(dir, `${PHASE}/01-02-SUMMARY.md`, fake('b'));
    const real = shell.execGit;
    let probes = 0;
    t.mock.method(shell, 'execGit', (args, opts) => {
      if (args.includes('--is-shallow-repository')) probes += 1;
      return real(args, opts);
    });
    const rows = run(dir).payload.rows;
    assert.deepEqual(rows.map((r) => r.reason), ['unsealed_summary_unreachable', 'unsealed_summary_unreachable']);
    assert.equal(probes, 1);
  });

  test('a record written before the squash keeps the plan passing after git merge --squash', () => {
    const { dir, base } = fixture(RG);
    const before = run(dir, '--record');
    assert.equal(before.payload.violations, 0);
    const seal = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8'));
    assert.match(seal.plans['01-01'].red, /^[0-9a-f]{40}$/);
    assert.match(seal.plans['01-01'].green, /^[0-9a-f]{40}$/);
    sealCommit(dir);
    squash(dir, base);
    const after = run(dir);
    assert.equal(after.payload.violations, 0);
    assert.equal(after.block, false);
    assert.equal(after.payload.rows[0].status, 'Pass');
  });

  test('--record after a test(01-01): squash writes the sealed RED back, so the next run still passes (#5354)', () => {
    const { dir, base } = fixture(RG);
    run(dir, '--record');
    const sealed = fs.readFileSync(path.join(dir, SEAL), 'utf8');
    sealCommit(dir);
    squash(dir, base, 'test(01-01): phase one');
    commit(dir, 'later.txt', 'test(01-01): add case');
    assert.equal(run(dir, '--record').payload.rows[0].status, 'Pass');
    assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), sealed);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
  });

  test('a shallow marker over a warm object store does not make an existing seal commit gone (#5354)', () => {
    const { dir, base } = fixture(RG);
    sealThenSquash(dir, base);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
    w(dir, '.git/shallow', `${git(dir, 'rev-parse', 'HEAD')}\n`);
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('the row reasons are a locked set, and every NotEvaluable reason has report text', () => {
    assert.deepEqual(Object.keys(TDD_ROW_REASON).sort(), ['GREEN_BEFORE_RED', 'SEALED_SHALLOW_HISTORY', 'UNSEALED_SUMMARY_UNREACHABLE']);
    const notEvaluable = Object.values(TDD_ROW_REASON).filter((r) => r !== TDD_ROW_REASON.GREEN_BEFORE_RED).sort();
    assert.deepEqual(Object.keys(TDD_NOT_EVALUABLE_WHY).sort(), notEvaluable);
    for (const text of Object.values(TDD_NOT_EVALUABLE_WHY)) assert.ok(typeof text === 'string' && text.length > 0);
  });

  // --record: what it writes and what it keeps.
  test('--record writes nothing when no plan passes', () => {
    const { dir } = fixture(['test(01-01): red']);
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    assert.equal(fs.existsSync(path.join(dir, SEAL)), false);
  });

  test('--record seals the passing plans even when a sibling plan fails', () => {
    const { dir } = fixture(RG);
    w(dir, `${PHASE}/01-02-PLAN.md`, PLAN_02);
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    const { plans } = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8'));
    assert.ok(plans['01-01']);
    assert.equal(plans['01-02'], undefined);
  });

  test('--record keeps seal entries of other plans', () => {
    const { dir } = fixture(RG);
    w(dir, SEAL, JSON.stringify({ plans: { '01-99': { red: sha('b'), green: sha('c') } } }));
    run(dir, '--record');
    const plans = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans;
    assert.deepEqual(Object.keys(plans).sort(), ['01-01', '01-99']);
  });

  test('--record seals a plan in a phase directory whose name has a space and a non-ASCII letter', () => {
    const { dir } = fixture(RG);
    const odd = '.planning/phases/01-ünï phase';
    fs.renameSync(path.join(dir, PHASE), path.join(dir, odd));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'docs: rename phase dir');
    assert.equal(run(dir, '--record').payload.violations, 0);
    const seal = JSON.parse(fs.readFileSync(path.join(dir, odd, SEAL_FILE), 'utf8'));
    assert.match(seal.plans['01-01'].red, /^[0-9a-f]{40}$/);
  });

  // A seal refused on read or at --record: the gate reports one typed `unreadable` entry and touches nothing it refused.
  function outsideOf(dir, content) {
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, content);
    return outside;
  }
  const REFUSED = [
    { name: 'a symlinked seal is refused and its target is never written', posix: true, args: ['--record'], make: (t, dir) => fs.symlinkSync(outsideOf(dir, 'untouched'), path.join(dir, SEAL)), after: (dir) => assert.equal(fs.readFileSync(path.join(dir, 'outside.json'), 'utf8'), 'untouched') },
    { name: 'a symlinked seal credits nothing on read', posix: true, make: (t, dir) => fs.symlinkSync(outsideOf(dir, sealOf(sha('a'), sha('b'))), path.join(dir, SEAL)) },
    {
      name: 'a symlinked seal is refused at open even if lstat is made to lie (no check-to-read window)', posix: true,
      make: (t, dir) => { const outside = outsideOf(dir, sealOf(sha('a'), sha('b'))); fs.symlinkSync(outside, path.join(dir, SEAL)); t.mock.method(fs, 'lstatSync', () => fs.statSync(outside)); },
    },
    { name: 'a FIFO seal never hangs the open (O_NONBLOCK) and fstat rejects it as not a regular file', posix: true, make: (t, dir) => mkfifo(t, path.join(dir, SEAL)) },
    { name: 'a dangling symlink at the seal path is refused and its target is never created', posix: true, args: ['--record'], make: (t, dir) => fs.symlinkSync(path.join(dir, 'not-there.json'), path.join(dir, SEAL)), after: (dir) => assert.equal(fs.existsSync(path.join(dir, 'not-there.json')), false) },
    { name: '--record over a seal that is a directory reports unreadable instead of throwing', args: ['--record'], make: (t, dir) => fs.mkdirSync(path.join(dir, SEAL)) },
    { name: '--record refuses to overwrite a malformed seal and leaves it untouched', args: ['--record'], make: (t, dir) => w(dir, SEAL, '{not json'), after: (dir) => assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), '{not json') },
    { name: 'a malformed seal is unreadable, never an advisory "no entry (squashed?)"', make: (t, dir) => w(dir, SEAL, '{not json'), after: (dir, r) => assert.deepEqual(r.payload.rows, []) },
  ];
  for (const { name, posix, args = [], make, after } of REFUSED) {
    test(name, posix ? posixOnly : {}, (t) => {
      const { dir } = fixture(RG);
      if (make(t, dir) === false) return;
      const r = run(dir, ...args);
      assert.equal(r.outcome, 'unreadable');
      assert.equal(r.payload.passed, false);
      assert.equal(r.payload.unreadable.length, 1);
      after?.(dir, r);
    });
  }

  // A fault injected while the seal is read or written: one typed `unreadable` entry, the prior seal byte for byte, no temp file.
  const PRIOR = JSON.stringify({ plans: { '01-99': { red: sha('a'), green: sha('b') } } });
  function failFs(t, method, when, code, message) {
    const real = fs[method];
    t.mock.method(fs, method, (f, ...rest) => {
      if (when(String(f))) throw Object.assign(new Error(message), { code });
      return real(f, ...rest);
    });
  }
  const isSeal = (f) => f.endsWith(SEAL_FILE);
  const FAULTS = [
    { name: 'a collision on the temp file leaves the prior seal and no temp file', prior: PRIOR, fault: (t) => failFs(t, 'openSync', (f) => f.includes('.tmp.'), 'EEXIST', 'temp file exists') },
    {
      name: '--record into an unwritable phase directory reports unreadable and keeps the review rows',
      // A second TDD plan with no commits fails: the review result must survive the write fault (a read failure returns no rows).
      setup: (dir) => w(dir, `${PHASE}/01-02-PLAN.md`, PLAN_02),
      fault: (t) => failFs(t, 'openSync', (f) => f.includes(SEAL_FILE), 'EACCES', 'denied'),
      unreadable: [{ source: SEAL_FILE, reason: 'EACCES' }], rows: ['Pass', 'FAIL'], violations: 1,
    },
    { name: '--record names the error text when the write fails with a code that means "absent" (ENOENT)', fault: (t) => failFs(t, 'openSync', (f) => f.includes(SEAL_FILE), 'ENOENT', 'phase dir vanished'), unreadable: [{ source: SEAL_FILE, reason: 'Error: phase dir vanished' }] },
    {
      name: 'a failed --record leaves no temp file behind',
      fault: (t) => { failFs(t, 'renameSync', () => true, 'EPERM', 'rename failed'); },
      opened: true,
    },
    {
      name: 'a partial write of the temp file leaves the prior seal byte for byte and no temp file', prior: PRIOR,
      fault: (t) => {
        const real = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (f, data, ...rest) => {
          if (typeof f !== 'number' || !String(data).includes('"01-01"')) return real(f, data, ...rest);
          real(f, String(data).slice(0, 10), ...rest);
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        });
      },
    },
    { name: '--record reports unreadable when the seal cannot be examined (lstat fails, not ENOENT)', fault: (t) => failFs(t, 'lstatSync', isSeal, 'EACCES', 'denied'), source: (dir) => path.join(dir, SEAL) },
    { name: '--record refuses a seal path that became a directory between the read and the write', fault: (t, dir) => { const real = fs.lstatSync; let seen = 0; t.mock.method(fs, 'lstatSync', (f, ...rest) => (isSeal(String(f)) && ++seen === 2 ? real(dir) : real(f, ...rest))); } },
    { name: '--record refuses a seal path that cannot be examined at write time', fault: (t) => { let seen = 0; failFs(t, 'lstatSync', (f) => isSeal(f) && ++seen === 2, 'EACCES', 'denied'); } },
    { name: 'a close() failure on the seal is reported unreadable, not thrown', args: [], prior: sealOf(sha('a'), sha('b')), fault: (t) => { const real = fs.closeSync; t.mock.method(fs, 'closeSync', (fd, ...rest) => { real(fd, ...rest); throw Object.assign(new Error('close failed'), { code: 'EIO' }); }); }, source: (dir) => path.join(dir, SEAL) },
  ];
  for (const { name, args = ['--record'], prior, setup, fault, unreadable, rows, violations, opened, source = () => SEAL_FILE } of FAULTS) {
    test(name, (t) => {
      const { dir } = fixture(RG);
      if (prior !== undefined) w(dir, SEAL, prior);
      setup?.(dir);
      const realOpen = fs.openSync;
      let tempOpened = false;
      t.mock.method(fs, 'openSync', (f, ...rest) => { if (String(f).includes('.tmp.')) tempOpened = true; return realOpen(f, ...rest); });
      fault(t, dir);
      const r = run(dir, ...args);
      assert.equal(r.outcome, 'unreadable');
      assert.equal(r.payload.passed, false);
      assert.equal(r.payload.unreadable.length, 1);
      assert.equal(r.payload.unreadable[0].source, source(dir));
      if (unreadable) assert.deepEqual(r.payload.unreadable, unreadable);
      if (rows) assert.deepEqual(r.payload.rows.map((row) => row.status), rows);
      if (violations !== undefined) assert.equal(r.payload.violations, violations);
      if (opened) assert.ok(tempOpened, 'the temp file was created before the failure');
      assert.deepEqual(fs.readdirSync(path.join(dir, PHASE)).filter((n) => n.includes('.tmp')), []);
      if (prior === undefined) assert.equal(fs.existsSync(path.join(dir, SEAL)), false);
      else assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), prior);
    });
  }

  // Each Object.prototype member named as a plan: the seal is looked up by own key only.
  for (const planId of ['constructor', 'toString', '__proto__']) {
    test(`a plan named ${planId} does not inherit a seal entry from Object.prototype`, () => {
      const { dir } = fixture([], { summary: false, plan: false });
      w(dir, `${PHASE}/${planId}-PLAN.md`, plan('type: tdd'));
      w(dir, `${PHASE}/${planId}-SUMMARY.md`, summaryOf(['d'.repeat(40)]));
      w(dir, SEAL, '{"plans":{}}');
      assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
    });
  }

  test('a seal entry keyed __proto__ is its own entry for a plan named __proto__ and is credited', () => {
    const { dir } = fixture([], { summary: false, plan: false });
    w(dir, `${PHASE}/__proto__-PLAN.md`, plan('type: tdd'));
    w(dir, SEAL, `{"plans":{"__proto__":{"red":"${sha('a')}","green":"${sha('b')}"}}}`);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
  });

  test('--record seals a passing plan named __proto__ as its own entry', () => {
    const { dir } = fixture(['test(__proto__): red', 'feat(__proto__): green'], { summary: false, plan: false });
    w(dir, `${PHASE}/__proto__-PLAN.md`, plan('type: tdd'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'docs: plan');
    assert.equal(run(dir, '--record').payload.violations, 0);
    const sealed = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans;
    assert.deepEqual(Object.keys(sealed), ['__proto__']);
    assert.match(sealed.__proto__.red, /^[0-9a-f]{40}$/);
    assert.match(sealed.__proto__.green, /^[0-9a-f]{40}$/);
  });

  // True when the FIFO exists; otherwise skips the test. Runs through the seam's bash interpreter.
  function mkfifo(t, fifo) {
    const r = runHook('-c', ['mkfifo "$1"', '_', fifo], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env: isolatedEnv({ home: path.dirname(fifo) }) });
    if (r.exitCode === 0) return true;
    t.skip('mkfifo unavailable');
    return false;
  }

  // Hostile seals (CONTRIBUTING.md "Parser and project-file inputs"): no mutated seal is written by hand. A valid seal is built from git's own
  // answer in the documented shape (never from the gate's --record output), every key path of it is walked, and the checklist is applied to each path: a scalar where an object is
  // expected and an object where a string is expected, an array, null, a missing and an emptied member, a duplicated key, a NUL
  // or replacement character in a value or a key, a path-traversal-like key, and a truncated text. The walker derives every mutation path; only the valid seal is typed, in the documented shape.
  const SEALED_SQUASH = ['test(01-01): red', 'feat(01-01): green'];
  function pathsOf(node, prefix = []) {
    const children = node !== null && typeof node === 'object' ? Object.keys(node).flatMap((k) => pathsOf(node[k], [...prefix, k])) : [];
    return [prefix, ...children];
  }
  function at(root, p) {
    return p.reduce((n, k) => n[k], root);
  }
  function withValue(root, p, value) {
    if (p.length === 0) return value;
    const copy = structuredClone(root);
    at(copy, p.slice(0, -1))[p[p.length - 1]] = value;
    return copy;
  }
  function withoutKey(root, p) {
    const copy = structuredClone(root);
    delete at(copy, p.slice(0, -1))[p[p.length - 1]];
    return copy;
  }
  function withRenamedKey(root, p, name) {
    const copy = structuredClone(root);
    const parent = at(copy, p.slice(0, -1));
    const entries = Object.entries(parent).map(([k, v]) => [k === p[p.length - 1] ? name : k, v]);
    for (const k of Object.keys(parent)) delete parent[k];
    for (const [k, v] of entries) parent[k] = v;
    return copy;
  }
  // JSON text in which the member at `target` appears twice: JSON.parse keeps the last, so `after` decides which one wins.
  function stringifyDuplicated(node, target, wrong, after, here = []) {
    if (node === null || typeof node !== 'object') return JSON.stringify(node);
    const parts = [];
    for (const [k, v] of Object.entries(node)) {
      const child = [...here, k];
      const real = `${JSON.stringify(k)}:${stringifyDuplicated(v, target, wrong, after, child)}`;
      if (child.join('/') === target.join('/')) {
        const dup = `${JSON.stringify(k)}:${JSON.stringify(wrong)}`;
        parts.push(after ? real : dup, after ? dup : real);
      } else {
        parts.push(real);
      }
    }
    return `{${parts.join(',')}}`;
  }
  function kindOf(v) {
    return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  }
  const WRONG_TYPES = [1, 'x', true, [], null, {}];
  const SUFFIXES = ['\u0000', '�'];
  const TRAVERSAL = ['../../', '..\\'];

  function hostileSeals(valid) {
    const text = JSON.stringify(valid);
    const all = pathsOf(valid);
    const members = all.filter((p) => p.length > 0);
    const strings = all.filter((p) => typeof at(valid, p) === 'string');
    const out = [];
    // `unreadable` is the verdict the rule demands: a member of another type than the valid seal has, or a lost top-level member,
    // refuses the seal; everything else stays readable and must only never earn a credit.
    for (const p of all) {
      for (const wrong of WRONG_TYPES) {
        const unreadable = p.length === 0 || kindOf(wrong) !== kindOf(at(valid, p));
        out.push({ cls: 'wrong-type', label: `${p.join('/')} -> ${JSON.stringify(wrong)}`, text: JSON.stringify(withValue(valid, p, wrong)), unreadable });
      }
    }
    for (const p of members) out.push({ cls: 'missing', label: p.join('/'), text: JSON.stringify(withoutKey(valid, p)), unreadable: p.length === 1 });
    for (const p of strings) for (const suffix of SUFFIXES) out.push({ cls: 'value-char', label: p.join('/'), text: JSON.stringify(withValue(valid, p, at(valid, p) + suffix)) });
    for (const p of members) {
      for (const suffix of SUFFIXES) out.push({ cls: 'key-char', label: p.join('/'), text: JSON.stringify(withRenamedKey(valid, p, p[p.length - 1] + suffix)), unreadable: p.length === 1 });
      for (const prefix of TRAVERSAL) out.push({ cls: 'key-char', label: p.join('/'), text: JSON.stringify(withRenamedKey(valid, p, prefix + p[p.length - 1])), unreadable: p.length === 1 });
      out.push({ cls: 'duplicate-last-wins', label: p.join('/'), text: stringifyDuplicated(valid, p, 'x', true) });
      out.push({ cls: 'duplicate-first-loses', label: p.join('/'), text: stringifyDuplicated(valid, p, 'x', false) });
    }
    // every 7th cut, plus the cut one byte short of the whole text
    const cuts = new Set([text.length - 1]);
    for (let cut = 1; cut < text.length; cut += 7) cuts.add(cut);
    for (const cut of cuts) out.push({ cls: 'truncated', label: `at ${cut}`, text: text.slice(0, cut), unreadable: true });
    // a project file edited on Windows: no text, only blanks, a byte-order mark; and a valid seal with CRLF line endings
    for (const [label, bad] of [['empty', ''], ['whitespace', ' \r\n\t\n'], ['BOM', `\uFEFF${text}`]]) out.push({ cls: 'degenerate', label, text: bad, unreadable: true });
    out.push({ cls: 'crlf', label: 'valid seal, CRLF', text: `${JSON.stringify(valid, null, 2)}\n`.replace(/\n/g, '\r\n'), credited: true });
    return out;
  }

  test('a hostile seal derived from a documented-shape seal never crashes the gate and never earns a credit', () => {
    const { dir, base } = fixture(SEALED_SQUASH);
    // The valid seal is written from git's own answer, in the documented shape (plans.<id>.{red,green} full SHAs),
    // not read back from the gate's `--record`: the gate's writer is not the source of its own negative fixtures.
    const [redSha, greenSha] = git(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
    const valid = { plans: { '01-01': { red: redSha, green: greenSha } } };
    const validText = `${JSON.stringify(valid, null, 2)}\n`;
    fs.mkdirSync(path.join(dir, PHASE), { recursive: true });
    fs.writeFileSync(path.join(dir, SEAL), validText);
    sealCommit(dir);
    squash(dir, base);
    const seal = path.join(dir, SEAL);
    fs.writeFileSync(seal, validText);
    assert.equal(run(dir).payload.rows[0].status, 'Pass', 'the unmutated seal is credited');
    const seen = new Set();
    for (const { cls, label, text, unreadable, credited } of hostileSeals(valid)) {
      seen.add(cls);
      fs.writeFileSync(seal, text);
      const r = run(dir);
      const why = `${cls}: ${label}`;
      if (cls === 'duplicate-first-loses' || credited) {
        // the real member comes last and wins (or only the line endings differ), so the credit is the valid one
        assert.equal(r.payload.rows[0].status, 'Pass', why);
      } else if (r.outcome === 'unreadable') {
        assert.equal(run(dir, '--record').outcome, 'unreadable', why);
        assert.equal(fs.readFileSync(seal, 'utf8'), text, `${why}: --record leaves a refused seal untouched`);
      } else {
        assert.notEqual(r.payload.rows[0].status, 'Pass', `${why}: a hostile seal must not earn a credit`);
      }
      if (unreadable !== undefined) assert.equal(r.outcome === 'unreadable', unreadable, `${why}: unreadable verdict`);
    }
    assert.deepEqual([...seen].sort(), ['crlf', 'degenerate', 'duplicate-first-loses', 'duplicate-last-wins', 'key-char', 'missing', 'truncated', 'value-char', 'wrong-type']);
  });

  test('property: a sealed red hash is credited iff it is 40 lowercase hex and differs from green', () => {
    const { dir } = fixture([], { summary: false });
    const hex = fc.array(fc.constantFrom(...'0123456789abcdefABCDEFg'), { minLength: 38, maxLength: 42 }).map((a) => a.join(''));
    fc.assert(fc.property(fc.oneof(fc.string(), hex, fc.stringMatching(/^[0-9a-f]{40}$/), fc.constant(sha('b'))), (red) => {
      w(dir, SEAL, sealOf(red, sha('b')));
      return (run(dir).payload.rows[0].status === 'Pass') === (/^[0-9a-f]{40}$/.test(red) && red !== sha('b'));
    }));
  });

  test('property: --record keeps every other plan\'s entry byte for byte', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const entry = fc.record({ red: fc.string(), green: fc.string() });
    fc.assert(fc.property(fc.dictionary(fc.stringMatching(/^[a-z0-9.-]{1,8}$/), entry), (others) => {
      delete others['01-01'];
      w(dir, SEAL, JSON.stringify({ plans: others }));
      run(dir, '--record');
      const { plans } = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8'));
      return Object.entries(others).every(([k, v]) => JSON.stringify(plans[k]) === JSON.stringify(v)) && 'red' in plans['01-01'];
    }), { numRuns: 50 });
  });

  const GREEN_SHA = sha('b');
  const sealRedArb = fc.oneof(
    fc.stringMatching(/^[0-9a-f]{40}$/),
    fc.stringMatching(/^[0-9a-f]{39}$/),
    fc.stringMatching(/^[0-9a-f]{41}$/),
    fc.stringMatching(/^[0-9A-F]{40}$/),
    fc.constant(GREEN_SHA),
  );
  // The seal is consulted when its RED (else its GREEN) is gone (#5354): these sealed hashes name no object, so it always is. It credits each kind the live commits lack.
  for (const [name, subjects, liveRed, liveGreen] of [
    ['none', [], false, false],
    ['test only', ['test(01-01): red'], true, false],
    ['feat only', ['feat(01-01): green'], false, true],
    ['test then feat', ['test(01-01): red', 'feat(01-01): green'], true, true],
  ]) {
    test(`property: seal credit follows the squashed-seal rule (${name})`, () => {
      const { dir } = fixture(subjects, { summary: false });
      fc.assert(fc.property(sealRedArb, (red) => {
        fs.writeFileSync(path.join(dir, SEAL), sealOf(red, GREEN_SHA));
        const status = run(dir).payload.rows[0].status;
        const applies = red !== GREEN_SHA;
        const sealRed = /^[0-9a-f]{40}$/.test(red) && applies;
        return status === ((liveRed || sealRed) && (liveGreen || applies) ? 'Pass' : 'FAIL');
      }), { numRuns: 25 });
    });
  }

  test('the no-TDD skip is keyed on the picked tddPlans field', () => {
    const skip = fixture([], { summary: false, plan: false });
    const out = runGsdTools(['check', 'tdd-review-checkpoint', '1', '--pick', 'tddPlans'], skip.dir);
    assert.ok(out.success, out.error || out.output);
    assert.equal(out.output.trim(), '0');
  });

  test('the CLI router passes --record through and writes the seal', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const r = runGsdTools(['check', 'tdd-review-checkpoint', '1', '--record'], dir);
    assert.ok(r.success, r.error || r.output);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans['01-01']);
  });

  test('`check tdd.review-checkpoint 1 --record --pick tddPlans` seals and prints the picked count', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const r = runGsdTools(['check', 'tdd.review-checkpoint', '1', '--record', '--pick', 'tddPlans'], dir);
    assert.ok(r.success, r.error || r.output);
    assert.equal(r.output.trim(), '1');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans['01-01']);
  });

  // Execute ship.md's seal step against a stubbed `gsd_run`, so the branches (not their text) are what is tested.
  function runSealStep({ recordRc = 0, picked = '1', seal, ws = '', prepare, commitOut, commitRc = 0, subjects = [], real = false, checkIgnoreExit, statusExit }) {
    const ship = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md'), 'utf8').replace(/\r\n/g, '\n');
    const marker = ship.indexOf('<step name="seal_tdd_review">');
    assert.notEqual(marker, -1, 'ship.md has the seal_tdd_review step');
    const stepEnd = ship.indexOf('</step>', marker);
    assert.notEqual(stepEnd, -1, 'the seal step closes');
    const fence = ship.indexOf('```bash\n', marker);
    assert.ok(fence !== -1 && fence < stepEnd, 'the seal step opens its own bash fence');
    const from = fence + 8;
    const end = ship.indexOf('\n```', from);
    assert.ok(end !== -1 && end < stepEnd, 'the seal step closes its own bash fence');
    const script = ship.slice(from, end);
    const { dir } = fixture(subjects, { summary: false });
    const before = git(dir, 'log', '-1', '--format=%s');
    if (seal !== undefined) w(dir, SEAL, seal);
    if (prepare) prepare(dir);
    const calls = path.join(path.dirname(dir), `${path.basename(dir)}-calls`);
    dirs.push(calls);
    const home = `${dir}-home`;
    fs.mkdirSync(home);
    dirs.push(home);
    // `query commit` stands in for cmdCommit: it commits the seal itself unless COMMIT_OUT is set (then it prints that and commits nothing).
    const stub = real
      ? 'gsd_run() { node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "$@" >> "$CALLS"; node "$GSD_TOOLS_BIN" "$@"; }\n'
      : 'gsd_run() { node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "$@" >> "$CALLS"; case "$*" in "run-with-timeout "*) shift 3; case "$*" in "git check-ignore"*) if [ -n "${CHECK_IGNORE_EXIT+x}" ]; then return "$CHECK_IGNORE_EXIT"; fi;; "git status"*) if [ -n "${STATUS_EXIT+x}" ]; then return "$STATUS_EXIT"; fi;; esac; "$@"; return $?;; "query commit"*) if [ -n "${COMMIT_OUT+x}" ]; then echo "$COMMIT_OUT"; else git add "$SEAL" && git commit -q -m "$3" -- "$SEAL" && git rev-parse HEAD || return 1; fi; return "${COMMIT_RC:-0}";; *--record*) echo "$PICK"; return "$REC";; *) echo "$PICK";; esac; }\n';
    const r = runHook('-c', [stub + script], {
      interpreter: 'bash', cwd: dir, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      env: isolatedEnv({ home, override: { ...(commitOut === undefined ? {} : { COMMIT_OUT: commitOut }), ...(checkIgnoreExit === undefined ? {} : { CHECK_IGNORE_EXIT: String(checkIgnoreExit) }), ...(statusExit === undefined ? {} : { STATUS_EXIT: String(statusExit) }), COMMIT_RC: String(commitRc), GSD_TOOLS_BIN: path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), CALLS: calls, GSD_WS: ws, REC: String(recordRc), PICK: picked, PHASE_DIR: PHASE, PHASE_NUMBER: '1', padded_phase: '01', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }),
    });
    return { r, dir, before, subject: git(dir, 'log', '-1', '--format=%s'), calls: fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean).map((c) => JSON.parse(c)).filter((argv) => argv[0] !== 'run-with-timeout') };
  }

  // Each seal-step branch, with the text of ship.md's own message for it (defined once, taken from the step).
  const SEAL_BRANCH = {
    recordFailed: { marker: 'could not record the seal', exitCode: 0 },
    noSeal: { marker: 'TDD review failed or was not evaluable', exitCode: 0 },
    gitignored: { marker: 'the squash will not carry it', exitCode: 0 },
    gitTimedOut: { marker: 'git timed out while checking', exitCode: 0 },
    gitFailed: { marker: 'git failed while checking', exitCode: 0 },
    commitFailed: { marker: 'TDD seal commit failed', exitCode: 1 },
    commitSkipped: { marker: 'commit_docs resolves false', exitCode: 0 },
  };
  // The step took exactly this branch: its exit status, its message and no other branch's, and no seal commit.
  function expectBranchWarning({ r, subject, before }, branch) {
    assert.equal(r.exitCode, SEAL_BRANCH[branch].exitCode, r.stderr);
    for (const [name, { marker }] of Object.entries(SEAL_BRANCH)) {
      assert.equal(r.stderr.includes(marker), name === branch, `${branch}: stderr ${name === branch ? 'has' : 'lacks'} "${marker}": ${r.stderr}`);
    }
    assert.equal(subject, before);
  }
  function expectQuiet({ r, subject, before }) {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stderr.trim(), '');
    assert.equal(subject, before);
  }

  // The real commit owner: phase_commit_docs.<phase> beats the project-level commit_docs (#3587).
  function realSeal(config) {
    return runSealStep({
      real: true,
      subjects: ['test(01-01): red', 'feat(01-01): green'],
      prepare: (dir) => w(dir, '.planning/config.json', JSON.stringify(config)),
    });
  }

  // The seal step takes exactly one branch: each row names it, the options that reach it and what else must hold afterwards.
  const SEAL_AB = sealOf(sha('a'), sha('b'));
  const WARNINGS = [
    { name: 'the bounded git check-ignore times out', opts: { checkIgnoreExit: 124 }, branch: 'gitTimedOut' },
    ...[2, 127, 128].map((code) => ({ name: `the bounded git check-ignore exits ${code}`, opts: { checkIgnoreExit: code }, branch: 'gitFailed' })),
    // `git status` alone fails (the ignore check is clean); `git check-ignore` alone fails above: each bounded call carries its own branch.
    { name: 'only the bounded git status times out', opts: { statusExit: 124 }, branch: 'gitTimedOut' },
    { name: 'only the bounded git status fails', opts: { statusExit: 128 }, branch: 'gitFailed' },
    { name: '--record failed (the on-disk seal is never committed)', opts: { recordRc: 3, seal: '<<<<<<< conflict' }, branch: 'recordFailed' },
    { name: 'the commit owner skips (commit_docs resolves false)', opts: { commitOut: 'skipped' }, branch: 'commitSkipped' },
    { name: 'the commit owner exits non-zero', opts: { commitOut: '', commitRc: 3 }, branch: 'commitFailed' },
    { name: 'the commit owner reports failed', opts: { commitOut: 'failed' }, branch: 'commitFailed' },
    { name: 'the seal commit fails', opts: { prepare: (dir) => w(dir, '.git/index.lock', '') }, branch: 'commitFailed' },
    {
      name: 'the seal is gitignored',
      opts: { prepare: (dir) => { w(dir, '.gitignore', `${SEAL}\n`); git(dir, 'add', '.gitignore'); git(dir, 'commit', '--amend', '--no-edit'); } },
      branch: 'gitignored',
      after: (dir) => { assert.equal(fs.existsSync(path.join(dir, SEAL)), true); assert.equal(git(dir, 'status', '--porcelain', '--', SEAL), ''); },
    },
    { name: 'no seal file exists and the phase has tdd plans', opts: { seal: undefined, picked: '1' }, branch: 'noSeal', after: (dir) => assert.equal(fs.existsSync(path.join(dir, SEAL)), false) },
  ];
  for (const { name, opts, branch, after } of WARNINGS) {
    test(`ship.md seal step takes the ${branch} branch and commits nothing when ${name}`, posixOnly, () => {
      const result = runSealStep({ seal: SEAL_AB, ...opts });
      expectBranchWarning(result, branch);
      after?.(result.dir);
    });
  }

  test('ship.md seal step stays quiet and commits nothing for a seal that is already committed', posixOnly, () => {
    const result = runSealStep({ seal: SEAL_AB, prepare: (dir) => { git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'docs: seal'); } });
    assert.equal(result.r.exitCode, 0, result.r.stderr);
    assert.equal(result.r.stderr.trim(), '');
    assert.equal(result.subject, 'docs: seal');
    assert.equal(result.calls.some((argv) => argv[0] === 'query' && argv[1] === 'commit'), false, JSON.stringify(result.calls));
  });
  test('ship.md seal step stays quiet for a phase without tdd plans', posixOnly, () => {
    expectQuiet(runSealStep({ picked: '0' }));
  });

  test('ship.md seal step commits a dirty seal after a successful record, through the commit owner', posixOnly, () => {
    const { r, subject, calls } = runSealStep({ seal: SEAL_AB });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(subject, 'docs(01): seal TDD review evidence');
    const commitCall = calls.find((argv) => argv[0] === 'query' && argv[1] === 'commit');
    assert.deepEqual(commitCall?.slice(0, 5), ['query', 'commit', 'docs(01): seal TDD review evidence', '--files', SEAL], JSON.stringify(calls));
  });

  // User git config must not hide a new seal from the dirty check: with `status.showUntrackedFiles=no` a plain `git status` omits it.
  test('ship.md seal step commits a new seal when git is configured to hide untracked files', posixOnly, () => {
    const { r, subject } = runSealStep({ seal: SEAL_AB, prepare: (dir) => git(dir, 'config', 'status.showUntrackedFiles', 'no') });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(subject, 'docs(01): seal TDD review evidence');
  });

  test('ship.md seal step resolves the phase in the workstream ship resolved it in (#5354)', posixOnly, () => {
    const { calls } = runSealStep({ ws: '--ws ws1', seal: SEAL_AB });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'check');
    assert.ok(calls[0].includes('--record'), JSON.stringify(calls[0]));
    assert.deepEqual(calls[1].slice(0, 2), ['query', 'commit']);
    for (const argv of calls) assert.equal(argv.filter((a) => a === '--ws=ws1').length, 1, JSON.stringify(argv));
  });

  test('ship.md seal step commits the seal when the phase override is true and the project value false', posixOnly, () => {
    const { r, dir, subject } = realSeal({ commit_docs: false, phase_commit_docs: { '01': true } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(subject, 'docs(01): seal TDD review evidence');
    assert.equal(git(dir, 'status', '--porcelain', '--', SEAL), '');
  });

  test('ship.md seal step leaves the seal uncommitted when the phase override is false and the project value true', posixOnly, () => {
    const result = realSeal({ commit_docs: true, phase_commit_docs: { '01': false } });
    expectBranchWarning(result, 'commitSkipped');
    assert.equal(fs.existsSync(path.join(result.dir, SEAL)), true);
    assert.notEqual(git(result.dir, 'status', '--porcelain', '--', SEAL), '');
  });
});

/** The gate asks the sub-repos, not the workspace root, whether the sealed commits are gone and whether history is complete (#5354, #5867). */
describe('#5354 tdd review checkpoint in a planning.sub_repos workspace', () => {
  /** A workspace whose `app` sub-repo holds a RED and a GREEN on `feature`; the plan, the SUMMARY and (later) the seal live in the workspace root. */
  function workspace(root) {
    dirs.push(root);
    w(root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: ['app'] } }));
    w(root, `${PHASE}/01-01-PLAN.md`, plan('type: tdd'));
    w(root, `${PHASE}/01-01-SUMMARY.md`, '# done\n');
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    git(app, 'init', '-q');
    git(app, 'commit', '-q', '--allow-empty', '-m', 'docs: base');
    const base = git(app, 'rev-parse', 'HEAD');
    git(app, 'checkout', '-q', '-b', 'feature');
    for (const subject of ['test(01-01): red', 'feat(01-01): green']) {
      commit(app, `${subject.slice(0, 4)}.txt`, subject);
    }
    return { app, base };
  }

  test('a plan sealed and squashed away in the sub-repo passes under a workspace root that is no repo', () => {
    const root = createTempDir('gate-5354-ws-');
    const { app, base } = workspace(root);
    assert.equal(run(root, '--record').payload.rows[0].status, 'Pass', 'positive control: the live commits pass before the squash');
    squash(app, base);
    const after = run(root);
    assert.equal(after.payload.rows[0].status, 'Pass');
    assert.equal(after.payload.violations, 0);
    assert.equal(after.block, false);
  });

  test('a sealed plan squashed away in a shallow sub-repo under a complete root is not evaluable, not a pass', () => {
    const root = createTempGitProject('gate-5354-ws-');
    const { app, base } = workspace(root);
    run(root, '--record');
    squash(app, base);
    const origin = `${root}-origin`;
    dirs.push(origin);
    fs.renameSync(app, origin);
    cloneDepthOne(origin, app, 'merged');
    assert.equal(git(root, 'rev-parse', '--is-shallow-repository'), 'false', 'positive control: the root is complete');
    assert.equal(git(app, 'rev-parse', '--is-shallow-repository'), 'true', 'positive control: the sub-repo is shallow');
    const row = run(root).payload.rows[0];
    assert.equal(row.status, 'NotEvaluable');
    assert.equal(row.reason, TDD_ROW_REASON.SEALED_SHALLOW_HISTORY);
  });
});

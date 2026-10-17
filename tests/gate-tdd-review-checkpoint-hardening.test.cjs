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
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
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

describe('H2 the plan id is matched literally in the git --grep pattern', () => {
  // `*` and `?` are not valid in a Windows file name, so the POSIX-only ids are skipped there.
  const posixOnly = { skip: process.platform === 'win32' };

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
  const PHASE = '.planning/phases/01-x';
  const dirs = [];
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

  function sealGit(dir, ...a) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
      { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true }).trim();
  }
  function w(dir, rel, content) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  function commit(dir, file, msg) { w(dir, file, msg); sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', msg); }
  function fixture(subjects, { summary = true, refs = false } = {}) {
    const dir = createTempGitProject('gate-5354-');
    dirs.push(dir);
    w(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
    if (summary) w(dir, `${PHASE}/01-01-SUMMARY.md`, '# done\n');
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs: plans');
    const base = sealGit(dir, 'rev-parse', 'HEAD');
    sealGit(dir, 'checkout', '-b', 'feature');
    subjects.forEach((s, i) => commit(dir, `f${i}.txt`, s));
    if (refs) {
      const shas = sealGit(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
      w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n${shas.map((h, i) => `${i + 1}. **Task ${i + 1}: x** - \`${h}\``).join('\n')}\n`);
      sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs: summary');
    }
    return { dir, base };
  }
  function squash(dir, base, subject = 'feat: squashed') {
    sealGit(dir, 'checkout', '-b', 'merged', base);
    sealGit(dir, 'merge', '--squash', 'feature');
    sealGit(dir, 'commit', '-m', subject);
  }
  const run = (dir, ...args) => evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1', ...args] });

  test('a record written before the squash keeps the plan passing after git merge --squash', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const before = run(dir, '--record');
    assert.equal(before.payload.violations, 0);
    const seal = JSON.parse(fs.readFileSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json'), 'utf8'));
    assert.match(seal.plans['01-01'].red, /^[0-9a-f]{40}$/);
    assert.match(seal.plans['01-01'].green, /^[0-9a-f]{40}$/);
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base);
    const after = run(dir);
    assert.equal(after.payload.violations, 0);
    assert.equal(after.block, false);
    assert.equal(after.payload.rows[0].status, 'Pass');
  });

  test('no record and no reachable commits but a SUMMARY is not evaluable, not a failure', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    const r = run(dir);
    assert.equal(r.payload.violations, 0);
    assert.equal(r.block, false);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.match(r.payload.message, /not evaluable/);
  });

  test('a plan with reachable commits lacking test()/feat() still fails', () => {
    const { dir } = fixture(['docs(01-01): notes']);
    const r = run(dir);
    assert.equal(r.payload.violations, 1);
    assert.equal(r.block, true);
    assert.deepEqual(r.payload.rows[0].missing, ['RED', 'GREEN']);
  });

  test('no commits, no SUMMARY, no seal still fails', () => {
    const { dir } = fixture([], { summary: false });
    const r = run(dir);
    assert.equal(r.payload.violations, 1);
    assert.equal(r.payload.rows[0].status, 'FAIL');
  });

  test('--record writes nothing when the evaluation has a violation', () => {
    const { dir } = fixture(['test(01-01): red']);
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    assert.equal(fs.existsSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json')), false);
  });

  test('a malformed seal credits nothing', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, `${PHASE}/TDD-REVIEW-SEAL.json`, '{not json');
    assert.equal(run(dir).payload.violations, 1);
  });

  const SEAL = path.join(PHASE, 'TDD-REVIEW-SEAL.json');
  const sha = (c) => c.repeat(40);

  test('a scoped squash title with unreachable SUMMARY hashes is not evaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base, 'feat(01-01): squashed');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  test('an un-squashed plan whose SUMMARY hashes are reachable and has no test() fails', () => {
    const { dir } = fixture(['docs(01-01): notes'], { refs: true });
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.block, true);
  });

  test('a dependent plan feat() does not mask a missing RED', () => {
    const { dir } = fixture(['feat(01-02): green'], { summary: false });
    w(dir, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: execute\ndepends_on: [01-01]\n---\n');
    const r = run(dir);
    assert.deepEqual(r.payload.rows[0].missing, ['RED']);
    assert.equal(r.payload.rows[0].status, 'FAIL');
  });

  test('a seal with only red does not make the plan not evaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    w(dir, SEAL, JSON.stringify({ plans: { '01-01': { red: sha('a') } } }));
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'seal');
    squash(dir, base);
    assert.equal(run(dir).payload.rows[0].status, 'FAIL');
  });

  test('a seal entry with red equal to green is ignored', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, SEAL, JSON.stringify({ plans: { '01-01': { red: sha('a'), green: sha('a') } } }));
    assert.equal(run(dir).payload.rows[0].status, 'FAIL');
  });

  test('--record keeps seal entries of other plans', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    w(dir, SEAL, JSON.stringify({ plans: { '01-99': { red: sha('b'), green: sha('c') } } }));
    run(dir, '--record');
    const plans = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans;
    assert.deepEqual(Object.keys(plans).sort(), ['01-01', '01-99']);
  });

  test('--record that cannot write reports unreadable instead of throwing', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    fs.mkdirSync(path.join(dir, SEAL));
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
  });

  test('the review table keeps NotEvaluable inside its column', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    assert.match(run(dir).payload.table, /\| NotEvaluable \|/);
    assert.match(run(dir).payload.table, /\|--------------\|/);
  });
});

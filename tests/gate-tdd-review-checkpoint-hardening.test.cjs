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
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { runHook } = require('./helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

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

  const sealGit = (dir, ...a) => gitOrThrow(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir }).trim();
  function w(dir, rel, content) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  function commit(dir, file, msg) { w(dir, file, msg); sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', msg); }
  function fixture(subjects, { summary = true, refs = false, plan = true } = {}) {
    const dir = createTempGitProject('gate-5354-');
    dirs.push(dir);
    if (!plan) w(dir, `${PHASE}/.keep`, '');
    if (plan) w(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
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

  test('--record writes nothing when no plan passes', () => {
    const { dir } = fixture(['test(01-01): red']);
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    assert.equal(fs.existsSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json')), false);
  });

  test('a malformed seal is unreadable, never an advisory "no entry (squashed?)"', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, `${PHASE}/TDD-REVIEW-SEAL.json`, '{not json');
    const r = run(dir);
    assert.equal(r.outcome, 'unreadable');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.deepEqual(r.payload.rows, []);
  });

  for (const [label, text] of [['plans a string', '{"plans":"x"}'], ['plans an array', '{"plans":[{"red":"a"}]}'], ['null', 'null'], ['an array', '[]'], ['a string', '"s"'], ['no plans member', '{"foo":1}'], ['a plan entry a string', '{"plans":{"01-01":"x"}}'], ['a plan entry with a numeric red', '{"plans":{"01-01":{"red":1}}}']]) {
    test(`a wrong-shape seal (${label}) is unreadable and --record does not overwrite it`, () => {
      const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
      w(dir, `${PHASE}/TDD-REVIEW-SEAL.json`, text);
      assert.equal(run(dir).outcome, 'unreadable');
      assert.equal(run(dir, '--record').outcome, 'unreadable');
      assert.equal(fs.readFileSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json'), 'utf8'), text);
    });
  }

  const SEAL = path.join(PHASE, 'TDD-REVIEW-SEAL.json');
  const sha = (c) => c.repeat(40);

  test('fabricated SUMMARY ids (no such object) are NotEvaluable, indistinguishable from a squashed-and-collected commit', () => {
    const none = fixture(['chore: x']);
    w(none.dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${'d'.repeat(40)}\`\n`);
    assert.equal(run(none.dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('an oversize SUMMARY is not read (treated as no task commits)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    w(dir, `${PHASE}/01-01-SUMMARY.md`, padTo('# done\n', SEAL_CAP + 1));
    assert.equal(run(dir).payload.rows[0].status, 'FAIL');
  });

  test('a scoped squash title with unreachable SUMMARY hashes is not evaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base, 'feat(01-01): squashed');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  test('a squash whose title repeats one task subject is still not evaluable (a rewrite keeps every task subject)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base, 'feat(01-01): green');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  test('a rebased plan whose SUMMARY hashes are unreachable but whose commits are still reachable fails, not evaluable', () => {
    const { dir, base } = fixture(['docs(01-01): notes'], { refs: true });
    sealGit(dir, 'checkout', '-b', 'rebased', base);
    commit(dir, 'f0.txt', 'docs(01-01): notes');
    w(dir, 'f0.txt', 'different content');
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '--amend', '-m', 'docs(01-01): notes');
    sealGit(dir, 'checkout', 'feature', '--', `${PHASE}/01-01-SUMMARY.md`);
    sealGit(dir, 'commit', '-m', 'docs: summary');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.violations, 1);
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

  test('--record refuses to overwrite a malformed seal and leaves it untouched', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    w(dir, SEAL, '{not json');
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), '{not json');
  });

  test('--record reports unreadable when the seal cannot be examined (lstat fails, not ENOENT)', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (f, ...rest) => {
      if (String(f).endsWith('TDD-REVIEW-SEAL.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real(f, ...rest);
    });
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.equal(fs.existsSync(path.join(dir, SEAL)), false);
  });

  test('--record seals the passing plans even when a sibling plan fails', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    w(dir, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: tdd\n---\n# Plan\n');
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    const { plans } = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8'));
    assert.ok(plans['01-01']);
    assert.equal(plans['01-02'], undefined);
  });

  test('the review table keeps NotEvaluable inside its column', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    const statusCells = run(dir).payload.table.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|').at(-2));
    assert.equal(new Set(statusCells.map((cell) => cell.length)).size, 1, 'header, divider and rows share one status-column width');
  });

  const posix = { skip: process.platform === 'win32' };
  const SEAL_CAP = 64 * 1024;
  const sealOf = (red, green) => JSON.stringify({ plans: { '01-01': { red, green } } });
  const padTo = (text, size) => text + ' '.repeat(size - Buffer.byteLength(text));

  test('a symlinked seal is refused and its target is never written', posix, () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, path.join(dir, SEAL));
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  });

  test('a symlinked seal credits nothing on read', posix, () => {
    const { dir } = fixture([], { summary: false });
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, sealOf(sha('a'), sha('b')));
    fs.symlinkSync(outside, path.join(dir, SEAL));
    assert.equal(run(dir).outcome, 'unreadable');
  });

  test('a symlinked seal is refused at open even if lstat is made to lie (no check-to-read window)', posix, (t) => {
    const { dir } = fixture([], { summary: false });
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, sealOf(sha('a'), sha('b')));
    fs.symlinkSync(outside, path.join(dir, SEAL));
    t.mock.method(fs, 'lstatSync', () => fs.statSync(outside));
    assert.equal(run(dir).outcome, 'unreadable');
  });

  test('a FIFO seal is rejected by the lstat regular-file check', posix, (t) => {
    const { dir } = fixture([], { summary: false });
    const fifo = path.join(dir, SEAL);
    // No seam runner for arbitrary binaries (runNode/runGit/runHook only), so mkfifo stays on execFileSync.
    try { execFileSync('mkfifo', [fifo], { timeout: GIT_TIMEOUT_MS }); } catch { t.skip('mkfifo unavailable'); return; }
    assert.equal(run(dir).outcome, 'unreadable');
  });

  test('a FIFO swapped in after lstat never hangs the open (O_NONBLOCK) and fstat rejects it', posix, (t) => {
    const { dir } = fixture([], { summary: false });
    const fifo = path.join(dir, SEAL);
    // No seam runner for arbitrary binaries (runNode/runGit/runHook only), so mkfifo stays on execFileSync.
    try { execFileSync('mkfifo', [fifo], { timeout: GIT_TIMEOUT_MS }); } catch { t.skip('mkfifo unavailable'); return; }
    const regular = path.join(dir, 'regular.json');
    fs.writeFileSync(regular, sealOf(sha('a'), sha('b')));
    // lstat lies (as if the FIFO replaced a regular file after the check), so only open()+fstat stand between us and a hang.
    t.mock.method(fs, 'lstatSync', () => fs.statSync(regular));
    assert.equal(run(dir).outcome, 'unreadable');
  });

  test('a close() failure on the seal is reported unreadable, not thrown', (t) => {
    const { dir } = fixture([], { summary: false });
    w(dir, SEAL, sealOf(sha('a'), sha('b')));
    t.mock.method(fs, 'closeSync', () => { throw Object.assign(new Error('close failed'), { code: 'EIO' }); });
    assert.equal(run(dir).outcome, 'unreadable');
  });

  // Each distinct SUMMARY hash costs one `git merge-base` spawn, so the count is capped (64).
  const REFS_CAP = 64;
  for (const [label, count, status] of [['limit-1', REFS_CAP - 1, 'NotEvaluable'], ['limit', REFS_CAP, 'NotEvaluable'], ['limit+1', REFS_CAP + 1, 'FAIL']]) {
    test(`SUMMARY with ${label} (${count}) distinct unreachable task commits -> ${status}`, () => {
      const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
      const hashes = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(40, 'f'));
      w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n${hashes.map((h, i) => `${i + 1}. **Task ${i + 1}: x** - \`${h}\``).join('\n')}\n`);
      sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs: summary');
      squash(dir, base);
      assert.equal(run(dir).payload.rows[0].status, status);
    });
  }

  test('a duplicated SUMMARY hash counts once against the cap', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const rows = Array.from({ length: REFS_CAP + 1 }, (_, i) => `${i + 1}. **Task ${i + 1}: x** - \`${'e'.repeat(40)}\``);
    w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n${rows.join('\n')}\n`);
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs: summary');
    squash(dir, base);
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('a seal with two distinct non-hex values credits nothing and stays NotEvaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    fs.writeFileSync(path.join(dir, SEAL), sealOf('zz', 'yy'));
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('--record into an unwritable phase directory reports unreadable', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (f, ...rest) => {
      if (String(f).includes('TDD-REVIEW-SEAL.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real(f, ...rest);
    });
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
  });

  test('a failed --record leaves no temp file behind', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.writeFileSync;
    let wrote = false;
    t.mock.method(fs, 'writeFileSync', (f, ...rest) => { if (String(f).endsWith('.tmp')) wrote = true; return real(f, ...rest); });
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('rename failed'), { code: 'EPERM' }); });
    run(dir, '--record');
    assert.ok(wrote, 'the temp file was created before the rename failed');
    assert.deepEqual(fs.readdirSync(path.join(dir, PHASE)).filter((n) => n.endsWith('.tmp')), []);
  });

  for (const [label, size, status] of [['limit-1', SEAL_CAP - 1, 'Pass'], ['limit', SEAL_CAP, 'Pass'], ['limit+1', SEAL_CAP + 1, 'unreadable']]) {
    test(`seal size ${label} (${size} bytes) -> ${status}`, () => {
      const { dir } = fixture([], { summary: false });
      w(dir, SEAL, padTo(sealOf(sha('a'), sha('b')), size));
      const r = run(dir);
      assert.equal(status === 'unreadable' ? r.outcome : r.payload.rows[0].status, status);
    });
  }

  for (const [label, hash, status] of [
    ['39 hex', 'a'.repeat(39), 'FAIL'], ['40 hex', 'a'.repeat(40), 'Pass'], ['41 hex', 'a'.repeat(41), 'FAIL'], ['uppercase', 'A'.repeat(40), 'FAIL'],
  ]) {
    test(`sealed red hash: ${label} -> ${status}`, () => {
      const { dir } = fixture([], { summary: false });
      w(dir, SEAL, sealOf(hash, sha('b')));
      assert.equal(run(dir).payload.rows[0].status, status);
    });
  }

  test('property: a sealed red hash is credited iff it is 40 lowercase hex and differs from green', () => {
    const { dir } = fixture([], { summary: false });
    const hex = fc.array(fc.constantFrom(...'0123456789abcdefABCDEFg'), { minLength: 38, maxLength: 42 }).map((a) => a.join(''));
    fc.assert(fc.property(fc.oneof(fc.string(), hex, fc.constant(sha('b'))), (red) => {
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

  test('a __proto__ seal key credits nothing and does not crash', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, SEAL, `{"plans":{"__proto__":{"red":"${sha('a')}","green":"${sha('b')}"}}}`);
    const r = run(dir, '--record');
    assert.equal(r.payload.rows[0].status, 'FAIL');
  });

  test('the no-TDD skip is keyed on the picked tddPlans field', () => {
    const skip = fixture([], { summary: false, plan: false });
    const out = runGsdTools(['check', 'tdd-review-checkpoint', '1', '--pick', 'tddPlans'], skip.dir);
    assert.ok(out.success, out.error || out.output);
    assert.equal(out.output.trim(), '0');
  });

  // Execute ship.md's seal step against a stubbed `gsd_run`, so the branches (not their text) are what is tested.
  function runSealStep({ commitDocs = 'true', recordRc = 0, picked = '1', seal }) {
    const ship = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md'), 'utf8').replace(/\r\n/g, '\n');
    const from = ship.indexOf('```bash\n', ship.indexOf('<step name="seal_tdd_review">')) + 8;
    const script = ship.slice(from, ship.indexOf('\n```', from));
    const { dir } = fixture([], { summary: false });
    if (seal !== undefined) w(dir, SEAL, seal);
    const stub = 'gsd_run() { case "$*" in "query config-get commit_docs"*) echo "$CD";; *--record*) echo "$PICK"; return "$REC";; *) echo "$PICK";; esac; }\n';
    const r = runHook('-c', [stub + script], {
      interpreter: 'bash', cwd: dir, timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, CD: commitDocs, REC: String(recordRc), PICK: picked, PHASE_DIR: PHASE, PHASE_NUMBER: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    });
    return { r, subject: sealGit(dir, 'log', '-1', '--format=%s') };
  }

  test('ship.md seal step commits a dirty seal after a successful record', posix, () => {
    const { r, subject } = runSealStep({ seal: sealOf(sha('a'), sha('b')) });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(subject, /^docs\(1\): seal TDD review evidence$/);
  });

  test('ship.md seal step never commits the on-disk seal when --record failed', posix, () => {
    const { r, subject } = runSealStep({ recordRc: 3, seal: '<<<<<<< conflict' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /could not record/);
    assert.equal(subject, 'docs: plans');
  });

  test('ship.md seal step with commit_docs false warns only when the phase has tdd plans', posix, () => {
    assert.match(runSealStep({ commitDocs: 'false', picked: '2' }).r.stderr, /commit_docs is false/);
    assert.doesNotMatch(runSealStep({ commitDocs: 'false', picked: '0' }).r.stderr, /commit_docs is false/);
  });

  test('the CLI router passes --record through and writes the seal', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const r = runGsdTools(['check', 'tdd-review-checkpoint', '1', '--record'], dir);
    assert.ok(r.success, r.error || r.output);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans['01-01']);
  });

  test('the real ship.md invocation (--record --pick tddPlans) seals and prints the picked count', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const r = runGsdTools(['check', 'tdd.review-checkpoint', '1', '--record', '--pick', 'tddPlans'], dir);
    assert.ok(r.success, r.error || r.output);
    assert.equal(r.output.trim(), '1');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans['01-01']);
  });

  test('a shallow clone cannot tell squashed from un-squashed: an un-squashed skipper still FAILs', () => {
    const { dir } = fixture(['docs(01-01): notes'], { refs: true });
    const clone = path.join(path.dirname(dir), `${path.basename(dir)}-shallow`);
    sealGit(path.dirname(dir), 'clone', '--depth', '1', '-q', pathToFileURL(dir).href, clone);
    dirs.push(clone);
    const r = run(clone);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.block, true);
  });

  test('outside a git repository an un-squashed skipper still FAILs', () => {
    const { dir } = fixture(['docs(01-01): notes'], { refs: true });
    const bare = path.join(path.dirname(dir), `${path.basename(dir)}-nogit`);
    fs.cpSync(path.join(dir, '.planning'), path.join(bare, '.planning'), { recursive: true });
    dirs.push(bare);
    assert.equal(run(bare).payload.rows[0].status, 'FAIL');
  });
});

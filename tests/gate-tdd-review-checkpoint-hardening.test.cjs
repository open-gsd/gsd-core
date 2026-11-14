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
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const { SUMMARY_REFS_MAX, REPO_TEXT_MAX_BYTES } = require('../gsd-core/bin/lib/gate-tdd-review-seal.cjs');
const { evaluateTddReviewCheckpoint, TDD_ROW_REASON } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

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

  test('a sealed plan squashed under a plan-scoped title passes (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    run(dir, '--record');
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base, 'feat(01-01): phase one');
    const after = run(dir);
    assert.equal(after.payload.rows[0].status, 'Pass');
    assert.equal(after.payload.violations, 0);
    assert.equal(after.block, false);
  });

  test('a sealed scoped squash followed by fix(01-01): typo still passes (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    run(dir, '--record');
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base, 'feat(01-01): phase one');
    commit(dir, 'typo.txt', 'fix(01-01): typo');
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
  });

  test('no record and no reachable commits but a SUMMARY is not evaluable, not a failure', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    const r = run(dir);
    assert.equal(r.payload.violations, 0);
    assert.equal(r.block, false);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.rows[0].reason, 'unsealed_summary_unreachable');
    assert.match(r.payload.message, /no TDD-REVIEW-SEAL\.json entry exists/);
    assert.equal(r.outcome, 'advisory');
  });

  // A git call that gives no answer is not "squashed": the plan stays an ordinary failure.
  const GIT_NO_ANSWER = { exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null, timedOut: false };
  function failGit(t, matches, result) {
    const shell = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const real = shell.execGit;
    t.mock.method(shell, 'execGit', (args, opts) => (matches(args) ? result : real(args, opts)));
  }

  test('a timed-out object lookup for a SUMMARY commit is a failure, not "squashed" (#5354)', (t) => {
    const { dir } = fixture([], { summary: false });
    w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${'a'.repeat(40)}\`\n`);
    failGit(t, (args) => args.includes('--verify'), { ...GIT_NO_ANSWER, exitCode: 1, signal: 'SIGTERM', timedOut: true });
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.violations, 1);
  });

  test('a subject listing git cannot deliver is a failure, not "squashed" (#5354)', (t) => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    failGit(t, (args) => args[0] === 'log' && args.includes('--no-walk=unsorted') && args.some((a) => a.includes('%P')), GIT_NO_ANSWER);
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.violations, 1);
  });

  test('a sealed pair with red equal to green in a shallow clone is a failure, not "sealed_shallow_history" (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    squash(dir, base);
    w(dir, SEAL, sealOf(sha('a'), sha('a')));
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs: seal');
    const clone = path.join(path.dirname(dir), `${path.basename(dir)}-shallow-equal`);
    dirs.push(clone);
    gitOrThrow(['clone', '-q', '--depth', '1', '--branch', 'merged', pathToFileURL(dir).href, clone], { cwd: path.dirname(dir) });
    const row = run(clone).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['RED', 'GREEN']);
  });

  test('two plans in one run probe the shallow-clone state once', (t) => {
    const { dir } = fixture([], { summary: false });
    const fake = (c) => `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${c.repeat(40)}\`\n`;
    w(dir, `${PHASE}/01-01-SUMMARY.md`, fake('a'));
    w(dir, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: tdd\n---\n# Plan\n');
    w(dir, `${PHASE}/01-02-SUMMARY.md`, fake('b'));
    const shell = require('../gsd-core/bin/lib/shell-command-projection.cjs');
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

  test('tdd.md names every row reason the gate can emit', () => {
    const tdd = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md'), 'utf8');
    const owner = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'references', 'execute-mvp-tdd.md'), 'utf8');
    for (const reason of Object.values(TDD_ROW_REASON)) assert.ok(tdd.includes(reason), reason);
    for (const reason of [TDD_ROW_REASON.SEALED_SHALLOW_HISTORY, TDD_ROW_REASON.UNSEALED_SUMMARY_UNREACHABLE]) assert.ok(owner.includes(reason), `owner: ${reason}`);
    assert.ok(owner.includes(`${SUMMARY_REFS_MAX} distinct task commits`), 'owner states SUMMARY_REFS_MAX');
    assert.ok(owner.includes(`${REPO_TEXT_MAX_BYTES / 1024} KiB`), 'owner states REPO_TEXT_MAX_BYTES');
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

  // Hostile seals (CONTRIBUTING.md "Parser and project-file inputs"): none is written by hand. A valid seal is taken from the gate's
  // own --record output, every key path of it is walked, and the checklist is applied to each path: a scalar where an object is
  // expected and an object where a string is expected, an array, null, a missing and an emptied member, a duplicated key, a NUL
  // or replacement character in a value or a key, a path-traversal-like key, and a truncated text. No key name is typed here.
  const SEALED_SQUASH = ['test(01-01): red', 'feat(01-01): green'];
  const pathsOf = (node, prefix = []) => [prefix, ...(node !== null && typeof node === 'object'
    ? Object.keys(node).flatMap((k) => pathsOf(node[k], [...prefix, k]))
    : [])];
  const at = (root, p) => p.reduce((n, k) => n[k], root);
  const withValue = (root, p, value) => {
    if (p.length === 0) return value;
    const copy = structuredClone(root);
    at(copy, p.slice(0, -1))[p[p.length - 1]] = value;
    return copy;
  };
  const withoutKey = (root, p) => {
    const copy = structuredClone(root);
    delete at(copy, p.slice(0, -1))[p[p.length - 1]];
    return copy;
  };
  const withRenamedKey = (root, p, name) => {
    const copy = structuredClone(root);
    const parent = at(copy, p.slice(0, -1));
    const entries = Object.entries(parent).map(([k, v]) => [k === p[p.length - 1] ? name : k, v]);
    for (const k of Object.keys(parent)) delete parent[k];
    for (const [k, v] of entries) parent[k] = v;
    return copy;
  };
  // JSON text in which the member at `target` appears twice: JSON.parse keeps the last, so `after` decides which one wins.
  const stringifyDuplicated = (node, target, wrong, after, here = []) => {
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
  };
  const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
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
    for (let cut = 1; cut < text.length; cut += 7) out.push({ cls: 'truncated', label: `at ${cut}`, text: text.slice(0, cut), unreadable: true });
    return out;
  }

  test('a hostile seal derived from a documented-shape seal never crashes the gate and never earns a credit', () => {
    const { dir, base } = fixture(SEALED_SQUASH);
    // The valid seal is written from git's own answer, in the documented shape (plans.<id>.{red,green} full SHAs),
    // not read back from the gate's `--record`: the gate's writer is not the source of its own negative fixtures.
    const [redSha, greenSha] = sealGit(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
    const valid = { plans: { '01-01': { red: redSha, green: greenSha } } };
    const validText = `${JSON.stringify(valid, null, 2)}\n`;
    fs.mkdirSync(path.join(dir, PHASE), { recursive: true });
    fs.writeFileSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json'), validText);
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base);
    const seal = path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json');
    fs.writeFileSync(seal, validText);
    assert.equal(run(dir).payload.rows[0].status, 'Pass', 'the unmutated seal is credited');
    const seen = new Set();
    for (const { cls, label, text, unreadable } of hostileSeals(valid)) {
      seen.add(cls);
      fs.writeFileSync(seal, text);
      const r = run(dir);
      const why = `${cls}: ${label}`;
      if (cls === 'duplicate-first-loses') {
        // the real member comes last and wins, so the credit is the valid one
        assert.equal(r.payload.rows[0].status, 'Pass', why);
      } else if (r.outcome === 'unreadable') {
        assert.equal(run(dir, '--record').outcome, 'unreadable', why);
        assert.equal(fs.readFileSync(seal, 'utf8'), text, `${why}: --record leaves a refused seal untouched`);
      } else {
        assert.notEqual(r.payload.rows[0].status, 'Pass', `${why}: a hostile seal must not earn a credit`);
      }
      if (unreadable !== undefined) assert.equal(r.outcome === 'unreadable', unreadable, `${why}: unreadable verdict`);
    }
    assert.deepEqual([...seen].sort(), ['duplicate-first-loses', 'duplicate-last-wins', 'key-char', 'missing', 'truncated', 'value-char', 'wrong-type']);
  });

  const SEAL = path.join(PHASE, 'TDD-REVIEW-SEAL.json');
  const sha = (c) => c.repeat(40);
  const SEAL_CAP = REPO_TEXT_MAX_BYTES;
  const padTo = (text, size) => text + ' '.repeat(size - Buffer.byteLength(text));

  test('fabricated SUMMARY ids (no such object) are NotEvaluable, indistinguishable from a squashed-and-collected commit', () => {
    const none = fixture(['chore: x']);
    w(none.dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${'d'.repeat(40)}\`\n`);
    assert.equal(run(none.dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('a seal whose RED is still reachable credits nothing: live commits that lack GREEN fail (#5354)', () => {
    const { dir } = fixture(['test(01-01): red']);
    w(dir, SEAL, sealOf(sealGit(dir, 'rev-parse', 'HEAD'), sha('b')));
    const row = run(dir).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['GREEN']);
  });

  // A squash may itself be titled test(<plan>): or be followed by such a commit: the squash is told by the seal's RED no longer being reachable.
  for (const [label, squashTitle, after] of [
    ['a test(01-01): squash title', 'test(01-01): phase one', []],
    ['a later test(01-01): commit', 'feat(01-01): phase one', ['test(01-01): add case']],
  ]) {
    test(`a sealed plan squashed with ${label} still passes (#5354)`, () => {
      const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
      run(dir, '--record');
      sealGit(dir, 'add', '-A');
      sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
      squash(dir, base, squashTitle);
      after.forEach((s, i) => commit(dir, `after${i}.txt`, s));
      const r = run(dir);
      assert.equal(r.payload.rows[0].status, 'Pass');
      assert.equal(r.block, false);
    });
  }

  test('--record after a test(01-01): squash writes the sealed RED back, so the next run still passes (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    run(dir, '--record');
    const sealed = fs.readFileSync(path.join(dir, SEAL), 'utf8');
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base, 'test(01-01): phase one');
    commit(dir, 'later.txt', 'test(01-01): add case');
    assert.equal(run(dir, '--record').payload.rows[0].status, 'Pass');
    assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), sealed);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
  });

  test('a shallow clone does not read an absent seal RED as squashed: a live RED without GREEN still fails (#5354)', () => {
    const { dir } = fixture(['test(01-01): red']);
    const clone = path.join(path.dirname(dir), `${path.basename(dir)}-shallow`);
    dirs.push(clone);
    gitOrThrow(['clone', '-q', '--depth', '1', pathToFileURL(dir).href, clone], { cwd: path.dirname(dir) });
    w(clone, SEAL, sealOf(sha('a'), sha('b')));
    const row = run(clone).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['GREEN']);
  });

  test('a plan without a live RED whose seal names reachable commits credits nothing (#5354)', () => {
    const { dir } = fixture(['docs(01-01): notes']);
    w(dir, SEAL, sealOf(sealGit(dir, 'rev-parse', 'HEAD'), sealGit(dir, 'rev-parse', 'HEAD~1')));
    const row = run(dir).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['RED', 'GREEN']);
  });

  test('a collision on the temp file leaves the prior seal and no temp file', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const prior = JSON.stringify({ plans: { '01-99': { red: sha('a'), green: sha('b') } } });
    w(dir, SEAL, prior);
    const real = fs.openSync;
    t.mock.method(fs, 'openSync', (f, ...rest) => {
      if (String(f).includes('.tmp.')) throw Object.assign(new Error('temp file exists'), { code: 'EEXIST' });
      return real(f, ...rest);
    });
    assert.equal(run(dir, '--record').outcome, 'unreadable');
    assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), prior);
    assert.deepEqual(fs.readdirSync(path.join(dir, PHASE)).filter((n) => n.includes('.tmp')), []);
  });

  test('a sealed squashed plan in a shallow clone is not evaluable, not a failure (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    run(dir, '--record');
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base);
    const clone = path.join(path.dirname(dir), `${path.basename(dir)}-shallow-sealed`);
    dirs.push(clone);
    gitOrThrow(['clone', '-q', '--depth', '1', '--branch', 'merged', pathToFileURL(dir).href, clone], { cwd: path.dirname(dir) });
    const r = run(clone);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.rows[0].reason, 'sealed_shallow_history');
    assert.match(r.payload.message, /sealed commits cannot be verified because the history is incomplete/);
    assert.doesNotMatch(r.payload.message, /no TDD-REVIEW-SEAL\.json entry exists/);
    assert.equal(r.block, false);
  });

  test('a shallow marker over a warm object store does not make an existing seal commit gone (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    run(dir, '--record');
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
    w(dir, '.git/shallow', `${sealGit(dir, 'rev-parse', 'HEAD')}\n`);
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('a seal holding only a sibling plan entry does not rule out NotEvaluable (#5354)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    w(dir, SEAL, JSON.stringify({ plans: { '01-99': { red: sha('a'), green: sha('b') } } }));
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  // The Task Commits section comes first so an unread SUMMARY (FAIL) is told from a read one (NotEvaluable).
  for (const [label, size, status] of [['limit-1', SEAL_CAP - 1, 'NotEvaluable'], ['limit', SEAL_CAP, 'NotEvaluable'], ['limit+1', SEAL_CAP + 1, 'FAIL']]) {
    test(`a SUMMARY at ${label} bytes is ${status === 'FAIL' ? 'not read (no task commits)' : 'still read'}`, () => {
      const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
      squash(dir, base);
      const summary = path.join(dir, PHASE, '01-01-SUMMARY.md');
      fs.writeFileSync(summary, padTo(fs.readFileSync(summary, 'utf8'), size));
      assert.equal(run(dir).payload.rows[0].status, status);
    });
  }

  test('a scoped squash title without a seal fails (live plan commit, nothing sealed)', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base, 'feat(01-01): squashed');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.deepEqual(r.payload.rows[0].missing, ['RED']);
  });

  test('a squash whose title repeats one task subject is still not evaluable (a rewrite keeps every task subject)', () => {
    const { dir, base } = fixture(['chore: red', 'chore: green'], { refs: true });
    squash(dir, base, 'chore: green');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  const ghostSummary = (dir) => w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${'d'.repeat(40)}\`\n`);

  test('a plan with only a docs commit and a SUMMARY naming a nonexistent id fails (live plan commit)', () => {
    const { dir } = fixture(['docs(01-01): notes']);
    ghostSummary(dir);
    const row = run(dir).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['RED', 'GREEN']);
  });

  test('a live RED and a SUMMARY naming a nonexistent id fails missing GREEN (live evidence is never overridden)', () => {
    const { dir } = fixture(['test(01-01): red']);
    ghostSummary(dir);
    const row = run(dir).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['GREEN']);
  });

  test('unscoped commits cherry-picked onto a moved base are a rewrite, not a squash: FAIL', () => {
    const { dir, base } = fixture(['chore: a', 'chore: b'], { refs: true });
    sealGit(dir, 'checkout', '-b', 'rebased', base);
    commit(dir, 'moved.txt', 'chore: moved base');
    sealGit(dir, 'cherry-pick', `${base}..feature`);
    const row = run(dir).payload.rows[0];
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['RED', 'GREEN']);
  });

  test('a seal entry that credits nothing still rules out NotEvaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    fs.writeFileSync(path.join(dir, SEAL), sealOf(sha('a'), sha('a')));
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.payload.rows.filter((row) => row.status === 'NotEvaluable').length, 0);
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
  const sealOf = (red, green) => JSON.stringify({ plans: { '01-01': { red, green } } });

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

  // True when the FIFO exists; otherwise skips the test. Runs through the seam's bash interpreter.
  function mkfifo(t, fifo) {
    const r = runHook('-c', ['mkfifo "$1"', '_', fifo], { interpreter: 'bash', timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode === 0) return true;
    t.skip('mkfifo unavailable');
    return false;
  }

  test('a FIFO seal never hangs the open (O_NONBLOCK) and fstat rejects it as not a regular file', posix, (t) => {
    const { dir } = fixture([], { summary: false });
    const fifo = path.join(dir, SEAL);
    if (!mkfifo(t, fifo)) return;
    assert.equal(run(dir).outcome, 'unreadable');
  });

  // The primary SUMMARY is unreadable, so a later candidate name must not turn the plan into NotEvaluable (execute-mvp-tdd.md: ordinary failure).
  for (const [label, opts, damage] of [
    ['symlinked', posix, (dir, summary) => { const real = path.join(dir, 'real-summary.md'); fs.renameSync(summary, real); fs.symlinkSync(real, summary); }],
    ['oversized', {}, (dir, summary) => fs.writeFileSync(summary, padTo(fs.readFileSync(summary, 'utf8'), REPO_TEXT_MAX_BYTES + 1))],
  ]) {
    test(`a ${label} primary SUMMARY fails even when a later candidate name holds task commits`, opts, () => {
      const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
      squash(dir, base);
      const summary = path.join(dir, PHASE, '01-01-SUMMARY.md');
      fs.copyFileSync(summary, path.join(dir, PHASE, '01-01-PLAN-SUMMARY.md'));
      damage(dir, summary);
      assert.equal(run(dir).payload.rows[0].status, 'FAIL');
    });
  }

  test('an absent primary SUMMARY falls through to a later candidate name that holds the task commits', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    fs.renameSync(path.join(dir, PHASE, '01-01-SUMMARY.md'), path.join(dir, PHASE, '01-01-PLAN-SUMMARY.md'));
    assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
  });

  test('a plan with one task rewritten and one gone is NotEvaluable, not a rewrite', () => {
    const { dir, base } = fixture(['chore: red', 'chore: green'], { refs: true });
    sealGit(dir, 'checkout', '-b', 'partial', base);
    w(dir, 'f0.txt', 'different content'); // same content and parent would reproduce the original sha
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'chore: red');
    sealGit(dir, 'checkout', 'feature', '--', `${PHASE}/01-01-SUMMARY.md`);
    sealGit(dir, 'commit', '-m', 'docs: summary');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  test('a close() failure on the seal is reported unreadable, not thrown', (t) => {
    const { dir } = fixture([], { summary: false });
    w(dir, SEAL, sealOf(sha('a'), sha('b')));
    t.mock.method(fs, 'closeSync', () => { throw Object.assign(new Error('close failed'), { code: 'EIO' }); });
    assert.equal(run(dir).outcome, 'unreadable');
  });

  // Each distinct SUMMARY hash costs a `git merge-base` spawn and, when git does not know it, a `git rev-parse --verify`: the count is capped (`SUMMARY_REFS_MAX`).
  const REFS_CAP = SUMMARY_REFS_MAX;
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

  test('a seal with two distinct non-hex values credits nothing, and its entry rules out NotEvaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    fs.writeFileSync(path.join(dir, SEAL), sealOf('zz', 'yy'));
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.deepEqual(r.payload.rows[0].missing, ['RED', 'GREEN']);
    assert.equal(r.payload.violations, 1);
  });

  test('--record into an unwritable phase directory reports unreadable', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    // A second TDD plan with no commits fails: the review result must survive the write fault.
    w(dir, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: tdd\n---\n# Plan\n');
    const real = fs.openSync;
    t.mock.method(fs, 'openSync', (f, ...rest) => {
      if (String(f).includes('TDD-REVIEW-SEAL.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real(f, ...rest);
    });
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.match(r.payload.message, /could not write: TDD-REVIEW-SEAL\.json \(EACCES\)\. .*nothing was sealed/);
    assert.doesNotMatch(r.payload.message, /was not reviewed/);
    assert.deepEqual(r.payload.rows.map((row) => row.status), ['Pass', 'FAIL']);
    assert.equal(r.payload.violations, 1);
    assert.match(r.payload.table, /### TDD REVIEW/);
  });

  test('--record names the error text when the write fails with a code that means "absent" (ENOENT)', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.openSync;
    t.mock.method(fs, 'openSync', (f, ...rest) => {
      if (String(f).includes('TDD-REVIEW-SEAL.json')) throw Object.assign(new Error('phase dir vanished'), { code: 'ENOENT' });
      return real(f, ...rest);
    });
    const r = run(dir, '--record');
    assert.equal(r.outcome, 'unreadable');
    assert.match(r.payload.message, /could not write: TDD-REVIEW-SEAL\.json \(Error: phase dir vanished\)\./);
  });

  test('a failed --record leaves no temp file behind', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.openSync;
    let opened = false;
    t.mock.method(fs, 'openSync', (f, ...rest) => { if (String(f).includes('.tmp.')) opened = true; return real(f, ...rest); });
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('rename failed'), { code: 'EPERM' }); });
    assert.equal(run(dir, '--record').outcome, 'unreadable');
    assert.ok(opened, 'the temp file was created before the rename failed');
    assert.deepEqual(fs.readdirSync(path.join(dir, PHASE)).filter((n) => n.includes('.tmp')), []);
  });

  test('a partial write of the temp file leaves the prior seal byte for byte and no temp file', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const prior = JSON.stringify({ plans: { '01-99': { red: sha('a'), green: sha('b') } } });
    w(dir, SEAL, prior);
    const real = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (f, data, ...rest) => {
      if (typeof f !== 'number' || !String(data).includes('"01-01"')) return real(f, data, ...rest);
      real(f, String(data).slice(0, 10), ...rest);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    assert.equal(run(dir, '--record').outcome, 'unreadable');
    assert.equal(fs.readFileSync(path.join(dir, SEAL), 'utf8'), prior);
    assert.deepEqual(fs.readdirSync(path.join(dir, PHASE)).filter((n) => n.includes('.tmp')), []);
  });

  test('a dangling symlink at the seal path is refused and its target is never created', posix, () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const target = path.join(dir, 'not-there.json');
    fs.symlinkSync(target, path.join(dir, SEAL));
    const r = run(dir, '--record');
    assert.equal(r.outcome, 'unreadable');
    assert.equal(fs.existsSync(target), false);
  });

  test('--record seals a plan in a phase directory whose name has a space and a non-ASCII letter', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const odd = '.planning/phases/01-ünï phase';
    fs.renameSync(path.join(dir, PHASE), path.join(dir, odd));
    sealGit(dir, 'add', '-A');
    sealGit(dir, 'commit', '-m', 'docs: rename phase dir');
    assert.equal(run(dir, '--record').payload.violations, 0);
    const seal = JSON.parse(fs.readFileSync(path.join(dir, odd, 'TDD-REVIEW-SEAL.json'), 'utf8'));
    assert.match(seal.plans['01-01'].red, /^[0-9a-f]{40}$/);
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

  // The seal is looked up by own key only: a plan named like an Object.prototype member has no inherited entry, so it stays NotEvaluable.
  for (const planId of ['constructor', 'toString', '__proto__']) {
    test(`a plan named ${planId} does not inherit a seal entry from Object.prototype`, () => {
      const { dir } = fixture([], { summary: false, plan: false });
      w(dir, `${PHASE}/${planId}-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
      w(dir, `${PHASE}/${planId}-SUMMARY.md`, `# done\n\n## Task Commits\n\n1. **Task 1: x** - \`${'d'.repeat(40)}\`\n`);
      w(dir, SEAL, '{"plans":{}}');
      assert.equal(run(dir).payload.rows[0].status, 'NotEvaluable');
    });
  }

  test('a seal entry keyed __proto__ is its own entry for a plan named __proto__ and is credited', () => {
    const { dir } = fixture([], { summary: false, plan: false });
    w(dir, `${PHASE}/__proto__-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
    w(dir, SEAL, `{"plans":{"__proto__":{"red":"${sha('a')}","green":"${sha('b')}"}}}`);
    assert.equal(run(dir).payload.rows[0].status, 'Pass');
  });

  test('--record seals a passing plan named __proto__ as its own entry', () => {
    const { dir } = fixture(['test(__proto__): red', 'feat(__proto__): green'], { summary: false, plan: false });
    w(dir, `${PHASE}/__proto__-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
    sealGit(dir, 'add', '-A'); sealGit(dir, 'commit', '-m', 'docs: plan');
    assert.equal(run(dir, '--record').payload.violations, 0);
    const sealed = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans;
    assert.deepEqual(Object.keys(sealed), ['__proto__']);
    assert.match(sealed.__proto__.red, /^[0-9a-f]{40}$/);
    assert.match(sealed.__proto__.green, /^[0-9a-f]{40}$/);
  });

  test('the no-TDD skip is keyed on the picked tddPlans field', () => {
    const skip = fixture([], { summary: false, plan: false });
    const out = runGsdTools(['check', 'tdd-review-checkpoint', '1', '--pick', 'tddPlans'], skip.dir);
    assert.ok(out.success, out.error || out.output);
    assert.equal(out.output.trim(), '0');
  });

  // Execute ship.md's seal step against a stubbed `gsd_run`, so the branches (not their text) are what is tested.
  function runSealStep({ recordRc = 0, picked = '1', seal, ws = '', prepare, commitOut, commitRc = 0, subjects = [], real = false, gitExit, statusExit }) {
    const ship = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md'), 'utf8').replace(/\r\n/g, '\n');
    const from = ship.indexOf('```bash\n', ship.indexOf('<step name="seal_tdd_review">')) + 8;
    const script = ship.slice(from, ship.indexOf('\n```', from));
    const { dir } = fixture(subjects, { summary: false });
    const before = sealGit(dir, 'log', '-1', '--format=%s');
    if (seal !== undefined) w(dir, SEAL, seal);
    if (prepare) prepare(dir);
    const calls = path.join(path.dirname(dir), `${path.basename(dir)}-calls`);
    dirs.push(calls);
    // `query commit` stands in for cmdCommit: it commits the seal itself unless COMMIT_OUT is set (then it prints that and commits nothing).
    const stub = real
      ? 'gsd_run() { echo "$*" >> "$CALLS"; node "$GSD_TOOLS_BIN" "$@"; }\n'
      : 'gsd_run() { echo "$*" >> "$CALLS"; case "$*" in "run-with-timeout "*) shift 3; if [ -n "${GIT_EXIT+x}" ]; then return "$GIT_EXIT"; fi; case "$*" in "git status"*) if [ -n "${STATUS_EXIT+x}" ]; then return "$STATUS_EXIT"; fi;; esac; "$@"; return $?;; "query commit"*) if [ -n "${COMMIT_OUT+x}" ]; then echo "$COMMIT_OUT"; else git add "$SEAL" && git commit -q -m "$3" -- "$SEAL" && git rev-parse HEAD || return 1; fi; return "${COMMIT_RC:-0}";; *--record*) echo "$PICK"; return "$REC";; *) echo "$PICK";; esac; }\n';
    const r = runHook('-c', [stub + script], {
      interpreter: 'bash', cwd: dir, timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, ...(commitOut === undefined ? {} : { COMMIT_OUT: commitOut }), ...(gitExit === undefined ? {} : { GIT_EXIT: String(gitExit) }), ...(statusExit === undefined ? {} : { STATUS_EXIT: String(statusExit) }), COMMIT_RC: String(commitRc), GSD_TOOLS_BIN: path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), CALLS: calls, GSD_WS: ws, REC: String(recordRc), PICK: picked, PHASE_DIR: PHASE, PHASE_NUMBER: '1', padded_phase: '01', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    });
    return { r, dir, before, subject: sealGit(dir, 'log', '-1', '--format=%s'), calls: fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter((c) => c && !c.startsWith('run-with-timeout ')) };
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

  test('ship.md seal step commits a dirty seal after a successful record', posix, () => {
    const { r, subject } = runSealStep({ seal: sealOf(sha('a'), sha('b')) });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(subject, /^docs\(01\): seal TDD review evidence$/);
  });

  test('ship.md seal step warns and commits nothing when a bounded git call times out', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), gitExit: 124 }), 'gitTimedOut');
  });

  for (const code of [2, 127, 128]) {
    test(`ship.md seal step warns and commits nothing when a bounded git call exits ${code}`, posix, () => {
      expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), gitExit: code }), 'gitFailed');
    });
  }

  // `git status` alone fails (the ignore check is clean): each bounded call carries its own branch.
  test('ship.md seal step warns and commits nothing when only the bounded git status times out', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), statusExit: 124 }), 'gitTimedOut');
  });

  test('ship.md seal step warns and commits nothing when only the bounded git status fails', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), statusExit: 128 }), 'gitFailed');
  });

  test('ship.md seal step never commits the on-disk seal when --record failed', posix, () => {
    expectBranchWarning(runSealStep({ recordRc: 3, seal: '<<<<<<< conflict' }), 'recordFailed');
  });

  test('ship.md seal step leaves the seal uncommitted and warns when the commit owner skips it (commit_docs resolves false)', posix, () => {
    const result = runSealStep({ seal: sealOf(sha('a'), sha('b')), commitOut: 'skipped' });
    expectBranchWarning(result, 'commitSkipped');
    assert.equal(fs.existsSync(path.join(result.dir, SEAL)), true);
    assert.notEqual(sealGit(result.dir, 'status', '--porcelain', '--', SEAL), '');
  });

  test('ship.md seal step commits through the commit owner, not raw git', posix, () => {
    const { calls } = runSealStep({ seal: sealOf(sha('a'), sha('b')) });
    assert.ok(calls.some((c) => c.startsWith('query commit docs(01): seal TDD review evidence --files ') && c.includes('TDD-REVIEW-SEAL.json')), calls.join('\n'));
  });

  // The real commit owner: phase_commit_docs.<phase> beats the project-level commit_docs (#3587).
  function realSeal(config) {
    return runSealStep({
      real: true,
      subjects: ['test(01-01): red', 'feat(01-01): green'],
      prepare: (dir) => w(dir, '.planning/config.json', JSON.stringify(config)),
    });
  }

  test('ship.md seal step commits the seal when the phase override is true and the project value false', posix, () => {
    const { r, dir, subject } = realSeal({ commit_docs: false, phase_commit_docs: { '01': true } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(subject, 'docs(01): seal TDD review evidence');
    assert.equal(sealGit(dir, 'status', '--porcelain', '--', SEAL), '');
  });

  test('ship.md seal step leaves the seal uncommitted when the phase override is false and the project value true', posix, () => {
    const result = realSeal({ commit_docs: true, phase_commit_docs: { '01': false } });
    expectBranchWarning(result, 'commitSkipped');
    assert.equal(fs.existsSync(path.join(result.dir, SEAL)), true);
    assert.notEqual(sealGit(result.dir, 'status', '--porcelain', '--', SEAL), '');
  });

  test('ship.md seal step resolves the phase in the workstream ship resolved it in (#5354)', posix, () => {
    const { calls } = runSealStep({ ws: '--ws ws1', seal: sealOf(sha('a'), sha('b')) });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^check .* --record /);
    assert.match(calls[1], /^query commit /);
    for (const call of calls) assert.match(call, / --ws=ws1(?: |$)/, call);
  });

  test('ship.md seal step warns when no seal file exists, and only for a phase with tdd plans', posix, () => {
    const warned = runSealStep({ picked: '1' });
    expectBranchWarning(warned, 'noSeal');
    assert.equal(fs.existsSync(path.join(warned.dir, SEAL)), false);
    expectQuiet(runSealStep({ picked: '0' }));
  });

  test('ship.md seal step warns about a gitignored seal and commits nothing', posix, () => {
    const result = runSealStep({
      seal: sealOf(sha('a'), sha('b')),
      prepare: (dir) => { w(dir, '.gitignore', `${SEAL}\n`); sealGit(dir, 'add', '.gitignore'); sealGit(dir, 'commit', '--amend', '--no-edit'); },
    });
    expectBranchWarning(result, 'gitignored');
    const { dir } = result;
    assert.equal(fs.existsSync(path.join(dir, SEAL)), true);
    assert.equal(sealGit(dir, 'status', '--porcelain', '--', SEAL), '');
  });

  test('ship.md seal step stops with exit 1 when the commit owner exits non-zero', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), commitOut: '', commitRc: 3 }), 'commitFailed');
  });

  test('ship.md seal step stops with exit 1 when the commit owner reports failed', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), commitOut: 'failed' }), 'commitFailed');
  });

  test('ship.md seal step stops with exit 1 when the seal commit fails', posix, () => {
    expectBranchWarning(runSealStep({ seal: sealOf(sha('a'), sha('b')), prepare: (dir) => w(dir, '.git/index.lock', '') }), 'commitFailed');
  });

  test('--record refuses a seal path that became a directory between the read and the write', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.lstatSync;
    let seen = 0;
    t.mock.method(fs, 'lstatSync', (f, ...rest) => (String(f).endsWith('TDD-REVIEW-SEAL.json') && ++seen === 2 ? real(dir) : real(f, ...rest)));
    const r = run(dir, '--record');
    assert.equal(r.outcome, 'unreadable');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.equal(r.payload.unreadable[0].source, 'TDD-REVIEW-SEAL.json');
    assert.equal(fs.existsSync(path.join(dir, SEAL)), false);
  });

  test('--record refuses a seal path that cannot be examined at write time', (t) => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const real = fs.lstatSync;
    let seen = 0;
    t.mock.method(fs, 'lstatSync', (f, ...rest) => {
      if (String(f).endsWith('TDD-REVIEW-SEAL.json') && ++seen === 2) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real(f, ...rest);
    });
    const r = run(dir, '--record');
    assert.equal(r.outcome, 'unreadable');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
    assert.equal(r.payload.unreadable[0].source, 'TDD-REVIEW-SEAL.json');
    assert.equal(fs.existsSync(path.join(dir, SEAL)), false);
  });

  const GREEN_SHA = sha('b');
  const sealRedArb = fc.oneof(
    fc.stringMatching(/^[0-9a-f]{40}$/),
    fc.stringMatching(/^[0-9a-f]{39}$/),
    fc.stringMatching(/^[0-9a-f]{41}$/),
    fc.stringMatching(/^[0-9A-F]{40}$/),
    fc.constant(GREEN_SHA),
  );
  // The seal is consulted when the plan has no live RED or when its RED is no longer reachable (#5354): these sealed hashes name no object, so it always is. It credits each kind the live commits lack.
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

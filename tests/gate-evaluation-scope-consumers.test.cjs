'use strict';

/**
 * Consumers of the evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4): the two gates that
 * derived their own commit range (`ui-safety-gate`: `HEAD~1..HEAD`; `tdd-review-checkpoint`: a
 * repo-wide message grep) and the `check evaluation-scope` verb the workflows call. Real git
 * fixtures; the verb is driven through the real CLI.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');
const { computeUiSafetyGate, evaluateUiSafetyGate } = require('../gsd-core/bin/lib/gate-ui-safety.cjs');
const { evaluateEvaluationScope } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');
const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');
const { evaluateDecisionCoverageVerify } = require('../gsd-core/bin/lib/gate-decision-coverage-verify.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const PHASE_DIR = '.planning/phases/03-dashboard';
const ROADMAP = [
  '# Roadmap', '', '## Milestone v1', '',
  '### Phase 3: Frontend dashboard UI components', '',
  '**Goal**: Ship the React frontend UI', '',
].join('\n');

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeRepo({ plans = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-consumers-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}');
  write(dir, '.planning/ROADMAP.md', ROADMAP);
  write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
  for (const [name, content] of Object.entries(plans)) write(dir, `${PHASE_DIR}/${name}`, content);
  git('add', '.');
  git('commit', '-m', 'docs(03): scaffold phase');
  return { dir, git };
}

function commit(repo, rel, message) {
  write(repo.dir, rel, `${rel}\n`);
  repo.git('add', rel);
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

function summarize(repo, shas) {
  const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\``).join('\n');
  write(repo.dir, `${PHASE_DIR}/03-01-SUMMARY.md`, `# Summary\n\n## Task Commits\n\n${rows}\n\n## Next\n`);
  repo.git('add', '.');
  repo.git('commit', '-m', 'docs(03-01): summary');
}

describe('ui-safety-gate reads the phase\'s evaluation scope, not the last commit', () => {
  test('[happy] a UI file in a task commit with no UI-SPEC blocks, however old the commit', () => {
    const repo = makeRepo();
    const ui = commit(repo, 'src/components/Panel.tsx', 'feat(03-01): panel');
    commit(repo, 'src/server.js', 'feat(03-01): server');
    commit(repo, 'docs/notes.md', 'docs: later note');
    summarize(repo, [ui]);
    const result = computeUiSafetyGate(repo.dir, '3');
    assert.equal(result.hasUiFiles, true);
    assert.equal(result.block, true);
    assert.equal(result.scopeStatus, undefined);
  });

  test('[regression] a UI file landed by an interleaved non-phase commit does not trip the gate', () => {
    const repo = makeRepo();
    const server = commit(repo, 'src/server.js', 'feat(03-01): server');
    commit(repo, 'src/components/Unrelated.tsx', 'fix(quick): somebody else');
    summarize(repo, [server]);
    const result = computeUiSafetyGate(repo.dir, '3');
    assert.equal(result.hasUiFiles, false);
    assert.equal(result.block, false);
  });

  test('[negative] a phase with no recorded task commits is reported degraded, never silently clean', () => {
    const repo = makeRepo();
    commit(repo, 'src/components/Panel.tsx', 'feat(03-01): panel');
    const result = computeUiSafetyGate(repo.dir, '3');
    assert.equal(result.scopeStatus, 'degraded');
    assert.equal(result.scopeReason, 'no-summary');
    assert.equal(result.hasUiFiles, true);
  });

  test('[negative] an unknown phase is reported unresolvable and does not block', () => {
    const repo = makeRepo();
    const result = computeUiSafetyGate(repo.dir, '9');
    assert.equal(result.scopeStatus, 'unresolvable');
    assert.equal(result.scopeReason, 'phase-dir-not-found');
    assert.equal(result.block, false);
  });

  test('[negative] the verdict for an unreadable scope is `unreadable` — "could not look" is never a `pass`', () => {
    const repo = makeRepo();
    const unreadable = evaluateUiSafetyGate({ projectDir: repo.dir, args: ['9'] });
    assert.equal(unreadable.outcome, 'unreadable');
    assert.equal(unreadable.block, false);
    const read = evaluateUiSafetyGate({ projectDir: repo.dir, args: ['3'] });
    assert.equal(read.outcome, 'pass', 'a readable (here degraded) scope with no UI-SPEC need keeps the pass outcome');
  });
});

describe('tdd-review-checkpoint reads the plan\'s commits from this branch only', () => {
  const tddPlan = '---\ntype: tdd\nphase: 3\nslug: 03-01\n---\n# Plan\n';

  function rowOf(repo) {
    const verdict = evaluateTddReviewCheckpoint({ projectDir: repo.dir, args: ['3'] });
    return verdict.payload.rows[0];
  }

  test('[happy] RED and GREEN on this branch pass; REFACTOR is reported', () => {
    const repo = makeRepo({ plans: { '03-01-PLAN.md': tddPlan } });
    commit(repo, 'tests/a.test.js', 'test(03-01): red');
    commit(repo, 'src/a.js', 'feat(03-01): green');
    commit(repo, 'src/a2.js', 'refactor(3-1): tidy');
    const row = rowOf(repo);
    assert.deepEqual([row.red, row.green, row.refactor, row.status], [true, true, true, 'Pass']);
  });

  test('[regression] a RED commit that lives only on another branch does not satisfy the gate', () => {
    const repo = makeRepo({ plans: { '03-01-PLAN.md': tddPlan } });
    commit(repo, 'src/a.js', 'feat(03-01): green');
    repo.git('checkout', '-b', 'side');
    commit(repo, 'tests/a.test.js', 'test(03-01): red on a side branch');
    repo.git('checkout', 'main');
    const row = rowOf(repo);
    assert.deepEqual([row.red, row.green, row.status, row.missing], [false, true, 'FAIL', ['RED']]);
  });

  test('[boundary] a different plan\'s commits do not count (03-010 is not 03-01)', () => {
    const repo = makeRepo({ plans: { '03-01-PLAN.md': tddPlan } });
    commit(repo, 'tests/b.test.js', 'test(03-010): not this plan');
    commit(repo, 'src/b.js', 'feat(03-010): not this plan');
    const row = rowOf(repo);
    assert.deepEqual([row.red, row.green], [false, false]);
  });
});

describe('decision-coverage-verify reads the phase\'s own commit messages', () => {
  function verify(repo) {
    return evaluateDecisionCoverageVerify({ projectDir: repo.dir, args: [PHASE_DIR, `${PHASE_DIR}/03-CONTEXT.md`] });
  }

  test('[regression] a decision honored only by an interleaved non-phase commit message is not honored', () => {
    const repo = makeRepo();
    write(repo.dir, `${PHASE_DIR}/03-CONTEXT.md`, '## Decisions\n\n- **D-01:** Use sqlite for the zebra cache\n');
    repo.git('add', '.');
    repo.git('commit', '-m', 'docs(03): context');
    const own = commit(repo, 'src/a.js', 'feat(03-01): add the cache layer');
    commit(repo, 'src/z.js', 'fix(quick): use sqlite for the zebra cache');
    summarize(repo, [own]);
    const payload = verify(repo).payload;
    assert.equal(payload.honored, 0, JSON.stringify(payload));
  });

  test('[happy] a decision honored by one of the phase\'s own commit messages is honored', () => {
    const repo = makeRepo();
    write(repo.dir, `${PHASE_DIR}/03-CONTEXT.md`, '## Decisions\n\n- **D-01:** Use sqlite for the zebra cache\n');
    repo.git('add', '.');
    repo.git('commit', '-m', 'docs(03): context');
    const own = commit(repo, 'src/a.js', 'feat(03-01): use sqlite for the zebra cache');
    summarize(repo, [own]);
    assert.equal(verify(repo).payload.honored, 1);
  });
});

describe('`check evaluation-scope` through the CLI', () => {
  test('[happy] prints the scope as JSON; files are the union, the interleaved file is named', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/n.js', 'fix: noise');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const result = runTools(['check', 'evaluation-scope', '--phase', '3', '--raw'], repo.dir);
    assert.equal(result.exitCode, 0, result.stderr);
    const scope = JSON.parse(result.stdout);
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.outsideUnion, ['other/n.js']);
  });

  test('[happy] a plan unit with --commits-only and --max-commits', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'src/b.js', 'test(03-01): b');
    const result = runTools(['check', 'evaluation-scope', '--plan', '03-01', '--commits-only', '--max-commits', '1', '--raw'], repo.dir);
    const scope = JSON.parse(result.stdout);
    assert.equal(scope.commits.length, 1);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] an unresolvable scope exits UNAVAILABLE (69) and still prints the JSON with the reason (#5170)', () => {
    const repo = makeRepo();
    const result = runTools(['check', 'evaluation-scope', '--phase', '9', '--raw'], repo.dir);
    assert.equal(result.exitCode, 69, result.stderr);
    const scope = JSON.parse(result.stdout);
    assert.equal(scope.status, 'unresolvable');
    assert.equal(typeof scope.reason, 'string');
    assert.deepEqual(scope, JSON.parse(JSON.stringify(evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '9'] }).payload)));
  });

  test('[independence] a degraded scope is a delivered answer: exit 0', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const result = runTools(['check', 'evaluation-scope', '--phase', '3', '--raw'], repo.dir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'degraded');
  });

  test('[negative] invalid arguments fail with a usage error naming the problem', () => {
    const repo = makeRepo();
    const none = runTools(['check', 'evaluation-scope', '--raw'], repo.dir);
    assert.notEqual(none.exitCode, 0);
    assert.match(none.stderr, /exactly one of --phase/);
    const bad = runTools(['check', 'evaluation-scope', '--phase', '3', '--max-commits', '0', '--raw'], repo.dir);
    assert.notEqual(bad.exitCode, 0);
    assert.match(bad.stderr, /--max-commits must be an integer/);
  });

  test('[independence] the unknown-verb error lists the new verb', () => {
    const repo = makeRepo();
    const result = runTools(['check', 'no-such-verb', '--raw'], repo.dir);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /decision-coverage-verify, evaluation-scope, gap-analysis-plan-post/);
  });
});

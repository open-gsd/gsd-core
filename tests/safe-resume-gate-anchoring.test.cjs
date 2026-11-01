'use strict';

/**
 * #4003 — the safe_resume_gate / TDD RED / completion spot-check plan-commit lookups
 * (carried through #5164, epic #5056 Phase 7).
 *
 * The gate keyed on the padded `{phase_number}-{plan_padded}` as a bare substring:
 * unanchored (any prior milestone's same-numbered plan matches) and padding-blind
 * (the commit protocol — agents/gsd-executor.md <task_commit_protocol>,
 * gsd-core/references/tdd.md:99 — specifies no padding rule, and both spellings are
 * live in this repository's history). #4003 hand-rolled an anchored, zero-pad-tolerant
 * `git log --grep` in three workflow fences; #5164 moves that derivation into the
 * evaluation-scope resolver (`check evaluation-scope --plan`), so there is ONE copy.
 * Workflow text IS the deployed product here, so the shape assertions pin that the
 * fences ask the resolver; the behavioral rows run the real resolver against a crafted
 * history.
 *
 * #4619 / #4748 — decimal / N-segment / letter-suffixed phase numbers (`01.1`, `23.1.2`,
 * `03A`) are tolerated by the resolver's pattern, not by shell arithmetic.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { resolveEvaluationScope, planSubjectPattern } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

describe('#4003 / #5164 — safe_resume_gate plan-commit lookups ask the resolver', () => {
  test('safe_resume_gate asks for the plan\'s commits, milestone-bounded, and derives no scope regex of its own', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(w.includes('PLAN_COMMITS=$(gsd_run check evaluation-scope --plan "${PHASE_NUMBER}-{plan_padded}" --commits-only --milestone-bound --max-commits 30'),
      'the resume gate must ask the resolver for the plan\'s milestone-bounded commits');
    for (const gone of ['PLAN_SCOPE_RE=', 'PHASE_INT=${PHASE_NUMBER%%', '--grep=', 'git describe --tags']) {
      assert.ok(!w.includes(gone), `the hand-rolled derivation \`${gone}\` must not remain in execute-phase.md`);
    }
    assert.ok(!w.includes('--grep="${CURRENT_PLAN_ID}"'), 'the bare substring grep over the padded id must not remain');
    assert.ok(!w.includes('CURRENT_PLAN_ID="{phase_number}-{plan_padded}"'), 'the padded id derivation must not remain');
  });

  test('tdd red gate asks the resolver with the same bound (#4011 keying untouched)', () => {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    const line = w.split(/\r?\n/).find((l) => l.includes('RED_COMMIT=$(gsd_run check evaluation-scope'));
    assert.ok(line, 'the RED_COMMIT line must call the resolver');
    assert.ok(line.includes('--plan "${PHASE_NUMBER}-${PLAN_ID}"') && line.includes('--milestone-bound') && line.includes('--max-commits 1'),
      'the RED lookup must use the plan scope, the milestone bound, and stop at the first match');
    assert.ok(!w.includes('--grep="^test(${PHASE_NUMBER}-${PLAN_ID})"'), 'the padded-literal RED grep must not remain');
    assert.ok(w.includes('if [ "$TDD_MODE" = "true" ]'), '#4011 TDD_MODE keying preserved');
  });

  test('tdd.md gate-enforcement examples use the anchored padding-tolerant scope', () => {
    const ref = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md'), 'utf8');
    assert.ok(!ref.includes('--grep="^test(${PHASE}-${PLAN})"'),
      'the padded-literal example grep must not remain');
    assert.ok(ref.includes('--grep="^test\\((0*${PHASE_N})-(0*${PLAN_N})\\):"'),
      'the RED example is anchored and zero-pad-tolerant');
    assert.ok(ref.includes('PHASE_INT=${PHASE%%[!0-9]*}; PHASE_REST=${PHASE#"$PHASE_INT"}') &&
      ref.includes('PHASE_N="$((10#$PHASE_INT))${PHASE_REST//./\\\\.}"') && ref.includes('PLAN_N=$((10#${PLAN}))'),
      'the examples derive zero-stripped components (#4619: leading integer segment only, decimal/N-segment tolerant; #4748: letter-suffix tolerant)');
  });

  test('completion spot-check asks the resolver and keeps its time bound', () => {
    // #4217 moved the completion spot-check probes (with the whole reconciliation
    // policy, both arms) into execute-phase/steps/completion-reconciliation.md.
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    const frag = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows',
      'execute-phase', 'steps', 'completion-reconciliation.md'), 'utf8');
    assert.ok(!w.includes('--grep="{phase_number}-{plan_padded}"') && !frag.includes('--grep="{phase_number}-{plan_padded}"'),
      'the raw padded placeholder substring grep must not remain');
    assert.ok(frag.includes('gsd_run check evaluation-scope --plan "{phase_number}-{plan_padded}" --ref "${EXPECTED_BRANCH}" --commits-only --committed-since "1 hour ago"'),
      'the spot-check asks the resolver, on the expected branch (a finished worktree executor\'s commits are not yet merged), and keeps its temporal bound');
    assert.ok(!frag.includes('--all'), 'the spot-check must not look at commits on other branches');
  });

  test('the resolver separates same-scope commits across a milestone tag (behavioral)', (t) => {
    // Reproduces the report on a crafted history: an OLD milestone commit with the
    // same scope, a tag, then THIS plan's unpadded commits.
    const repo = createTempGitProject('gsd-4003-gate-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });

    g(['commit', '--allow-empty', '-m', 'feat(02-02): old milestone same-scope commit']);
    // Annotated: a plain `git tag` can demand a message under some git configs.
    g(['tag', '-a', 'v9.0.0', '-m', 'milestone close']);
    g(['commit', '--allow-empty', '-m', 'test(2-02): RED for this plan']);
    g(['commit', '--allow-empty', '-m', 'feat(2-02): GREEN for this plan']);
    g(['commit', '--allow-empty', '-m', 'feat(2-20): adjacent plan must not match']);
    g(['commit', '--allow-empty', '-m', 'feat: mentions 02-02 in prose but not in scope']);

    const subjects = (options) => resolveEvaluationScope(repo, { kind: 'plan', planId: '02-02' }, { commitsOnly: true, ...options })
      .commits.map((c) => c.subject);

    const bounded = subjects({ milestoneBound: true });
    assert.ok(bounded.includes('test(2-02): RED for this plan'), 'this plan RED commit is found');
    assert.ok(bounded.includes('feat(2-02): GREEN for this plan'), 'this plan GREEN commit is found');
    assert.ok(!bounded.some((l) => /old milestone same-scope/.test(l)), 'the pre-tag same-scope commit is excluded');
    assert.ok(!bounded.some((l) => /adjacent plan/.test(l)), 'an adjacent plan scope does not match');
    assert.ok(!bounded.some((l) => /in prose/.test(l)), 'a prose mention outside the scope position does not match');

    // No-tag fallback: strip the tag, keep the anchor — the old milestone commit
    // becomes reachable again, but prose/adjacent scopes still never match.
    g(['tag', '-d', 'v9.0.0']);
    const unbounded = subjects({ milestoneBound: true });
    assert.ok(unbounded.some((l) => /old milestone same-scope/.test(l)),
      'without a tag base the anchor alone cannot exclude prior milestones (degrade is honest)');
    assert.ok(!unbounded.some((l) => /in prose/.test(l)), 'the anchor still holds without a tag');
  });

  test('decimal, N-segment and letter-suffixed phase numbers (#4619, #4748) are tolerated by the pattern', () => {
    const matches = (planId, subject) => new RegExp(planSubjectPattern(planId)).test(subject);
    assert.ok(matches('01.1-02', 'feat(1.1-2): x'));
    assert.ok(matches('23.1.2-03', 'test(23.1.2-03): x'));
    assert.ok(matches('03A-02', 'feat(3A-2): x'));
    assert.ok(!matches('01.1-02', 'feat(1x1-2): x'), 'the dot is literal');
    assert.ok(!matches('03A-02', 'feat(3-2): x'), 'the letter suffix is part of the id');
  });
});

const { isTestFilePath } = require('../gsd-core/bin/lib/tdd-test-files.cjs');
const { SHARED_TEST_PATHS, SHARED_NON_TEST_PATHS } = require('./helpers/tdd-test-paths.cjs');

// ─── #4379: the RED pathspec is language-agnostic, and matches at root ──────
//
// The pathspec IS this gate's definition of "a test file". It was JS/TS-only, so
// a commit adding `foo_test.go` was invisible and every behaviour-adding task in
// a Go project halted with `TDD GATE TRIPPED: missing RED commit` — while
// references/tdd.md:175-177 advertises `go test ./...` as supported.
//
// These rows drive the REAL pathspec, extracted from the shipped workflow, against
// a real git repo. Re-typing the pattern into the test would only assert that two
// copies of a string agree; running it answers the question the gate actually asks.
describe('#4379 — the TDD RED pathspec is language-agnostic', () => {
  // Pull the pathspec out of the workflow rather than restating it: the thing
  // under test is what SHIPS, not a copy maintained alongside it.
  function shippedRedPathspec() {
    const w = fs.readFileSync(WORKFLOW, 'utf8');
    const line = w.split(/\r?\n/).find((l) => l.includes('RED_COMMIT=$(gsd_run check evaluation-scope'));
    assert.ok(line, 'the RED_COMMIT line must exist in execute-phase.md');
    const specs = [...line.matchAll(/--pathspec "([^"]{1,200})"/g)].map((m) => m[1]);
    assert.ok(specs.length > 0, `expected --pathspec arguments, parsed none from: ${line}`);
    return specs;
  }

  // One seeded repo, one commit, reused by every row below.
  function seedRepo(t) {
    const dir = createTempGitProject('gsd-4379-');
    t.after(() => cleanup(dir));
    const files = [
      'foo_test.go', 'pkg/bar_test.go',        // Go — incl. ROOT level
      'root.test.js', 'src/a.test.ts',          // JS/TS — incl. ROOT level
      'tests/c.py', '__tests__/d.js',           // directory conventions
      'test_mod.py', 'mod_test.py',             // Python, outside tests/
      'lib_spec.rb', 'x_test.exs',              // Ruby, Elixir
      ...SHARED_TEST_PATHS,                     // every router-positive path
      'src/impl.go', 'src/lib.rs',              // NOT tests — must never match
      ...SHARED_NON_TEST_PATHS,                 // NOT tests, nested + root
    ];
    for (const rel of files) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x\n');
    }
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'test(1-01): seed every convention'], { cwd: dir });
    return dir;
  }

  function matched(dir, specs) {
    const out = gitOrThrow(['log', '--format=', '--name-only', '--', ...specs], { cwd: dir });
    return new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }

  test('every convention tdd.md advertises is visible to the RED detector', (t) => {
    const dir = seedRepo(t);
    const hits = matched(dir, shippedRedPathspec());
    for (const rel of [
      'foo_test.go', 'pkg/bar_test.go',
      'test_mod.py', 'mod_test.py',
      'lib_spec.rb', 'x_test.exs',
    ]) {
      assert.ok(hits.has(rel), `${rel} must satisfy the RED detector (#4379); matched: ${[...hits].sort().join(', ')}`);
    }
  });

  test('a ROOT-level test file is not invisible', (t) => {
    // The pre-#4379 pathspec was `**/`-prefixed, and `**/` does not match a path
    // with no directory component — so a root `foo.test.js` was missed even in
    // the language the gate did support. This is the half the issue did not report.
    const dir = seedRepo(t);
    const hits = matched(dir, shippedRedPathspec());
    assert.ok(hits.has('root.test.js'), 'a root-level .test.js must match');
    assert.ok(hits.has('foo_test.go'), 'a root-level _test.go must match');
  });

  test('router and shipped pathspec agree on every shared path, nested included (#5181)', (t) => {
    // Default-mode pathspecs match the whole path from the repo root: `tests/` is a root-anchored
    // prefix and `test_*.py` only matches paths starting `test_`, so nested files need `:(glob)**/`.
    const dir = seedRepo(t);
    const hits = matched(dir, shippedRedPathspec());
    for (const rel of [...SHARED_TEST_PATHS, ...SHARED_NON_TEST_PATHS]) {
      const expected = SHARED_TEST_PATHS.includes(rel);
      assert.equal(hits.has(rel), expected, `${rel} must agree: git`);
      assert.equal(isTestFilePath(rel), expected, `${rel} must agree: router`);
    }
  });

  test('the existing JS/TS conventions still match (no regression)', (t) => {
    const dir = seedRepo(t);
    const hits = matched(dir, shippedRedPathspec());
    for (const rel of ['src/a.test.ts', 'tests/c.py', '__tests__/d.js']) {
      assert.ok(hits.has(rel), `${rel} must still match after widening`);
    }
  });

  test('implementation files never match — the gate must still be able to trip', (t) => {
    // A pathspec broad enough to catch ordinary source would make the gate pass on
    // ANY in-scope commit, which is worse than the bug being fixed.
    //
    // `src/lib.rs` carries the Rust consequence: `#[test]` conventionally lives
    // INSIDE the implementation file, so a Rust RED commit touches only source and
    // no path-based gate can see it. That gap is a direct consequence of this row
    // holding — the two cannot both be satisfied — which is why it is documented in
    // references/tdd.md rather than "fixed" by widening the pathspec.
    const dir = seedRepo(t);
    const hits = matched(dir, shippedRedPathspec());
    for (const rel of ['src/impl.go', 'src/lib.rs']) {
      assert.ok(!hits.has(rel), `${rel} must NOT be treated as a test file`);
    }
  });

  test('through the resolver: a Go RED commit satisfies the lookup, an implementation-only commit does not', (t) => {
    const dir = createTempGitProject('gsd-4379-resolver-');
    t.after(() => cleanup(dir));
    const specs = shippedRedPathspec();
    const redCommits = () => resolveEvaluationScope(dir, { kind: 'plan', planId: '1-01' }, { pathspecs: specs, commitsOnly: true, maxCommits: 1 }).commits;

    fs.writeFileSync(path.join(dir, 'impl.go'), 'package x\n');
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'feat(1-01): implementation only'], { cwd: dir });
    assert.equal(redCommits().length, 0, 'an implementation-only commit is not a RED commit');

    fs.writeFileSync(path.join(dir, 'foo_test.go'), 'package x\n');
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'test(1-01): add the failing Go test'], { cwd: dir });
    assert.deepEqual(redCommits().map((c) => c.subject), ['test(1-01): add the failing Go test']);
  });
});

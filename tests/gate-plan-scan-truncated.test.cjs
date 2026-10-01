'use strict';

/**
 * #5170 review fix (ADR-5057 §4): an unreadable nested `plans/` is "could not look", never a short plan set.
 *
 * `scanPhasePlans` marks a phase whose nested `plans/` directory exists but cannot be read as
 * `SCOPE.TRUNCATED` and returns the plans it could see. A gate that treated only `UNREADABLE` as a
 * failure took that short list for the phase's plans: a TDD plan, a decision citation or a plan that
 * declares the API integration could be exactly the one it never saw. Every gate that sources its
 * plans from the scan now treats any scope other than `COMPLETE` as `unreadable`.
 *
 * The phase directory is readable in every case; only the read of its `plans/` entry is made to fail
 * (`fs.readdirSync` monkeypatched in-process, or by a `--require` preload for the CLI verbs — never a
 * chmod, which a root process ignores). Each host also runs without the fault as the positive control.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { withFsFailure, writeMethodFailurePreload } = require('./helpers/fs-failure.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');

const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');
const { evaluateDecisionCoveragePlan } = require('../gsd-core/bin/lib/gate-decision-coverage-plan.cjs');
const { evaluateDecisionCoverageVerify } = require('../gsd-core/bin/lib/gate-decision-coverage-verify.cjs');
const { evaluateGapAnalysisPlanPost } = require('../gsd-core/bin/lib/gate-gap-analysis-plan-post.cjs');
const { evaluateApiCoverageVerifyPre } = require('../gsd-core/bin/lib/gate-api-coverage-verify-pre.cjs');
const { resolveEvaluationScope } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');
const { readPlanScanEvidence, readPlanSetEvidence } = require('../gsd-core/bin/lib/gate-evidence.cjs');

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

const PHASE = '.planning/phases/01-x';
const isNestedPlansDir = (p) => path.basename(p) === 'plans' && path.basename(path.dirname(p)) === '01-x';

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const TDD_PLAN = ['---', 'phase: 1', 'plan: 1', 'wave: 1', 'type: tdd', 'files_modified: []', '---', '# Plan', '<objective>D-01 is honored</objective>', ''].join('\n');
const NESTED_PLAN = ['---', 'phase: 1', 'plan: 2', 'wave: 1', 'type: execute', 'files_modified: []', '---', '# Nested plan', ''].join('\n');

/** A project whose phase 1 has a root plan, a nested plans/ directory with one plan, a CONTEXT.md and a SUMMARY. */
function project() {
  const dir = createTempGitProject('gsd-plan-scan-truncated-');
  dirs.push(dir);
  write(dir, `${PHASE}/01-01-PLAN.md`, TDD_PLAN);
  write(dir, `${PHASE}/plans/PLAN-02.md`, NESTED_PLAN);
  write(dir, `${PHASE}/01-01-SUMMARY.md`, '# Summary\n');
  write(dir, `${PHASE}/01-CONTEXT.md`, ['<decisions>', '## Implementation Decisions', '- **D-01:** Every gate reads its plans through the typed evidence reader', '</decisions>', ''].join('\n'));
  write(dir, '.planning/REQUIREMENTS.md', '- [ ] **REQ-01** the thing\n');
  return dir;
}

const IN_PROCESS_HOSTS = [
  ['check tdd-review-checkpoint', (dir) => evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1'] })],
  ['check decision-coverage-plan', (dir) => evaluateDecisionCoveragePlan({ projectDir: dir, args: [PHASE, `${PHASE}/01-CONTEXT.md`] })],
  ['check decision-coverage-verify', (dir) => evaluateDecisionCoverageVerify({ projectDir: dir, args: [PHASE, `${PHASE}/01-CONTEXT.md`] })],
  ['check gap-analysis-plan-post', (dir) => evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE] })],
  ['check api-coverage-verify-pre', (dir) => evaluateApiCoverageVerifyPre({ projectDir: dir, args: ['1'] })],
];

describe('an unreadable nested plans/ is outcome unreadable in every gate that sources plans from the scan (in-process)', () => {
  for (const [name, run] of IN_PROCESS_HOSTS) {
    test(`${name}: plans/ readdir failing -> unreadable (never a skip or a pass over the plans it saw)`, () => {
      const dir = project();
      const verdict = withFsFailure('readdirSync', isNestedPlansDir, 'EACCES', () => run(dir));
      assert.equal(verdict.outcome, 'unreadable', JSON.stringify(verdict.payload));
    });

    test(`${name}: control — the same project with a readable plans/ is not unreadable`, () => {
      const dir = project();
      const verdict = run(dir);
      assert.notEqual(verdict.outcome, 'unreadable', JSON.stringify(verdict.payload));
    });
  }

  test('check evaluation-scope (phase): the summaries of a truncated scan are not a narrower scope — it is unresolvable', () => {
    const dir = project();
    const broken = withFsFailure('readdirSync', isNestedPlansDir, 'EACCES', () => resolveEvaluationScope(dir, { kind: 'phase', phase: '1' }));
    assert.equal(broken.status, 'unresolvable');
    assert.match(broken.reason, /phase-dir-unreadable/, JSON.stringify(broken));
    // Control: with a readable plans/ the scope resolves the summaries (it may still be unresolvable for
    // lack of commits in this fixture, but never because the phase directory could not be read).
    const control = resolveEvaluationScope(dir, { kind: 'phase', phase: '1' });
    assert.doesNotMatch(control.reason ?? '', /phase-dir-unreadable/, JSON.stringify(control));
  });
});

describe('an unreadable nested plans/ is exit 69 in the CLI verbs that read the plan set', () => {
  function runVerb(args, { fail }) {
    const dir = project();
    write(dir, `${PHASE}/01-01-PLAN.md`, [
      '---', 'phase: 1', 'plan: 1', 'wave: 1', 'type: execute', 'files_modified: []',
      'must_haves:', '  key_links:', '    - from: src/not-yet.js', '      to: src/other.js', '      via: wiring', '---', '# Plan', '',
    ].join('\n'));
    const preload = fail ? writeMethodFailurePreload(dir, 'readdirSync', `${path.sep}plans`) : undefined;
    return runTools(args, dir, preload === undefined ? {} : { preload });
  }

  const verbs = [
    ['verify phase-completeness', ['verify', 'phase-completeness', '1']],
    ['verify schema-drift', ['verify', 'schema-drift', '1']],
  ];

  // key-links: a missing `from:` is "pending" when a same-or-later-wave plan promises it. When the plans
  // that could promise it were not all readable it is NOT known to be missing and must not be pending or
  // verified: it is a failed link (negative verdict, exit 1) whose detail names the cause.
  test('verify key-links: plans/ readdir failing -> the missing source is a failed link naming the cause, never pending', () => {
    const args = ['verify', 'key-links', `${PHASE}/01-01-PLAN.md`];
    const broken = runVerb(args, { fail: true });
    assert.equal(broken.exitCode, 1, `${broken.stdout} ${broken.stderr}`);
    const link = JSON.parse(broken.stdout).links[0];
    assert.equal(link.verified, false);
    assert.equal(link.pending, undefined);
    assert.match(link.detail, /plans that could declare it could not be read: plan scan truncated/);
    const control = runVerb(args, { fail: false });
    assert.equal(control.exitCode, 1, `${control.stdout} ${control.stderr}`);
    assert.match(JSON.parse(control.stdout).links[0].detail, /^Source file not found \(from:/);
  });
  for (const [name, args] of verbs) {
    test(`${name}: plans/ readdir failing -> exit 69 (UNAVAILABLE) and a payload that says so`, () => {
      const r = runVerb(args, { fail: true });
      assert.equal(r.exitCode, 69, `${r.stdout} ${r.stderr}`);
    });

    test(`${name}: control — without the fault it does not exit 69`, () => {
      const r = runVerb(args, { fail: false });
      assert.notEqual(r.exitCode, 69, `${r.stdout} ${r.stderr}`);
    });
  }
});

describe('property: readPlanScanEvidence is unreadable exactly when an existing plans/ cannot be read (seeded)', () => {
  test('over root plan counts, an existing/absent plans/ directory, and a failing/working readdir', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        fc.boolean(),
        (rootPlans, nestedPlans, hasNestedDir, fails) => {
          const dir = createTempGitProject('gsd-plan-scan-prop-');
          try {
            for (let i = 1; i <= rootPlans; i += 1) write(dir, `${PHASE}/01-0${i}-PLAN.md`, TDD_PLAN);
            if (hasNestedDir) {
              fs.mkdirSync(path.join(dir, PHASE, 'plans'), { recursive: true });
              for (let i = 1; i <= nestedPlans; i += 1) write(dir, `${PHASE}/plans/PLAN-0${i}.md`, NESTED_PLAN);
            }
            fs.mkdirSync(path.join(dir, PHASE), { recursive: true });
            const phaseDir = path.join(dir, PHASE);
            const scan = withFsFailure('readdirSync', fails ? isNestedPlansDir : () => false, 'EACCES', () => readPlanScanEvidence(phaseDir));
            const set = withFsFailure('readdirSync', fails ? isNestedPlansDir : () => false, 'EACCES', () => readPlanSetEvidence(phaseDir));
            const expectUnreadable = hasNestedDir && fails;
            if (scan.kind !== (expectUnreadable ? 'unreadable' : 'found')) return false;
            if (set.kind !== scan.kind) return false;
            if (scan.kind === 'found') {
              const expectedPlans = rootPlans + (hasNestedDir ? nestedPlans : 0);
              return scan.value.planFiles.length === expectedPlans && set.value.length === expectedPlans;
            }
            return typeof scan.reason === 'string' && scan.reason.includes('truncated');
          } finally {
            cleanup(dir);
          }
        },
      ),
      { seed: 5170, numRuns: 40 },
    );
  });
});

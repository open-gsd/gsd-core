'use strict';

/**
 * #5170 (epic #5056, ADR-5057 §4): the tolerant probes T2 left behind — `fs.existsSync(...)` in the
 * api-coverage and decision-coverage gates, and every swallowed read in `src/gap-checker.cts` (the
 * engine behind `check gap-analysis-plan-post`) — answer "absent" for a path they could not look at.
 * Each now reads typed evidence: absent is `none` (the gate's documented policy), anything else that
 * fails is `unreadable` and the verdict's outcome follows it (exit UNAVAILABLE through the CLI).
 *
 * Real directories wherever a real failure can be built (a directory where a file is expected is
 * `EISDIR`); where it cannot (an `EACCES` on a parent) the fs method is monkeypatched and restored in
 * `finally` — never chmod.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempProject, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { evaluateGapAnalysisPlanPost } = require('../gsd-core/bin/lib/gate-gap-analysis-plan-post.cjs');
const { runGapAnalysis } = require('../gsd-core/bin/lib/gap-checker.cjs');
const { evaluateApiCoverageVerifyPre } = require('../gsd-core/bin/lib/gate-api-coverage-verify-pre.cjs');
const { evaluateDecisionCoveragePlan } = require('../gsd-core/bin/lib/gate-decision-coverage-plan.cjs');
const { evaluateDecisionCoverageVerify } = require('../gsd-core/bin/lib/gate-decision-coverage-verify.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const PHASE = '.planning/phases/01-x';
const DECISIONS = ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n');
const REQUIREMENTS = ['# Requirements', '', '- [ ] **REQ-01**: Users can log in', ''].join('\n');

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function mkdir(dir, rel) {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
}

/** A project whose gap analysis reads everything cleanly. */
function cleanProject() {
  const dir = createTempProject('gate-tolerant-');
  write(dir, '.planning/REQUIREMENTS.md', REQUIREMENTS);
  write(dir, `${PHASE}/01-CONTEXT.md`, DECISIONS);
  write(dir, `${PHASE}/01-01-PLAN.md`, '<objective>REQ-01 and D-01</objective>\n');
  return dir;
}

/** Run `body` with `fs[method]` throwing a coded error for any path accepted by `match`; always restored. */
function withFsFailure(method, match, code, body) {
  const original = fs[method];
  fs[method] = function patched(target, ...rest) {
    if (typeof target === 'string' && match(target)) {
      const err = new Error(`${code}: injected failure on ${target}`);
      err.code = code;
      throw err;
    }
    return original.call(this, target, ...rest);
  };
  try {
    return body();
  } finally {
    fs[method] = original;
  }
}

function runTools(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd, encoding: 'utf-8', env: { ...process.env, ...TEST_ENV_BASE }, timeout: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
    });
    return { exitCode: 0, stdout: stdout.trim() };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout?.toString().trim() ?? '' };
  }
}

describe('gap-analysis: every read is typed evidence', () => {
  test('[control] a project whose files all read is advisory with no `unreadable` field', () => {
    const dir = cleanProject();
    try {
      const verdict = evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE, 'REQ-01'] });
      assert.equal(verdict.outcome, 'advisory');
      assert.equal(verdict.payload.passed, true);
      assert.equal('unreadable' in verdict.payload, false);
      assert.equal('unreadable' in runGapAnalysis(dir, PHASE, { phaseReqIds: 'REQ-01' }), false);
    } finally { cleanup(dir); }
  });

  test('[control] an ABSENT REQUIREMENTS.md, CONTEXT.md and config are `none`, not unreadable', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      mkdir(dir, PHASE);
      const verdict = evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE] });
      assert.equal(verdict.outcome, 'advisory');
      assert.equal(verdict.payload.passed, true);
    } finally { cleanup(dir); }
  });

  test('[negative] REQUIREMENTS.md that cannot be read is unreadable, and no ID is called "missing from REQUIREMENTS.md"', () => {
    const dir = cleanProject();
    try {
      cleanup(path.join(dir, '.planning/REQUIREMENTS.md'));
      mkdir(dir, '.planning/REQUIREMENTS.md'); // a directory where the file belongs: EISDIR
      const verdict = evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE, 'REQ-01'] });
      assert.equal(verdict.outcome, 'unreadable');
      assert.equal(verdict.block, false);
      assert.equal(verdict.payload.passed, false);
      assert.deepEqual(verdict.payload.unreadable.map((u) => [path.basename(u.span), u.reason]), [['REQUIREMENTS.md', 'EISDIR']]);
      assert.ok(!verdict.payload.table.includes('Missing from REQUIREMENTS.md'));
    } finally { cleanup(dir); }
  });

  test('[negative] CONTEXT.md that cannot be read is unreadable, not "no decisions to check"', () => {
    const dir = cleanProject();
    try {
      cleanup(path.join(dir, PHASE, '01-CONTEXT.md'));
      mkdir(dir, `${PHASE}/01-CONTEXT.md`);
      const verdict = evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE, 'REQ-01'] });
      assert.equal(verdict.outcome, 'unreadable');
      assert.deepEqual(verdict.payload.unreadable.map((u) => path.basename(u.span)), ['01-CONTEXT.md']);
    } finally { cleanup(dir); }
  });

  test('[negative] a plan that cannot be read (EACCES) is unreadable, not an empty slice that reports every ID "Not covered"', () => {
    const dir = cleanProject();
    try {
      const verdict = withFsFailure('readFileSync', (p) => p.endsWith('01-01-PLAN.md'), 'EACCES', () =>
        evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE, 'REQ-01'] }));
      assert.equal(verdict.outcome, 'unreadable');
      assert.deepEqual(verdict.payload.unreadable.map((u) => [path.basename(u.span), u.reason]), [['01-01-PLAN.md', 'EACCES']]);
    } finally { cleanup(dir); }
  });

  test('[negative] a malformed config.json still runs the analysis and is reported unreadable', () => {
    const dir = cleanProject();
    try {
      write(dir, '.planning/config.json', '{ not json');
      const result = runGapAnalysis(dir, PHASE, { phaseReqIds: 'REQ-01' });
      assert.equal(result.enabled, true);
      assert.equal(result.counts.total, 2);
      assert.deepEqual(result.unreadable.map((u) => path.basename(u.span)), ['config.json']);
      assert.equal(evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE, 'REQ-01'] }).outcome, 'unreadable');
    } finally { cleanup(dir); }
  });

  test('[independence] a readable config that disables the analysis is a delivered answer, not unreadable', () => {
    const dir = cleanProject();
    try {
      write(dir, '.planning/config.json', '{"workflow":{"post_planning_gaps":false}}');
      const verdict = evaluateGapAnalysisPlanPost({ projectDir: dir, args: [PHASE] });
      assert.equal(verdict.outcome, 'advisory');
      assert.equal(verdict.payload.enabled, false);
    } finally { cleanup(dir); }
  });

  test('[wired] through the CLI an unreadable evidence file exits UNAVAILABLE (69) and prints the table; the control exits 0', () => {
    const dir = cleanProject();
    try {
      const ok = runTools(['check', 'gap-analysis-plan-post', PHASE, 'REQ-01', '--raw'], dir);
      assert.equal(ok.exitCode, 0);
      cleanup(path.join(dir, '.planning/REQUIREMENTS.md'));
      mkdir(dir, '.planning/REQUIREMENTS.md');
      const bad = runTools(['check', 'gap-analysis-plan-post', PHASE, 'REQ-01', '--raw'], dir);
      assert.equal(bad.exitCode, 69);
      assert.equal(JSON.parse(bad.stdout).unreadable[0].reason, 'EISDIR');
    } finally { cleanup(dir); }
  });
});

describe('api-coverage.verify-pre: the phases-tree probe is evidence', () => {
  test('[control] no .planning/phases directory is `none`: the documented "not a GSD project" pass', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      cleanup(path.join(dir, '.planning', 'phases'));
      const verdict = evaluateApiCoverageVerifyPre({ projectDir: dir, args: ['01-x'] });
      assert.equal(verdict.outcome, 'pass');
      assert.equal(verdict.payload.coverage_present, false);
    } finally { cleanup(dir); }
  });

  test('[hostile] a phases tree that cannot be examined (EACCES on the stat) is unreadable and blocks, never "not a GSD project"', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      mkdir(dir, '.planning/phases/01-x');
      const verdict = withFsFailure('statSync', (p) => p.endsWith(path.join('.planning', 'phases')), 'EACCES', () =>
        evaluateApiCoverageVerifyPre({ projectDir: dir, args: ['01-x'] }));
      assert.equal(verdict.outcome, 'unreadable');
      assert.equal(verdict.block, true);
      assert.equal(verdict.payload.read_error, 'EACCES');
    } finally { cleanup(dir); }
  });

  test('[hostile] a phase directory that cannot be examined is an unreadable scope, not an absent one', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      mkdir(dir, '.planning/phases/01-x');
      const verdict = withFsFailure('statSync', (p) => p.endsWith(path.join('phases', '01-x')), 'EACCES', () =>
        evaluateApiCoverageVerifyPre({ projectDir: dir, args: ['01-x'] }));
      assert.equal(verdict.outcome, 'unreadable');
      assert.equal(verdict.block, true);
    } finally { cleanup(dir); }
  });
});

describe('decision-coverage: the CONTEXT.md probe is evidence', () => {
  test('[control] an absent CONTEXT.md is `none`: the legitimate green skip in both gates', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      mkdir(dir, PHASE);
      const context = `${PHASE}/01-CONTEXT.md`;
      const plan = evaluateDecisionCoveragePlan({ projectDir: dir, args: [PHASE, context] });
      assert.equal(plan.outcome, 'skip');
      assert.equal(plan.payload.reason, 'CONTEXT.md missing');
      const verify = evaluateDecisionCoverageVerify({ projectDir: dir, args: [PHASE, context] });
      assert.equal(verify.outcome, 'skip');
      assert.equal(verify.payload.reason, 'CONTEXT.md missing');
    } finally { cleanup(dir); }
  });

  test('[hostile] plan gate: a CONTEXT.md that cannot be examined (EACCES on a parent) is unreadable and blocks, not "missing"', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      write(dir, `${PHASE}/01-CONTEXT.md`, DECISIONS);
      const verdict = withFsFailure('statSync', (p) => p.endsWith('01-CONTEXT.md'), 'EACCES', () =>
        evaluateDecisionCoveragePlan({ projectDir: dir, args: [PHASE, `${PHASE}/01-CONTEXT.md`] }));
      assert.equal(verdict.outcome, 'unreadable');
      assert.equal(verdict.block, true);
      assert.notEqual(verdict.payload.reason, 'CONTEXT.md missing');
    } finally { cleanup(dir); }
  });

  test('[hostile] verify gate: a CONTEXT.md path that is a directory (EISDIR) is unreadable, never the "missing" skip', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      mkdir(dir, `${PHASE}/01-CONTEXT.md`);
      const verdict = evaluateDecisionCoverageVerify({ projectDir: dir, args: [PHASE, `${PHASE}/01-CONTEXT.md`] });
      assert.equal(verdict.outcome, 'unreadable');
      assert.equal(verdict.block, false);
    } finally { cleanup(dir); }
  });

  test('[hostile] verify gate: a read failure on CONTEXT.md (EACCES) is unreadable, never the "missing" skip', () => {
    const dir = createTempProject('gate-tolerant-');
    try {
      write(dir, `${PHASE}/01-CONTEXT.md`, DECISIONS);
      const verdict = withFsFailure('readFileSync', (p) => p.endsWith('01-CONTEXT.md'), 'EACCES', () =>
        evaluateDecisionCoverageVerify({ projectDir: dir, args: [PHASE, `${PHASE}/01-CONTEXT.md`] }));
      assert.equal(verdict.outcome, 'unreadable');
    } finally { cleanup(dir); }
  });
});

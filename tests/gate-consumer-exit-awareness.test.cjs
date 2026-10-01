'use strict';

/**
 * #5170 (Phase 8 of epic #5056): every shell consumer of a gate verb is exit-status aware.
 *
 * The verbs now report what they could not do through the exit status — `69` (UNAVAILABLE) when a gate
 * could not look, `66` (NO_INPUT) for a genuinely empty scope, `1` for a negative verdict — and a
 * consumer that ignores the status reads "could not look" as "nothing there". Each documented capture
 * is extracted from its workflow / reference / agent file and run under bash (under `set -e`, which is
 * how an agent shell may run it) with a stub `gsd_run` returning each status:
 *
 *   - a verdict (`0`, `1`, and for the empty-scope verbs `66`) is captured and the script continues;
 *   - a gate that could not look (`69`, and any other non-zero) is NEVER read as an empty or clean
 *     answer: the fail-closed consumers stop, the advisory ones say so on stderr.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');

const SKIP = skipUnless('bash', 'node');
const UNRESOLVABLE = '{"status":"unresolvable","reason":"git-unavailable","commits":[],"files":[]}';
const ONE_COMMIT = '{"status":"resolved","commits":[{"sha":"abc1234567890","subject":"feat(3-1): panel"}]}';
const NO_COMMITS = '{"status":"resolved","commits":[]}';

const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const RECONCILE = 'gsd-core/workflows/execute-phase/steps/completion-reconciliation.md';
const EXECUTE_PLAN = 'gsd-core/workflows/execute-plan.md';

describe('safe_resume_gate: an unresolvable plan scope fails closed instead of reading as "no commits" (execute-phase.md)', { skip: SKIP }, () => {
  const lines = () => span(EXECUTE_PHASE, 'PLAN_SCOPE=$(gsd_run check evaluation-scope', 'PLAN_COMMITS=$(printf');
  const probe = 'printf "COMMITS=[%s]\\n" "$PLAN_COMMITS"';
  const preamble = ['PHASE_NUMBER=3'];

  test('exit 0 with commits: they are listed, newest first', () => {
    const r = runBash(lines(), { stdout: ONE_COMMIT, rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^COMMITS=\[abc1234567 feat\(3-1\): panel\]$/m);
  });

  test('exit 0 with none: the empty list is a real answer and the gate continues', () => {
    const r = runBash(lines(), { stdout: NO_COMMITS, rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^COMMITS=\[\]$/m);
  });

  test('exit 69 (could not look) stops the gate before any executor is dispatched, and says why', () => {
    const r = runBash(lines(), { stdout: UNRESOLVABLE, rc: 69 }, { preamble, probe });
    assert.equal(r.status, 1, 'the gate halts');
    assert.match(r.stderr, /SAFE-RESUME GATE: could not resolve the plan's commits \(evaluation-scope exit 69\)/);
    assert.ok(!/^COMMITS=/m.test(r.stdout), 'an empty list must never be read after the halt');
  });

  test('exit 68 and 70 (limit-1 / limit+1 of UNAVAILABLE) are command failures too', () => {
    for (const rc of [68, 70]) {
      const r = runBash(lines(), { stdout: NO_COMMITS, rc }, { preamble, probe });
      assert.equal(r.status, 1, `exit ${rc}`);
      assert.ok(!/^COMMITS=/m.test(r.stdout), `exit ${rc}: nothing read`);
    }
  });
});

describe('TDD gate: an unresolvable plan scope is "unavailable", not "missing RED commit" (execute-phase.md)', { skip: SKIP }, () => {
  const lines = () => span(EXECUTE_PHASE, 'RED_SCOPE=$(gsd_run check evaluation-scope', 'RED_COMMIT=$(printf');
  const probe = 'printf "RED=[%s]\\n" "$RED_COMMIT"';
  const preamble = ['PHASE_NUMBER=3; PLAN_ID=01; TASK_ID=2'];

  test('exit 0 with a test-file commit: it is the RED commit', () => {
    const r = runBash(lines(), { stdout: ONE_COMMIT, rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RED=\[abc1234567 feat\(3-1\): panel\]$/m);
  });

  test('exit 0 with none: RED is empty (the caller trips with its own "missing RED commit" message)', () => {
    const r = runBash(lines(), { stdout: NO_COMMITS, rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RED=\[\]$/m);
  });

  test('exit 69 halts with the UNAVAILABLE message, which is not the missing-RED message', () => {
    const r = runBash(lines(), { stdout: UNRESOLVABLE, rc: 69 }, { preamble, probe });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TDD GATE UNAVAILABLE: could not resolve the plan's commits for 01\/2 \(evaluation-scope exit 69\)/);
    assert.ok(!/missing RED commit/.test(r.stdout + r.stderr));
    assert.ok(!/^RED=/m.test(r.stdout));
  });
});

describe('completion reconciliation probe: exit 69 is visible, never an empty COMMITS_FOUND (completion-reconciliation.md)', { skip: SKIP }, () => {
  const lines = () => span(RECONCILE, 'COMMITS_SCOPE=$(gsd_run check evaluation-scope', 'if [ "$COMMITS_SCOPE_RC" -eq 0 ]');
  const probe = 'printf "FOUND=[%s] RC=%s\\n" "$COMMITS_FOUND" "$COMMITS_SCOPE_RC"';
  const preamble = ['EXPECTED_BRANCH=main'];

  test('exit 0: the matching commit is found', () => {
    const r = runBash(lines(), { stdout: ONE_COMMIT, rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^FOUND=\[abc1234567890\] RC=0$/m);
  });

  test('exit 69: the script survives set -e, COMMITS_FOUND is empty and COMMITS_SCOPE_RC says why it is empty', () => {
    const r = runBash(lines(), { stdout: UNRESOLVABLE, rc: 69 }, { preamble, probe });
    assert.equal(r.status, 0, `the capture must not abort: ${r.stderr}`);
    assert.match(r.stdout, /^FOUND=\[\] RC=69$/m);
  });

  test('exit 1 (a command failure) is distinguishable from "no commits" the same way', () => {
    const r = runBash(lines(), { stdout: '', rc: 1 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^FOUND=\[\] RC=1$/m);
  });

  test('exit 0 with an empty list: no commits, RC 0 (the two empties are told apart)', () => {
    const r = runBash(lines(), { stdout: NO_COMMITS, rc: 0 }, { preamble, probe });
    assert.match(r.stdout, /^FOUND=\[\] RC=0$/m);
  });
});

describe('execute-plan codebase-map file list: an unavailable scope is a warning, not "nothing changed" (execute-plan.md)', { skip: SKIP }, () => {
  const lines = () => span(EXECUTE_PLAN, 'SCOPE_JSON=$(gsd_run check evaluation-scope --phase-dir', 'if [ "$SCOPE_RC" -ne 0 ]');

  test('exit 0: the changed files are printed one per line', () => {
    const r = runBash(lines(), { stdout: '{"status":"resolved","changedFiles":["src/a.ts","src/b.ts"]}', rc: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'src/a.ts\nsrc/b.ts');
    assert.equal(r.stderr, '');
  });

  test('exit 69: nothing on stdout, a warning on stderr naming the status, and the script goes on', () => {
    const r = runBash(lines(), { stdout: UNRESOLVABLE, rc: 69 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Warning: evaluation scope unavailable \(exit 69\)/);
  });
});

describe('plan-phase drift pre-checks: a check that could not look warns instead of silently reading "nothing to compare"', { skip: SKIP }, () => {
  for (const [name, marker] of [
    ['context-drift', 'DRIFT=$(gsd_run verify context-drift'],
    ['codebase-drift', 'DRIFT=$(gsd_run verify codebase-drift'],
  ]) {
    test(`${name}: exit 0 keeps the verdict JSON`, () => {
      const lines = span('gsd-core/workflows/plan-phase.md', marker, marker);
      const r = runBash(lines, { stdout: '{"block":false,"skipped":false}', rc: 0 }, { preamble: ['PHASE=3'], probe: 'printf "%s" "$DRIFT"' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '{"block":false,"skipped":false}');
    });

    test(`${name}: exit 69 survives set -e, yields the skipped fallback ONCE (no concatenated JSON) and warns`, () => {
      const lines = span('gsd-core/workflows/plan-phase.md', marker, marker);
      const r = runBash(lines, { stdout: '{"block":false,"skipped":true,"reason":"phase-not-found"}', rc: 69 }, { preamble: ['PHASE=3'], probe: 'printf "%s" "$DRIFT"' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '{"skipped":true}');
      assert.match(r.stderr, new RegExp(`Warning: ${name} check could not look \\(exit 69\\)`));
    });
  }
});

describe('plan-phase decision-coverage-plan gate: a gate that could not run stops instead of passing (plan-phase.md)', { skip: SKIP }, () => {
  const lines = () => span('gsd-core/workflows/plan-phase.md', 'GATE_RESULT=$(gsd_run query check.decision-coverage-plan', 'fi');
  const probe = 'printf "REACHED\\n"';
  const preamble = ['PHASE_DIR=p; CONTEXT_PATH=c'];

  test('exit 0: the gate falls through to its own verdict handling', () => {
    const r = runBash(lines(), { stdout: '{"passed":true}', rc: 0 }, { preamble, probe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REACHED/);
  });

  test('exit 69 (could not read its evidence) stops with the gate\'s output surfaced', () => {
    const r = runBash(lines(), { stdout: '{"passed":false,"reason":"unreadable evidence"}', rc: 69 }, { preamble, probe });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Decision coverage gate could not run \(exit 69\)/);
    assert.ok(!/REACHED/.test(r.stdout));
  });
});

describe('capture-and-continue consumers: a verdict is read under set -e, the status is kept (agents and references)', { skip: SKIP }, () => {
  const CAPTURES = [
    ['gsd-verifier verify.artifacts', 'agents/gsd-verifier.md', 'ARTIFACT_RESULT=$(gsd_run query verify.artifacts', 'ARTIFACT_RESULT', 'ARTIFACT_EXIT'],
    ['gsd-verifier verify.key-links', 'agents/gsd-verifier.md', 'LINKS_RESULT=$(gsd_run query verify.key-links', 'LINKS_RESULT', 'LINKS_EXIT'],
    ['gsd-verifier verify.commits', 'agents/gsd-verifier.md', 'COMMITS_VALID=$(gsd_run query verify.commits', 'COMMITS_VALID', 'COMMITS_EXIT'],
    ['gsd-plan-checker verify.plan-structure (loop)', 'agents/gsd-plan-checker.md', 'PLAN_STRUCTURE=$(gsd_run query verify.plan-structure "$plan")', 'PLAN_STRUCTURE', 'STRUCTURE_EXIT'],
    ['gsd-plan-checker verify.plan-structure (step 5)', 'agents/gsd-plan-checker.md', 'PLAN_STRUCTURE=$(gsd_run query verify.plan-structure "$PLAN_PATH")', 'PLAN_STRUCTURE', 'STRUCTURE_EXIT'],
    ['gsd-planner verify.plan-structure', 'agents/gsd-planner.md', 'STRUCTURE=$(gsd_run query verify.plan-structure', 'STRUCTURE', 'STRUCTURE_EXIT'],
    ['verifier-phase-gates decision-coverage-verify', 'gsd-core/references/verifier-phase-gates.md', 'DECISION_RESULT=$(gsd_run query check.decision-coverage-verify', 'DECISION_RESULT', 'DECISION_EXIT'],
  ];

  for (const [name, file, marker, resultVar, exitVar] of CAPTURES) {
    test(`${name}: exit 0, 1, 66 and 69 are all captured and the script continues`, () => {
      for (const rc of [0, 1, 66, 69]) {
        const r = runBash(span(file, marker, marker), { stdout: '{"v":1}', rc }, {
          preamble: ['PLAN_PATH=p; plan=p; PHASE_DIR=d; CONTEXT_PATH=c; COMMIT_HASHES=abc1234'],
          probe: `printf "%s|%s" "$${resultVar}" "$${exitVar}"`,
        });
        assert.equal(r.status, 0, `exit ${rc} must not abort a capture: ${r.stderr}`);
        assert.equal(r.stdout, `{"v":1}|${rc}`, `exit ${rc}: the JSON and the status are both kept`);
      }
    });
  }

  test('autonomous UI gate: the status is captured, so exit 69 is not read as "frontend: false"', () => {
    const marker = 'GATE=$(gsd_run check ui-plan-gate';
    const r = runBash(span('gsd-core/references/autonomous-ui-design-contract.md', marker, marker), { stdout: '{"frontend":false,"outcome":"unreadable"}', rc: 69 }, {
      setE: false,
      preamble: ['PHASE_NUM=3'],
      probe: 'printf "EXIT=%s" "$GATE_EXIT"',
    });
    assert.equal(r.stdout, 'EXIT=69');
  });
});

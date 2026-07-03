// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for --forensic flag on /gsd-progress (#2189)
 *
 * The --forensic flag appends a 6-check integrity audit after the standard
 * progress report. Default behavior (no flag) is unchanged.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('#2189: progress --forensic flag', () => {
  test('progress command argument-hint includes --forensic', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'), 'utf8'
    );
    assert.ok(command.includes('--forensic'), 'argument-hint should include --forensic');
  });

  test('progress workflow has a forensic_audit step', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    assert.ok(
      workflow.includes('<step name="forensic_audit">'),
      'workflow should have a forensic_audit step'
    );
  });

  test('forensic_audit step is only triggered when --forensic is present', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    const forensicStep = workflow.slice(
      workflow.indexOf('<step name="forensic_audit">'),
      workflow.indexOf('</step>', workflow.indexOf('<step name="forensic_audit">'))
    );
    assert.ok(
      forensicStep.includes('--forensic'),
      'forensic_audit step should be gated on --forensic flag'
    );
    assert.ok(
      forensicStep.includes('Skip') || forensicStep.includes('skip') || forensicStep.includes('exit'),
      'forensic_audit step should skip when --forensic is not present'
    );
  });

  test('forensic_audit step includes all 6 checks', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    const forensicStep = workflow.slice(
      workflow.indexOf('<step name="forensic_audit">'),
      workflow.indexOf('</step>', workflow.indexOf('<step name="forensic_audit">'))
    );
    // Check 1: STATE vs artifact consistency
    assert.ok(
      forensicStep.includes('STATE') && (forensicStep.includes('artifact') || forensicStep.includes('consistent')),
      'forensic step should check STATE vs artifact consistency (check 1)'
    );
    // Check 2: Orphaned handoff files
    assert.ok(
      forensicStep.includes('HANDOFF') || forensicStep.includes('handoff'),
      'forensic step should check for orphaned handoff files (check 2)'
    );
    // Check 3: Deferred scope drift
    assert.ok(
      forensicStep.includes('deferred') || forensicStep.includes('defer'),
      'forensic step should check for deferred scope drift (check 3)'
    );
    // Check 4: Memory-flagged pending work
    assert.ok(
      forensicStep.includes('MEMORY') || forensicStep.includes('memory') || forensicStep.includes('pending'),
      'forensic step should check memory-flagged pending work (check 4)'
    );
    // Check 5: Blocking todos
    assert.ok(
      forensicStep.includes('todo') || forensicStep.includes('Todo') || forensicStep.includes('TODO'),
      'forensic step should check blocking operational todos (check 5)'
    );
    // Check 6: Uncommitted code
    assert.ok(
      forensicStep.includes('uncommitted') || forensicStep.includes('git status'),
      'forensic step should check for uncommitted code (check 6)'
    );
  });

  test('forensic_audit step produces a CLEAN or INTEGRITY ISSUE(S) FOUND verdict', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    const forensicStep = workflow.slice(
      workflow.indexOf('<step name="forensic_audit">'),
      workflow.indexOf('</step>', workflow.indexOf('<step name="forensic_audit">'))
    );
    assert.ok(
      forensicStep.includes('CLEAN'),
      'forensic step should produce a CLEAN verdict when all checks pass'
    );
    assert.ok(
      forensicStep.includes('INTEGRITY ISSUE') || forensicStep.includes('integrity issue'),
      'forensic step should surface INTEGRITY ISSUE when checks fail'
    );
  });

  test('forensic_audit step does not change default progress behavior', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    // The forensic step must explicitly say default behavior is unchanged
    const forensicStep = workflow.slice(
      workflow.indexOf('<step name="forensic_audit">'),
      workflow.indexOf('</step>', workflow.indexOf('<step name="forensic_audit">'))
    );
    assert.ok(
      forensicStep.includes('unchanged') || forensicStep.includes('standard report'),
      'forensic step should clarify that default behavior is unchanged'
    );
  });

  test('COMMANDS.md documents --forensic flag for gsd-progress', () => {
    const commands = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'COMMANDS.md'), 'utf8'
    );
    assert.ok(
      commands.includes('--forensic'),
      'COMMANDS.md should document --forensic flag for gsd-progress'
    );
  });
});

/**
 * Regression — issue #1107
 *
 * /gsd-progress reported a phase as complete and routed to the next phase even
 * when its VERIFICATION.md ended `human_needed` / `gaps_found`, because routing
 * derived completeness from plan/summary counts only and never consulted the
 * `verification.status` query (built in #651). The fix adds a Step 1.7 consult
 * and routing rows that send non-`passed` phases back to close the debt.
 */
describe('#1107: progress routing consults verification.status before reporting complete', () => {
  function readWorkflow() {
    return fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
  }

  test('workflow consults verification.status for the current phase', () => {
    const workflow = readWorkflow();
    assert.ok(
      workflow.includes('verification.status'),
      'progress workflow must query verification.status (the #651 seam)'
    );
    assert.ok(
      workflow.includes('verification_status'),
      'progress workflow must track a verification_status value for routing'
    );
    assert.ok(
      workflow.includes('stale verification'),
      'progress workflow must document that verification.status projects stale verification'
    );
  });

  test('routing table has gaps_found and human_needed rows BEFORE the generic complete row', () => {
    const workflow = readWorkflow();
    const missingIdx = workflow.indexOf('verification_status = missing');
    const unknownIdx = workflow.indexOf('verification_status = unknown');
    const staleIdx = workflow.indexOf('verification_status = stale');
    const gapsIdx = workflow.indexOf('verification_status = gaps_found');
    const humanIdx = workflow.indexOf('verification_status = human_needed');
    const completeIdx = workflow.indexOf('Phase complete (verification passed)');
    assert.ok(missingIdx > -1, 'routing table must have a missing verification row');
    assert.ok(unknownIdx > -1, 'routing table must have an unknown verification row');
    assert.ok(staleIdx > -1, 'routing table must have a stale verification row');
    assert.ok(gapsIdx > -1, 'routing table must have a gaps_found row');
    assert.ok(humanIdx > -1, 'routing table must have a human_needed row');
    assert.ok(completeIdx > -1, 'routing table must keep a generic complete row');
    assert.ok(
      missingIdx < completeIdx &&
        unknownIdx < completeIdx &&
        staleIdx < completeIdx &&
        gapsIdx < completeIdx &&
        humanIdx < completeIdx,
      'verification rows must precede the generic "summaries = plans" complete row (first-match-wins)'
    );
  });

  test('gaps_found routes to plan-phase --gaps (Route V.gaps)', () => {
    const workflow = readWorkflow();
    // Anchor on the definition heading (`**Route V.gaps:`), not the routing-table
    // reference (`Go to **Route V.gaps**`).
    assert.ok(workflow.includes('**Route V.gaps:'), 'must define a Route V.gaps section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.gaps:'),
      workflow.indexOf('**Route V.human:')
    );
    assert.ok(
      route.includes('--gaps') && route.includes('plan-phase'),
      'Route V.gaps must route to /gsd:plan-phase {phase} --gaps'
    );
  });

  test('human_needed routes to verify-work (Route V.human)', () => {
    const workflow = readWorkflow();
    assert.ok(workflow.includes('**Route V.human:'), 'must define a Route V.human section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.human:'),
      workflow.indexOf('**Step 3', workflow.indexOf('**Route V.human:'))
    );
    assert.ok(
      route.includes('verify-work'),
      'Route V.human must route to /gsd:verify-work {phase}'
    );
  });

  test('stale verification routes to verify-work (Route V.stale)', () => {
    const workflow = readWorkflow();
    assert.ok(workflow.includes('**Route V.stale:'), 'must define a Route V.stale section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.stale:'),
      workflow.indexOf('**Route V.gaps:')
    );
    assert.ok(
      route.includes('verify-work'),
      'Route V.stale must route to /gsd:verify-work {phase}'
    );
  });

  test('missing and unknown verification do not route as complete', () => {
    const workflow = readWorkflow();
    assert.ok(
      workflow.includes('Phase complete (verification passed)'),
      'the generic complete row must only cover passed verification'
    );
    assert.ok(!workflow.includes('verification passed, missing, or n/a'),
      'missing or unknown verification must not be documented as complete');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3418-progress-flag-routing.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3418-progress-flag-routing (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3418)
// The command markdown is loaded directly by runtime prompt assembly.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('#3418: /gsd-progress flag routing prompt contract', () => {
  test('progress command surfaces raw arguments on a dedicated line before routing parse', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      command.includes('Arguments provided: "$ARGUMENTS"'),
      'progress.md must surface $ARGUMENTS on a dedicated line for stable flag parsing'
    );
  });

  test('progress command must not inline-substitute $ARGUMENTS into parse instruction text', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      !command.includes('Parse the first token of $ARGUMENTS:'),
      'progress.md must keep parse instructions independent from argument interpolation'
    );
  });
});
  });
}

// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * verify-work auto-transition tests (#2018)
 *
 * Validates that verify-work.md calls the transition workflow to mark the
 * phase complete in ROADMAP.md and STATE.md when UAT passes with 0 issues.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VERIFY_WORK = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');

describe('verify-work.md — auto-transition after UAT passes with 0 issues', () => {
  test('workflow reads transition.md when issues == 0 and security gate cleared', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    assert.ok(
      content.includes('transition.md'),
      'verify-work.md must reference transition.md for phase completion when issues == 0'
    );
  });

  test('transition call appears after complete_session section', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const completeSessionIdx = content.indexOf('complete_session');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      completeSessionIdx !== -1,
      'verify-work.md must contain a complete_session section'
    );
    assert.ok(
      transitionIdx !== -1,
      'verify-work.md must reference transition.md'
    );
    assert.ok(
      transitionIdx > completeSessionIdx,
      'transition.md reference must appear after the complete_session section'
    );
  });

  test('security gate check gates the transition (no auto-transition when security pending)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The capability-resolved security check must appear before the transition reference.
    const securityHookIdx = content.indexOf('loop render-hooks verify:post');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      securityHookIdx !== -1,
      'verify-work.md must resolve verify:post capability hooks before transitioning'
    );
    assert.ok(
      securityHookIdx < transitionIdx,
      'verify:post capability hook check must appear before transition.md reference'
    );
  });

  test('transition is only invoked when security gate is cleared or disabled', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // Transition must be guarded by security check:
    // Either no active secure-phase hook exists, or security file exists with 0 open threats.
    const hasGuardedTransition =
      content.includes('transition.md') &&
      (
        content.includes('loop render-hooks verify:post') &&
        content.includes('ref.skill == "secure-phase"') &&
        (content.includes('threats_open') || content.includes('SECURITY_FILE'))
      );
    assert.ok(
      hasGuardedTransition,
      'transition.md invocation must be guarded by security gate checks'
    );
  });

  test('auto-transition is gated by UAT plus canonical verification predicate', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const predicateIdx = content.indexOf('phase uat-passed');
    const requireVerificationIdx = content.indexOf('--require-verification');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(predicateIdx !== -1, 'verify-work.md must call phase uat-passed before transition');
    assert.ok(
      requireVerificationIdx > predicateIdx,
      'verify-work.md must require canonical verification in the UAT predicate'
    );
    assert.ok(
      predicateIdx < transitionIdx,
      'UAT-plus-verification predicate must run before transition.md'
    );
  });

  test('human_needed verification is promoted to passed only after successful human UAT', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const statusIdx = content.indexOf('VERIFICATION_STATUS=$(gsd_run query verification.status "$PHASE_DIR"');
    const humanNeededIdx = content.indexOf('if [ "$VERIFICATION_STATUS_VALUE" = "human_needed" ]; then');
    const setPassedIdx = content.indexOf('gsd_run query frontmatter.set "$VERIFICATION_FILE" --field status --value passed');
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');

    assert.ok(statusIdx !== -1, 'verify-work.md must inspect canonical verification status');
    assert.ok(humanNeededIdx > statusIdx, 'status=passed promotion must be restricted to human_needed');
    assert.ok(setPassedIdx > humanNeededIdx, 'human_needed verification must be promoted after status check');
    assert.ok(setPassedIdx < predicateIdx, 'verification must be canonicalized before the required predicate runs');
  });

  test('stale verification blocks before phase transition', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const staleIdx = content.indexOf('If `PHASE_VERIFICATION_STATUS` is `stale`');
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(staleIdx !== -1, 'verify-work.md must stop on stale verification');
    assert.ok(staleIdx < predicateIdx, 'stale verification must be checked before the required predicate');
    assert.ok(staleIdx < transitionIdx, 'stale verification must be checked before transition');
  });

  test('transition is NOT suggested when security enforcement is enabled and no SECURITY.md exists', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The workflow should suggest /gsd-secure-phase when security is enabled but no file exists
    assert.ok(
      content.includes('gsd-secure-phase') || content.includes('gsd:secure-phase'),
      'verify-work.md must suggest /gsd:secure-phase when security gate blocks transition'
    );
  });
});

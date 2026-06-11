/**
 * Tests that autonomous.md includes ui-phase and ui-review steps for frontend phases.
 *
 * Issue #1375: autonomous workflow skips ui-phase and ui-review for frontend phases.
 * The per-phase execution loop should be: discuss -> ui-phase -> plan -> execute -> verify -> ui-review
 * for phases with frontend indicators.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');

describe('autonomous workflow ui-phase and ui-review integration (#1375)', () => {
  let content;

  beforeEach(() => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/autonomous.md should exist');
    content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  });

  describe('step 3a.5 — UI design contract before planning', () => {
    test('autonomous.md contains a UI design contract step between discuss and plan', () => {
      assert.ok(
        content.includes('3a.5'),
        'should have step 3a.5 for UI design contract'
      );
    });

    test('UI design contract step detects frontend indicators via shell-free Node gate (#3718)', () => {
      // After #3718: the gate is implemented in bin/lib/ui-safety-gate.cjs (Node.js)
      // piped from stdin, avoiding silent failure on Windows PowerShell and ARG_MAX.
      // After #448: the helper is resolved against the GSD install dir (RUNTIME_DIR),
      // not the consuming project's git root, so it is actually found at runtime.
      assert.ok(
        content.includes('ui-safety-gate.cjs'),
        'should invoke shell-free Node gate for cross-platform portability (#3718)'
      );
      assert.ok(
        content.includes('RUNTIME_DIR'),
        'should resolve the gate helper against the GSD install dir (RUNTIME_DIR), not the consuming project root (#448)'
      );
    });

    test('UI design contract step checks for existing UI-SPEC.md', () => {
      assert.ok(
        content.includes('UI-SPEC.md'),
        'should check for existing UI-SPEC.md'
      );
    });

    test('UI design contract step respects workflow.ui_phase config toggle', () => {
      assert.ok(
        content.includes('workflow.ui_phase'),
        'should respect workflow.ui_phase config toggle'
      );
    });

    test('UI design contract step invokes gsd:ui-phase skill', () => {
      assert.ok(
        content.includes('skill="gsd-ui-phase"'),
        'should invoke gsd-ui-phase via Skill()'
      );
    });

    test('UI design contract step appears before plan step (3b)', () => {
      const uiPhasePos = content.indexOf('3a.5');
      const planPos = content.indexOf('**3b. Plan**');
      assert.ok(
        uiPhasePos < planPos,
        'step 3a.5 (UI design contract) should appear before step 3b (plan)'
      );
    });
  });

  describe('step 3d.5 — UI review after execution', () => {
    test('autonomous.md contains a UI review step after execution', () => {
      assert.ok(
        content.includes('3d.5'),
        'should have step 3d.5 for UI review'
      );
    });

    test('UI review step dispatches loop render-hooks verify:post', () => {
      // Phase 6 cutover: §3d.5 now dispatches render-hooks verify:post instead of
      // inlining a direct skill="gsd-ui-review" call.
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('loop render-hooks verify:post'),
        'UI review step should dispatch loop render-hooks verify:post to resolve active hooks'
      );
    });

    test('UI review step constructs skill via gsd- prefix dispatch and is non-blocking', () => {
      // Phase 6 cutover: §3d.5 dispatches loop render-hooks verify:post, invokes skills via
      // gsd-${ref.skill} prefix, gates on UI_SPEC_FILE for consumes:UI-SPEC.md hooks,
      // and is explicitly advisory/non-blocking.
      // All four properties must be present within the §3d.5 section itself.
      const sectionStart = content.indexOf('3d.5');
      // Bound to the closing </step> tag of the execute_phase step
      const sectionEnd = content.indexOf('</step>', sectionStart);
      assert.ok(sectionStart !== -1, '§3d.5 heading must be present in autonomous.md');
      assert.ok(sectionEnd !== -1, '</step> must follow §3d.5');
      const reviewSection = content.slice(sectionStart, sectionEnd);

      assert.ok(
        reviewSection.includes('loop render-hooks verify:post'),
        '§3d.5 must dispatch `loop render-hooks verify:post` to resolve active capability hooks'
      );
      assert.ok(
        reviewSection.includes('gsd-${ref.skill}'),
        '§3d.5 must construct skill name via `gsd-${ref.skill}` prefix (capability-driven dispatch)'
      );
      assert.ok(
        reviewSection.includes('UI_SPEC_FILE'),
        '§3d.5 must gate on UI_SPEC_FILE for hooks that consume UI-SPEC.md'
      );
      assert.ok(
        reviewSection.includes('advisory') || reviewSection.includes('non-blocking') || reviewSection.includes('regardless of result'),
        '§3d.5 must be explicitly advisory/non-blocking'
      );
    });

    test('UI review step gates on UI-SPEC file via consumes check', () => {
      // The consumes:[UI-SPEC.md] gate is still enforced; UI_SPEC_FILE is still defined
      // and used as the precondition for hooks that consume UI-SPEC.md.
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('UI_SPEC_FILE'),
        'UI review step should still gate on UI_SPEC_FILE for hooks that consume UI-SPEC.md'
      );
      assert.ok(
        reviewSection.includes('consumes'),
        'UI review step should reference hook consumes array for the UI-SPEC gate'
      );
    });

    test('UI review step respects workflow.ui_review config toggle (resolved via render-hooks)', () => {
      // Phase 6 cutover: workflow.ui_review is no longer inlined as `config-get workflow.ui_review`.
      // Instead, §3d.5 calls `loop render-hooks verify:post` which internally honours the
      // `when: workflow.ui_review` field declared in the capability registry.
      // The §3d.5 section must use render-hooks (not a literal `config-get workflow.ui_review`)
      // so the toggle is resolved by the capability system, not duplicated inline.
      const sectionStart = content.indexOf('3d.5');
      const sectionEnd = content.indexOf('</step>', sectionStart);
      assert.ok(sectionStart !== -1, '§3d.5 heading must be present in autonomous.md');
      assert.ok(sectionEnd !== -1, '</step> must follow §3d.5');
      const reviewSection = content.slice(sectionStart, sectionEnd);

      assert.ok(
        reviewSection.includes('render-hooks'),
        '§3d.5 must resolve the workflow.ui_review toggle via render-hooks (not inline config-get)'
      );
      assert.ok(
        !reviewSection.includes('config-get workflow.ui_review'),
        '§3d.5 must NOT inline `config-get workflow.ui_review` — the toggle is owned by the capability registry'
      );
    });

    test('UI review is advisory (non-blocking)', () => {
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('advisory') || reviewSection.includes('non-blocking') || reviewSection.includes('regardless of result'),
        'UI review should be advisory and not block phase progression'
      );
    });

    test('UI review step appears after execution routing (3d)', () => {
      const executeRouting = content.indexOf('**3d. Post-Execution Routing**');
      const uiReviewPos = content.indexOf('3d.5');
      assert.ok(
        uiReviewPos > executeRouting,
        'step 3d.5 (UI review) should appear after step 3d (post-execution routing)'
      );
    });
  });

  describe('success criteria updated', () => {
    test('success criteria includes UI-aware flow', () => {
      assert.ok(
        content.includes('ui-phase') && content.includes('ui-review'),
        'success criteria should reference ui-phase and ui-review'
      );
    });

    test('success criteria mentions frontend phases get UI-SPEC before planning', () => {
      assert.ok(
        content.includes('Frontend phases') || content.includes('frontend phases'),
        'success criteria should mention frontend phases'
      );
    });

    test('success criteria notes UI review is advisory', () => {
      const criteriaSection = content.slice(content.indexOf('<success_criteria>'));
      assert.ok(
        criteriaSection.includes('advisory') || criteriaSection.includes('non-blocking'),
        'success criteria should note UI review is advisory/non-blocking'
      );
    });
  });
});

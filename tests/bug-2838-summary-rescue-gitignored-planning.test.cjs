/**
 * Regression tests for #2838: SUMMARY rescue silently fails when .planning/
 * is gitignored.
 *
 * After #3797: execute-phase.md and quick.md delegate worktree cleanup to the
 * SDK's worktree.cleanup-wave command. The SDK's executeWorktreeWaveCleanupPlan
 * handles SUMMARY rescue internally using a filesystem-level find+cp approach
 * (bypassing gitignore) rather than the old git ls-files --exclude-standard
 * form that silently dropped gitignored files.
 *
 * The inline "Safety net" shell rescue block that was previously in both
 * workflow files has been removed — it was part of the SDK-absence fallback
 * which is now dead code since preflight exits if neither local nor global SDK
 * is available.
 *
 * This test file verifies that both workflows correctly delegate to the SDK
 * for SUMMARY rescue, and that neither workflow retains the broken inline form.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE_PATH = path.join(REPO_ROOT, 'get-shit-done', 'workflows', 'execute-phase.md');
const QUICK_PATH = path.join(REPO_ROOT, 'get-shit-done', 'workflows', 'quick.md');

/**
 * Parse a workflow markdown file into a structured contract object.
 * Returns typed boolean fields so tests assert on structure, not raw text.
 */
function parseWorkflowContract(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  return {
    // Non-empty check
    nonEmpty: lines.length > 0 && lines.some(l => l.length > 0),
    // Does the workflow delegate SUMMARY rescue to worktree.cleanup-wave?
    delegatesToCleanupWave: lines.some(l => l.includes('worktree.cleanup-wave')),
    // Does the cleanup-wave invocation use || exit 1 (fail-closed)?
    cleanupWaveFailClosed: lines.some(
      l => /\$GSD_SDK query worktree\.cleanup-wave.*\|\| exit 1/.test(l),
    ),
    // Does the workflow still contain the broken ls-files --exclude-standard rescue form?
    hasBrokenLsFilesForm: lines.some(
      l => l.includes('ls-files --modified --others --exclude-standard'),
    ),
  };
}

const executePhaseContract = parseWorkflowContract(EXECUTE_PHASE_PATH);
const quickContract = parseWorkflowContract(QUICK_PATH);

describe('bug-2838: SUMMARY rescue delegates to SDK (worktree.cleanup-wave)', () => {

  test('execute-phase.md is readable', () => {
    assert.ok(executePhaseContract.nonEmpty, 'execute-phase.md must not be empty');
  });

  test('quick.md is readable', () => {
    assert.ok(quickContract.nonEmpty, 'quick.md must not be empty');
  });

  test('execute-phase.md delegates SUMMARY rescue to SDK (worktree.cleanup-wave)', () => {
    // After #3797: worktree.cleanup-wave handles SUMMARY rescue via find+cp
    // (bypasses gitignore, fixing the #2838 bug). The workflow delegates to the
    // SDK rather than implementing rescue inline.
    assert.ok(
      executePhaseContract.delegatesToCleanupWave,
      'execute-phase.md must delegate to worktree.cleanup-wave for SUMMARY rescue (#2838/#3797)',
    );
  });

  test('quick.md delegates SUMMARY rescue to SDK (worktree.cleanup-wave)', () => {
    // After #3797: worktree.cleanup-wave handles SUMMARY rescue via find+cp
    // (bypasses gitignore, fixing the #2838 bug).
    assert.ok(
      quickContract.delegatesToCleanupWave,
      'quick.md must delegate to worktree.cleanup-wave for SUMMARY rescue (#2838/#3797)',
    );
  });

  test('execute-phase.md does not retain broken git ls-files --exclude-standard rescue form (#2838)', () => {
    // The broken form used --exclude-standard which silently filtered out
    // gitignored .planning/ files — the root cause of #2838.
    assert.ok(
      !executePhaseContract.hasBrokenLsFilesForm,
      'execute-phase.md must not use ls-files --exclude-standard for SUMMARY rescue (broken for gitignored .planning/)',
    );
  });

  test('quick.md does not retain broken git ls-files --exclude-standard rescue form (#2838)', () => {
    assert.ok(
      !quickContract.hasBrokenLsFilesForm,
      'quick.md must not use ls-files --exclude-standard for SUMMARY rescue (broken for gitignored .planning/)',
    );
  });

  test('execute-phase.md cleanup-wave uses || exit 1 (fail-closed so rescue errors surface)', () => {
    // If the SDK's rescue fails (e.g. filesystem error), || exit 1 surfaces
    // the failure to the orchestrator rather than silently continuing and
    // losing the SUMMARY.
    assert.ok(
      executePhaseContract.cleanupWaveFailClosed,
      'execute-phase.md cleanup-wave must use || exit 1 so SUMMARY rescue failures surface (#2838/#3797)',
    );
  });

  test('quick.md cleanup-wave uses || exit 1 (fail-closed so rescue errors surface)', () => {
    assert.ok(
      quickContract.cleanupWaveFailClosed,
      'quick.md cleanup-wave must use || exit 1 so SUMMARY rescue failures surface (#2838/#3797)',
    );
  });
});

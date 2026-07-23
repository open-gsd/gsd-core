// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - chain flag preservation in plan-phase
 *
 * Validates that plan-phase.md correctly handles the --chain flag
 * so that discuss→plan→execute auto-advance works without manual
 * intervention.
 *
 * Closes: #1620
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('plan-phase chain flag preservation (#1620)', () => {
  const planPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
  const discussPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase.md');
  // After the discuss-phase/modes split (#717), discuss-phase chain logic moved to modes/chain.md.
  const discussChainPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase', 'modes', 'chain.md');
  const readDiscuss = () => {
    // Fail loudly if either source is missing — silent filtering would let a
    // regression that deletes modes/chain.md pass this whole suite.
    assert.ok(fs.existsSync(discussPath), `discuss-phase.md missing: ${discussPath}`);
    assert.ok(fs.existsSync(discussChainPath), `discuss-phase/modes/chain.md missing after discuss-phase/modes split: ${discussChainPath}`);
    return [discussPath, discussChainPath].map(p => fs.readFileSync(p, 'utf8')).join('\n');
  };

  test('plan-phase sync-flag guard checks both --auto AND --chain', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    // The guard that clears _auto_chain_active must require BOTH flags to be absent
    assert.ok(
      content.includes('if [[ ! "$ARGUMENTS" =~ --auto ]] && [[ ! "$ARGUMENTS" =~ --chain ]]; then'),
      'plan-phase should check for both --auto and --chain before clearing chain flag'
    );
  });

  test('plan-phase persists chain flag to config before auto-advancing', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    // Plan-phase must persist the chain flag (config-set workflow._auto_chain_active true)
    assert.ok(
      content.includes('config-set workflow._auto_chain_active true'),
      'plan-phase should persist chain flag via config-set workflow._auto_chain_active true'
    );
  });

  test('plan-phase and discuss-phase use the same guard pattern for clearing _auto_chain_active', () => {
    const planContent = fs.readFileSync(planPath, 'utf8');
    const discussContent = readDiscuss();

    const guardPattern = 'if [[ ! "$ARGUMENTS" =~ --auto ]] && [[ ! "$ARGUMENTS" =~ --chain ]]; then';

    assert.ok(
      planContent.includes(guardPattern),
      'plan-phase should use the dual-flag guard pattern'
    );
    assert.ok(
      discussContent.includes(guardPattern),
      'discuss-phase (or discuss-phase/modes/chain.md after the discuss-phase/modes split) should use the dual-flag guard pattern'
    );
  });

  test('plan-phase auto-advance trigger includes --chain flag', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    // The trigger condition should mention --chain alongside --auto
    assert.ok(
      content.includes('`--auto` or `--chain` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true'),
      'plan-phase auto-advance trigger should check for --chain flag'
    );
  });

  test('plan-phase parses both --auto and --chain flags', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    assert.ok(
      content.includes('Parse `--auto` and `--chain` flags from $ARGUMENTS'),
      'plan-phase step 15 should parse both --auto and --chain flags'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2388-plan-phase-no-branch-rename.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2388-plan-phase-no-branch-rename (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2388)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2388: plan-phase silently renames feature branch
 * when phase slug has changed since the branch was created.
 *
 * Fix: plan-phase.md must include an explicit instruction not to create,
 * rename, or switch git branches during the planning workflow.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');

describe('bug-2388: plan-phase must not rename or create git branches', () => {
  test('plan-phase.md exists', () => {
    assert.ok(fs.existsSync(PLAN_PHASE_PATH), 'plan-phase.md should exist');
  });

  test('plan-phase.md contains explicit no-branch-rename instruction', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Must say "do not" and mention branch in the context of phase slug/rename
    const hasBranchGuard = (
      /do not.{0,80}branch/i.test(content) ||
      /branch.{0,80}do not/i.test(content) ||
      /NEVER.{0,80}branch/i.test(content) ||
      /branch.{0,80}NEVER/i.test(content)
    );
    assert.ok(
      hasBranchGuard,
      'plan-phase.md must include an explicit instruction not to create or rename git branches'
    );
  });

  test('plan-phase.md mentions phase rename does not affect branch name', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Should explain that a phase rename in ROADMAP.md is plan-level, not git-level
    const hasPlanLevelExplanation = (
      content.includes('phase rename') ||
      content.includes('phase_slug') ||
      content.includes('branch identity') ||
      content.includes('branch name')
    );
    assert.ok(
      hasPlanLevelExplanation,
      'plan-phase.md should clarify that phase slug changes do not change the git branch'
    );
  });

  test('plan-phase.md does not contain git checkout -b instruction', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // The workflow should not instruct the LLM to run git checkout -b
    assert.ok(
      !content.includes('git checkout -b'),
      'plan-phase.md must not instruct LLM to create a new branch via git checkout -b'
    );
  });
});
  });
}

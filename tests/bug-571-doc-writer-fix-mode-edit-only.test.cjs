/**
 * Regression tests for bug #571
 *
 * gsd-doc-writer in fix mode used the Write tool (whole-file replace) instead
 * of the Edit tool (surgical replacement) when correcting specific failing
 * claims. When the target doc was generated but not yet committed, Write could
 * truncate the file to a single line with no git recovery path.
 *
 * Fix 1 (agent): Add Edit to the tools frontmatter and rewrite fix_mode
 *   instructions to mandate Edit and explicitly forbid Write on existing files.
 * Fix 2 (workflow): Add a post-fix line-count guard in fix_loop that detects
 *   >90% shrinkage and restores the file from existing_content.
 */

'use strict';

// allow-test-rule: source-text-is-the-product
// Agent .md files are the installed AI agents — their frontmatter and body IS
// what the runtime loads. Checking text content IS checking the deployed contract.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

const AGENT_PATH = path.join(AGENTS_DIR, 'gsd-doc-writer.md');
const WORKFLOW_PATH = path.join(WORKFLOWS_DIR, 'docs-update.md');

// ─── Agent fix: Edit in tools frontmatter ────────────────────────────────────

describe('bug #571: gsd-doc-writer agent', () => {
  const content = fs.readFileSync(AGENT_PATH, 'utf-8');

  test('agent file exists', () => {
    assert.ok(fs.existsSync(AGENT_PATH), 'agents/gsd-doc-writer.md must exist');
  });

  test('tools frontmatter includes Edit', () => {
    const toolsMatch = content.match(/^tools:\s*(.+)$/m);
    assert.ok(toolsMatch, 'gsd-doc-writer.md must have a tools: frontmatter line');
    assert.ok(
      toolsMatch[1].includes('Edit'),
      'tools: frontmatter must include Edit so fix mode can make surgical replacements (#571)'
    );
  });

  // ─── fix_mode instructions ────────────────────────────────────────────────

  describe('fix_mode block', () => {
    const fixStart = content.indexOf('<fix_mode>');
    const fixEnd = content.indexOf('</fix_mode>', fixStart);
    assert.ok(fixStart !== -1 && fixEnd !== -1, '<fix_mode> block must be present and complete');
    const fixBlock = content.slice(fixStart, fixEnd);

    test('fix_mode mandates Edit for corrections', () => {
      assert.ok(
        fixBlock.includes('Edit'),
        'fix_mode must instruct the agent to use the Edit tool for surgical corrections (#571)'
      );
    });

    test('fix_mode explicitly forbids Write on existing files', () => {
      assert.ok(
        fixBlock.includes('NEVER use the Write tool') || fixBlock.includes('NEVER call Write'),
        'fix_mode must explicitly forbid Write on existing files — Write replaces the whole file (#571)'
      );
    });

    test('fix_mode mentions unrecoverable data loss risk of Write', () => {
      assert.ok(
        fixBlock.includes('untracked') || fixBlock.includes('context window') || fixBlock.includes('permanently destroyed'),
        'fix_mode must explain WHY Write is forbidden — unrecoverable data loss for untracked files (#571)'
      );
    });
  });

  // ─── critical_rules ───────────────────────────────────────────────────────

  describe('critical_rules block', () => {
    const rulesStart = content.indexOf('<critical_rules>');
    const rulesEnd = content.indexOf('</critical_rules>', rulesStart);
    assert.ok(rulesStart !== -1 && rulesEnd !== -1, '<critical_rules> block must be present and complete');
    const rulesBlock = content.slice(rulesStart, rulesEnd);

    test('critical_rules forbids Write in fix mode', () => {
      assert.ok(
        rulesBlock.includes('fix mode') && (rulesBlock.includes('NEVER call Write') || rulesBlock.includes('NEVER use the Write')),
        'critical_rules must explicitly forbid Write in fix mode (#571)'
      );
    });

    test('critical_rules Edit rule appears before success_criteria', () => {
      const rulesIdx = content.indexOf('<critical_rules>');
      const successIdx = content.indexOf('<success_criteria>');
      assert.ok(rulesIdx !== -1 && successIdx !== -1, 'both <critical_rules> and <success_criteria> must exist');
      assert.ok(
        rulesIdx < successIdx,
        '<critical_rules> must appear before <success_criteria> (#571)'
      );
    });
  });
});

// ─── Workflow fix: post-fix truncation guard in fix_loop ─────────────────────

describe('bug #571: docs-update workflow fix_loop', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/docs-update.md must exist');
  });

  describe('fix_loop step', () => {
    const loopStart = content.indexOf('<step name="fix_loop">');
    const loopEnd = content.indexOf('</step>', loopStart);
    assert.ok(loopStart !== -1 && loopEnd !== -1, 'fix_loop step must be present and complete');
    const loopBlock = content.slice(loopStart, loopEnd);

    test('fix_loop captures pre-fix line count', () => {
      assert.ok(
        loopBlock.includes('PRE_FIX_LINES') || loopBlock.includes('pre-fix line'),
        'fix_loop must capture the pre-fix line count to detect truncation (#571)'
      );
    });

    test('fix_loop checks post-fix line count', () => {
      assert.ok(
        loopBlock.includes('POST_FIX_LINES') || loopBlock.includes('post-fix line'),
        'fix_loop must check the post-fix line count to detect truncation (#571)'
      );
    });

    test('fix_loop restores file on truncation detection', () => {
      assert.ok(
        loopBlock.includes('Restore') || loopBlock.includes('restore'),
        'fix_loop must restore the file from existing_content when truncation is detected (#571)'
      );
    });

    test('fix_loop truncation threshold is >90% shrinkage', () => {
      assert.ok(
        loopBlock.includes('90%') || loopBlock.includes('10%'),
        'fix_loop must use a >90% shrinkage threshold (10% of original) to detect truncation (#571)'
      );
    });

    test('fix_loop logs a WARNING on truncation', () => {
      assert.ok(
        loopBlock.includes('WARNING') || loopBlock.includes('corrupted'),
        'fix_loop must log a WARNING when truncation is detected and restored (#571)'
      );
    });

    // Structural ordering: PRE check → fix agent runs → POST check → restore
    // These ensure the guard is wired in the right sequence, not just present.
    test('PRE_FIX_LINES is captured before POST_FIX_LINES (correct ordering)', () => {
      const preIdx = loopBlock.indexOf('PRE_FIX_LINES');
      const postIdx = loopBlock.indexOf('POST_FIX_LINES');
      assert.ok(preIdx !== -1 && postIdx !== -1, 'both PRE_FIX_LINES and POST_FIX_LINES must be present (#571)');
      assert.ok(
        preIdx < postIdx,
        'PRE_FIX_LINES must appear before POST_FIX_LINES — pre-capture must happen before post-check (#571)'
      );
    });

    test('restore instruction appears after POST_FIX_LINES check (correct ordering)', () => {
      const postIdx = loopBlock.indexOf('POST_FIX_LINES');
      // Find the restore instruction — it follows the threshold comparison
      const restoreIdx = loopBlock.indexOf('existing_content', postIdx);
      assert.ok(
        restoreIdx !== -1 && restoreIdx > postIdx,
        'restore-from-existing_content instruction must appear after the POST_FIX_LINES check (#571)'
      );
    });

    test('fix_loop doc path is quoted in shell snippets', () => {
      // Unquoted paths break on filenames with spaces or shell metacharacters.
      // Verify the bash snippets use quoted "{doc_path}" not bare {doc_path}.
      assert.ok(
        loopBlock.includes('< "{doc_path}"') || loopBlock.includes("<\"{doc_path}\""),
        'shell redirections must quote {doc_path} to handle paths with spaces (#571)'
      );
    });

    test('corrupted doc is still re-verified (not silently skipped)', () => {
      // The restored doc must be included in step 2 re-verification so its
      // failures are counted and reported. It should only be excluded from
      // receiving another fix attempt, not from verification.
      const restoreIdx = loopBlock.indexOf('existing_content', loopBlock.indexOf('POST_FIX_LINES'));
      const reVerifyIdx = loopBlock.indexOf('re-verify', restoreIdx);
      assert.ok(
        reVerifyIdx !== -1,
        'fix_loop must include re-verification after truncation restore (corrupted docs still have failures) (#571)'
      );
    });
  });
});

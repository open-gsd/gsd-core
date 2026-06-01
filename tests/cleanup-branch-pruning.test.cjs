// allow-test-rule: source-text-is-the-product
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * Cleanup enhancement: branch pruning (#40)
 *
 * Seam: get-shit-done/workflows/cleanup.md
 *
 * Verifies that /gsd-cleanup prunes local branches whose upstream is gone,
 * integrated between archive_phases and commit steps.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CLEANUP_PATH = path.join(REPO_ROOT, 'get-shit-done', 'workflows', 'cleanup.md');

// ─── Helpers (mirrors worktree-cleanup.test.cjs) ─────────────────────────────

function extractNamedBlock(markdown, blockName) {
  // Try <step name="blockName"> ... </step> first (cleanup.md step blocks).
  const openStep = `<step name="${blockName}">`;
  let start = markdown.indexOf(openStep);
  if (start !== -1) {
    const closeTag = '</step>';
    const end = markdown.indexOf(closeTag, start + openStep.length);
    if (end !== -1) return markdown.slice(start + openStep.length, end);
  }
  // Fallback: bare tag <blockName> ... </blockName>.
  const openBare = `<${blockName}>`;
  start = markdown.indexOf(openBare);
  if (start === -1) return null;
  const closeBare = `</${blockName}>`;
  const end = markdown.indexOf(closeBare, start + openBare.length);
  if (end === -1) return null;
  return markdown.slice(start + openBare.length, end);
}

function extractFencedCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceLang = '';
  let buffer = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
        buffer = [];
      } else {
        blocks.push({ lang: fenceLang, body: buffer.join('\n') });
        inFence = false;
        fenceLang = '';
        buffer = [];
      }
    } else if (inFence) {
      buffer.push(line);
    }
  }
  return blocks;
}

function shellStatements(script) {
  const statements = [];
  const lines = script.split('\n');
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/(?:&&|\|\||;)/);
    for (const part of parts) {
      let trimmed = part.trim();
      if (!trimmed) continue;
      const assignMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
      if (assignMatch) trimmed = assignMatch[1];
      const subMatch = trimmed.match(/^\$\((.*?)\)?$/);
      if (subMatch) trimmed = subMatch[1];
      if (trimmed.startsWith('$(')) trimmed = trimmed.slice(2);
      trimmed = trimmed.replace(/\)+\s*$/, '').trim();
      if (!trimmed) continue;
      statements.push(trimmed.split(/\s+/).filter(Boolean));
    }
  }
  return statements;
}

function findCommandIndex(statements, predicate) {
  for (let i = 0; i < statements.length; i++) {
    if (predicate(statements[i])) return i;
  }
  return -1;
}

// ─── #40: prune local branches whose upstream is gone ──────────────────────

describe('cleanup #40: prune local branches whose upstream is gone', () => {
  const content = fs.readFileSync(CLEANUP_PATH, 'utf-8');

  test('cleanup.md contains a prune_local_branches step', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block, 'cleanup.md must contain a <prune_local_branches> step');
  });

  test('prune_local_branches runs `git fetch --prune`', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const idx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'fetch' && (cmd.includes('--prune') || cmd.includes('-p'))
    );
    assert.notStrictEqual(
      idx, -1,
      'prune_local_branches must run `git fetch --prune` to remove stale remote-tracking refs'
    );
  });

  test('prune_local_branches identifies branches with gone upstream via `git branch -vv`', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    // Must contain a `git branch -vv` invocation (or equivalent)
    const branchVvIdx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'branch' && (cmd.includes('-vv') || cmd.includes('--verbose'))
    );
    assert.notStrictEqual(
      branchVvIdx, -1,
      'prune_local_branches must run `git branch -vv` to find branches with gone upstream'
    );
  });

  test('prune_local_branches deletes branches marked `[gone]` using `git branch -D`', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const branchDIdx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'branch' && (cmd.includes('-D') || cmd.includes('--delete'))
    );
    assert.notStrictEqual(
      branchDIdx, -1,
      'prune_local_branches must run `git branch -D` to delete stale local branches'
    );
  });

  test('prune_local_branches handles empty result sets (xargs -r safety)', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    // The full pipeline must use `xargs -r` (or equivalent) to avoid running
    // git branch -D with no arguments when no stale branches exist.
    assert.ok(
      block.includes('xargs -r') || block.includes('xargs --no-run-if-empty'),
      'prune_local_branches must use `xargs -r` to handle empty branch lists safely'
    );
  });

  test('prune_local_branches appears between archive_phases and commit in <process>', () => {
    const processBlock = extractNamedBlock(content, 'process');
    assert.ok(processBlock);

    const archivePhasesIdx = processBlock.indexOf('<step name="archive_phases">');
    const pruneBranchesIdx = processBlock.indexOf('<step name="prune_local_branches">');
    const commitIdx = processBlock.indexOf('<step name="commit">');

    assert.ok(archivePhasesIdx > -1, 'archive_phases step must exist');
    assert.ok(commitIdx > -1, 'commit step must exist');
    assert.notStrictEqual(
      pruneBranchesIdx, -1,
      'prune_local_branches step must exist'
    );
    assert.ok(
      archivePhasesIdx < pruneBranchesIdx && pruneBranchesIdx < commitIdx,
      'prune_local_branches must appear between archive_phases and commit steps'
    );
  });

  test('dry-run output in show_dry_run mentions branch pruning', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // The dry-run summary must enumerate candidate local branches for deletion,
    // not just phase directories.
    assert.ok(
      block.includes('branch') || block.includes('Branch'),
      'show_dry_run must mention branch pruning in the dry-run summary'
    );
  });

  test('confirmation prompt covers both archiving and pruning', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // The AskUserQuestion prompt must cover the combined action (archive + prune).
    assert.ok(
      block.includes('archive') && (block.includes('prune') || block.includes('branch')),
      'confirmation prompt must cover both phase archival and branch pruning'
    );
  });

  test('report step includes pruned-branch count', () => {
    const block = extractNamedBlock(content, 'report');
    assert.ok(block);
    // The final report must include a line like "Pruned: N local branches whose upstream is gone".
    assert.ok(
      block.includes('Pruned') || block.includes('pruned'),
      'report step must include pruned branch count in the final summary'
    );
  });

  test('prune_local_branches does not delete the currently checked-out branch', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    // The step must skip the current HEAD branch to avoid self-deletion.
    assert.ok(
      block.includes('HEAD') || block.includes('current branch') || block.includes('current_branch'),
      'prune_local_branches must skip the currently checked-out branch'
    );
  });

  test('prune_local_branches step is gated by the same user confirmation as archive_phases', () => {
    // The prune step must not execute unconditionally — it should be gated behind
    // the same user confirmation that gates phase archival. Verify the step text
    // does not contain an unconditional shell execution without prior confirmation.
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);

    // Extract the shell commands from this step. If there are any, they must be
    // inside a conditional or confirmation block (e.g., "if confirmed" / "on yes").
    const codeBlocks = extractFencedCodeBlocks(block);
    if (codeBlocks.length > 0) {
      // There are shell commands — verify they are gated.
      const fullBlock = block;
      // Accept either: (a) the commands are inside an "if confirmed" / conditional,
      // or (b) there is a textual instruction saying they run "on confirmation".
      const hasConfirmationGating = (
        fullBlock.includes('confirm') ||
        fullBlock.includes('Confirm') ||
        fullBlock.includes('yes') ||
        fullBlock.includes('Yes') ||
        fullBlock.includes('ask user') ||
        fullBlock.includes('AskUserQuestion') ||
        /if \[.*\]/.test(fullBlock) ||
        /\bif\s+/.test(fullBlock)
      );
      assert.ok(
        hasConfirmationGating,
        'prune_local_branches shell commands must be gated behind user confirmation'
      );
    }
  });

  test('no breaking changes: existing archive_phases step is untouched', () => {
    // Verify the original archive_phases block still exists and functions as before.
    const block = extractNamedBlock(content, 'archive_phases');
    assert.ok(block, 'original archive_phases step must still exist');
    // Must contain `mv` and `.planning/phases/` references.
    assert.ok(block.includes('mv'), 'archive_phases must still move phase directories');
    assert.ok(
      block.includes('.planning/phases/') || block.includes('phases/'),
      'archive_phases must reference .planning/phases/'
    );
  });
});

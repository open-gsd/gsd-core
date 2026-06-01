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
  const openStep = `<step name="${blockName}">`;
  let start = markdown.indexOf(openStep);
  if (start !== -1) {
    const closeTag = '</step>';
    const end = markdown.indexOf(closeTag, start + openStep.length);
    if (end !== -1) return markdown.slice(start + openStep.length, end);
  }
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
    assert.notStrictEqual(pruneBranchesIdx, -1, 'prune_local_branches step must exist');
    assert.ok(
      archivePhasesIdx < pruneBranchesIdx && pruneBranchesIdx < commitIdx,
      'prune_local_branches must appear between archive_phases and commit steps'
    );
  });

  test('dry-run output in show_dry_run mentions stale branch detection', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // Must explicitly enumerate stale branches, not just mention the word "branch"
    assert.ok(
      block.includes(': gone') || block.includes('gone]') || block.includes('upstream is gone'),
      'show_dry_run must mention gone-upstream branches in the dry-run summary'
    );
  });

  test('confirmation prompt in show_dry_run covers both archiving and pruning', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // The AskUserQuestion prompt must cover the combined action.
    assert.ok(
      block.includes('archive') && (block.includes('prune') || block.includes('branch')),
      'confirmation prompt must cover both phase archival and branch pruning'
    );
  });

  test('report step includes pruned-branch count', () => {
    const block = extractNamedBlock(content, 'report');
    assert.ok(block);
    assert.ok(
      block.includes('Pruned') || block.includes('pruned'),
      'report step must include pruned branch count in the final summary'
    );
  });

  test('prune_local_branches awk pattern explicitly excludes the current branch (HEAD)', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    // In `git branch -vv` output, the current branch is prefixed with `* `.
    // awk '{print $1}' on the current branch yields `*`, NOT the branch name.
    // The pipeline must explicitly exclude lines starting with `*` so that
    // `git branch -D` is never passed `*` as a literal argument.
    //
    // Accept either explicit awk guards (!/^\*/ or $1 != "*") OR
    // git branch --format with a filter that skips HEAD.
    const hasExplicitHeadGuard = (
      block.includes('!/^\\*/') ||      // awk negation pattern
      block.includes("!/^\\*") ||        // awk negation without closing /
      block.includes('$1 != "*"') ||    // awk field comparison
      block.includes('$1!="*"') ||
      block.includes('HEAD') && block.includes('filter') || // filter approach
      block.includes('--format') ||     // git branch --format skips * entirely
      block.includes('sed') && block.includes('\\*') // sed stripping * prefix
    );
    assert.ok(
      hasExplicitHeadGuard,
      'prune_local_branches awk must explicitly exclude lines starting with `*` ' +
      '(the current branch marker) — using !/^\\*/ or equivalent — to prevent ' +
      'passing literal `*` to `git branch -D`'
    );
  });

  test('identify_completed_milestones does NOT run git branch -vv (belongs in show_dry_run)', () => {
    const block = extractNamedBlock(content, 'identify_completed_milestones');
    assert.ok(block);
    // Branch detection is a dry-run concern, not milestone identification.
    // Including it here runs the command twice and splits responsibilities.
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const branchVvIdx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'branch'
    );
    assert.strictEqual(
      branchVvIdx, -1,
      'identify_completed_milestones must not run git branch commands — ' +
      'branch detection belongs in show_dry_run where dry-run output is assembled'
    );
  });

  test('show_dry_run does NOT run git fetch --prune (dry-run must be non-side-effecting)', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // git fetch --prune is a state-modifying operation (removes stale tracking refs).
    // It must not appear in the dry-run step; only in prune_local_branches.
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const fetchPruneIdx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'fetch' && (cmd.includes('--prune') || cmd.includes('-p'))
    );
    assert.strictEqual(
      fetchPruneIdx, -1,
      'show_dry_run must not run `git fetch --prune` — the dry-run phase should be ' +
      'read-only; git fetch --prune modifies remote-tracking refs and belongs only in ' +
      'the prune_local_branches execution step'
    );
  });

  test('no breaking changes: existing archive_phases step is untouched', () => {
    const block = extractNamedBlock(content, 'archive_phases');
    assert.ok(block, 'original archive_phases step must still exist');
    assert.ok(block.includes('mv'), 'archive_phases must still move phase directories');
    assert.ok(
      block.includes('.planning/phases/') || block.includes('phases/'),
      'archive_phases must reference .planning/phases/'
    );
  });
});

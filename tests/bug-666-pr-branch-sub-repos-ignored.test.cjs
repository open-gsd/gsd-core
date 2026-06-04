// allow-test-rule: source-text-is-the-product
// pr-branch.md is a workflow file whose deployed text IS the runtime contract.
// Assertions on its content verify the user-facing behaviour the agent follows.

/**
 * Regression tests for gsd:pr-branch ignoring sub_repos.
 *
 * Bug: git commands in the sub-repo handling path were called without
 * `git -C <repo>`, so they operated on the shell's current working directory
 * (the root repo or wherever the agent happened to be) instead of the
 * intended sub-repo.
 *
 * Fix: the `handle_sub_repos` step reads sub_repos from config and uses
 * `git -C "$REPO"` for every git invocation — never `cd "$REPO"`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(
  __dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md'
);

describe('bug: gsd:pr-branch ignores sub_repos from config', () => {
  let content;

  test('setup: pr-branch workflow is readable', () => {
    content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.length > 0, 'pr-branch.md must not be empty');
  });

  test('workflow contains a handle_sub_repos step', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      content.includes('handle_sub_repos'),
      'pr-branch.md must define a handle_sub_repos step'
    );
  });

  test('handle_sub_repos reads sub_repos via gsd_run query config-get', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      /gsd_run\s+query\s+config-get\s+sub_repos/.test(content),
      'pr-branch.md must read sub_repos via gsd_run query config-get sub_repos'
    );
  });

  test('handle_sub_repos uses git -C flag — never plain cd into sub-repo', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');

    // Must use git -C pattern for sub-repo git operations
    assert.ok(
      /git -C "\$REPO"/.test(content),
      'pr-branch.md must use `git -C "$REPO"` for sub-repo git commands'
    );

    // Must NOT use bare `cd "$REPO"` as the mechanism to switch context
    // (standalone cd without being inside a subshell or function)
    const hasBareSubrepoCd = /^\s*cd\s+"\$REPO"/.test(content);
    assert.ok(
      !hasBareSubrepoCd,
      'pr-branch.md must not use bare `cd "$REPO"` — shell state does not persist'
    );
  });

  test('handle_sub_repos presents user with all/select/skip choices', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      /\ball\b/.test(content) && /\bselect\b/.test(content) && /\bskip\b/.test(content),
      'pr-branch.md handle_sub_repos must offer all/select/skip choices to the user'
    );
  });

  test('handle_sub_repos creates branch, commits, pushes, and opens PR per sub-repo', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');

    assert.ok(
      /git -C "\$REPO" checkout -b/.test(content),
      'pr-branch.md must create a branch in the sub-repo with git -C'
    );
    assert.ok(
      /git -C "\$REPO" add/.test(content),
      'pr-branch.md must stage files in the sub-repo with git -C'
    );
    assert.ok(
      /git -C "\$REPO" commit/.test(content),
      'pr-branch.md must commit in the sub-repo with git -C'
    );
    assert.ok(
      /git -C "\$REPO" push/.test(content),
      'pr-branch.md must push in the sub-repo with git -C'
    );
    assert.ok(
      /gh pr create/.test(content),
      'pr-branch.md must open a PR for each processed sub-repo'
    );
  });

  test('handle_sub_repos commit message uses Conventional Commits format', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    // Conventional Commits: type(scope): description
    assert.ok(
      /commit -m "fix\(/.test(content),
      'pr-branch.md sub-repo commit message must follow Conventional Commits (fix(scope): ...)'
    );
  });

  test('handle_sub_repos skips gracefully when sub_repos is not configured', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    // Must have an explicit guard for empty/null/[] case
    assert.ok(
      /null|empty|\[\]|skip.*entirely|skip this step/i.test(content),
      'pr-branch.md must skip handle_sub_repos when sub_repos is empty or null'
    );
  });

  test('handle_sub_repos step is positioned before analyze_commits', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    const subReposIdx = content.indexOf('handle_sub_repos');
    const analyzeIdx = content.indexOf('analyze_commits');
    assert.ok(subReposIdx !== -1, 'handle_sub_repos step must exist');
    assert.ok(analyzeIdx !== -1, 'analyze_commits step must exist');
    assert.ok(
      subReposIdx < analyzeIdx,
      'handle_sub_repos must appear before analyze_commits in the workflow'
    );
  });
});

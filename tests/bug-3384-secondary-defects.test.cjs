// allow-test-rule: source-text-is-the-product
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const WORKTREE_BRANCH_CHECK_FRAGMENT = path.join(repoRoot, 'gsd-core', 'references', 'worktree-branch-check.md');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('bug #3384: adjacent worktree data-loss guards', () => {
  test('worktree cleanup CLI preserves caller cwd instead of resolving project root', () => {
    const source = read('gsd-core/bin/gsd-tools.cjs');
    const skipSet = source.slice(
      source.indexOf('const SKIP_ROOT_RESOLUTION = new Set(['),
      source.indexOf('if (!SKIP_ROOT_RESOLUTION.has(command))'),
    );

    assert.match(skipSet, /'worktree'/);
  });

  test('diagnose-issues references canonical fragment; fragment is verify-only and fails closed (#48)', () => {
    // diagnose-issues.md now references the canonical fragment rather than
    // inlining the block. Verify (a) it references the fragment and (b) the
    // fragment itself has the correct ordering: symbolic-ref/HEAD assertion and
    // ^worktree-agent- allow-list appear before any work, and (c) the fragment
    // is verify-only — no destructive self-recovery.
    const diagnoseSource = read('gsd-core/workflows/diagnose-issues.md');
    assert.ok(
      diagnoseSource.includes('worktree-branch-check.md'),
      'diagnose-issues.md must reference the canonical worktree-branch-check.md fragment'
    );

    const fragmentSource = fs.readFileSync(WORKTREE_BRANCH_CHECK_FRAGMENT, 'utf8');
    const branchCheck = fragmentSource.indexOf('HEAD_REF=$(git symbolic-ref --quiet HEAD || echo');
    const namespaceCheck = fragmentSource.indexOf('^worktree-agent-');

    assert.ok(branchCheck > 0, 'canonical fragment must assert HEAD before any work');
    assert.ok(namespaceCheck > branchCheck, 'canonical fragment must require disposable worktree-agent branch');
    // #48: verify-only — the destructive self-recovery is gone; the fragment fails closed instead.
    assert.ok(!fragmentSource.includes('git reset --hard {EXPECTED_BASE}'), 'canonical fragment must not self-recover via reset --hard — orchestrator owns recovery (#48)');
    assert.ok(fragmentSource.includes('exit 42'), 'canonical fragment must fail closed with exit 42 on base mismatch (#48)');
  });

  test('remove-workspace fails closed when git worktree remove fails', () => {
    const source = read('gsd-core/workflows/remove-workspace.md');
    const init = source.indexOf('REMOVE_FAILED=false');
    const loop = source.indexOf('For each repo in the workspace');
    const remove = source.indexOf('git worktree remove "$WORKSPACE_PATH/$REPO_NAME"');

    assert.doesNotMatch(
      source,
      /git worktree remove "\$WORKSPACE_PATH\/\$REPO_NAME" 2>&1 \|\| true/,
      'worktree removal failures must not be swallowed',
    );
    assert.ok(init > 0 && init < loop, 'REMOVE_FAILED must initialize once before the per-repo loop');
    assert.ok(remove > loop, 'worktree removal should remain inside the per-repo loop');
    assert.match(source, /Refusing to delete "\$WORKSPACE_PATH"/);
  });

  test('validate health warns when worktree inventory cannot be listed', () => {
    const source = read('gsd-core/bin/lib/verify.cjs');
    // Accept both hand-written dot access and the tsc-compiled bracket form
    // (ADR-457: verify.cjs is now emitted from src/verify.cts):
    //   hand-written: worktreeHealth.reason === 'git_list_failed'
    //   tsc-compiled:  worktreeHealth['reason'] === 'git_list_failed'
    const failureBranch = source.search(/worktreeHealth(?:\.reason|\['reason'\]) === 'git_list_failed'/);
    const warning = source.indexOf("addIssue('warning', 'W020'", failureBranch);

    assert.ok(failureBranch > 0, 'verify health should branch on git_list_failed');
    assert.ok(warning > failureBranch, 'git_list_failed should emit W020 degraded-health warning');
  });
});

'use strict';

// The back-merge carve-out of the Require Issue Link policy is behaviour of scripts/require-issue-link-policy.cjs
// (#3211 moved the verdict, including the #1389 carve-out, out of the workflow `if:` into that module), so it is
// asserted against the real module. The workflow text around it (the step-level `if:`, the delegation to the module,
// the legacy closing-keyword grep) and the rest of the PR policy workflows are the `workflow-maintainer-skip` text
// contract (scripts/static-checks/text-contracts/workflow-maintainer-skip.cjs).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateIssueLink, ISSUE_LINK_REASON } = require('../scripts/require-issue-link-policy.cjs');

describe('Require Issue Link back-merge automation carve-out', () => {
  test('the backmerge carve-out survives the move into the policy module', () => {
    const backmergeArgs = {
      prBody: 'Automated backmerge.',
      headRef: 'chore/backmerge-main-to-next-20260101',
      baseRef: 'next',
      changedFiles: ['src/a.cts'],
      changedFilesTotal: 1,
    };
    assert.equal(
      evaluateIssueLink({ ...backmergeArgs, sameRepo: true }).reason,
      ISSUE_LINK_REASON.OK_BACKMERGE_EXEMPT
    );
    // #1389 anti-forgery: a fork must not be able to forge the exemption by branch name alone, so dropping the
    // `sameRepo` conjunct would let a fork PR name its branch `chore/backmerge-main-to-next-*` and bypass the
    // issue-link requirement entirely.
    assert.equal(
      evaluateIssueLink({ ...backmergeArgs, sameRepo: false }).reason,
      ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE
    );
  });
});

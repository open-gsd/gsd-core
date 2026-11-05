'use strict';

/**
 * The release pipeline's own back-merge PRs (#5890).
 *
 * The pipeline opens three kinds of PR, and none of them has an issue to link:
 *
 *   kind                    head branch                         base   opened by
 *   release-merge           release/X.Y.0 | hotfix/X.Y.Z (Z>0)  main   release.yml "merge release back to main"
 *   next-version-sync       chore/sync-next-version-<version>   next   scripts/sync-next-version.cjs
 *   main-to-next-backmerge  chore/backmerge-main-to-next-<sha>  next   auto-backmerge.yml (#1389)
 *
 * Callers, each with its trust model:
 *
 *   - scripts/require-issue-link-policy.cjs (`Issue link required`) and
 *     .github/workflows/pr-title-validator.yml (`validate-title`) run on
 *     pull_request_target and load this module from a BASE-branch checkout,
 *     so a PR cannot edit the predicate that judges it.
 *   - scripts/changeset/lint.cjs (changeset-lint, #5903) runs on pull_request
 *     and executes PR-tree code, so the base-checkout guarantee does not apply
 *     (a PR could already edit lint.cjs itself). The fork guard is what blocks
 *     forgery: sameRepo is derived from the GitHub event payload.
 *
 * What each caller exempts:
 *
 *   - `Issue link required`: the closing-reference requirement.
 *   - `validate-title`: only the missing-issue-ref verdict; the title's type
 *     prefix (`bad-prefix`) is still enforced on these PRs.
 *   - changeset-lint: the fragment requirement; a malformed fragment or `pr:`
 *     drift still fails.
 *
 * Anti-forgery (#1389): a branch name alone is attacker-chosen — a fork can
 * name its branch anything. The exemption therefore also requires
 * `sameRepo === true` (head.repo.full_name == the base repository), which only
 * someone with push access to this repository can satisfy, and the exact base
 * branch each kind targets.
 */

const { isReleaseVersion, SYNC_BRANCH_PREFIX } = require('./sync-next-version.cjs');

const RELEASE_PIPELINE_PR_KIND = Object.freeze({
  RELEASE_MERGE: 'release-merge',
  NEXT_VERSION_SYNC: 'next-version-sync',
  MAIN_TO_NEXT_BACKMERGE: 'main-to-next-backmerge',
});

// release.yml validate-version: X.Y.0 cuts release/X.Y.0; X.Y.Z with Z>0 cuts
// hotfix/X.Y.Z. Same no-leading-zero grammar as its `grep -qE` checks.
const RELEASE_BRANCH_RE = /^release\/(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.0$/;
const HOTFIX_BRANCH_RE = /^hotfix\/(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.[1-9][0-9]*$/;

// auto-backmerge.yml: BR="chore/backmerge-main-to-next-${SHORT_SHA}" (#1389),
// SHORT_SHA=$(git rev-parse --short origin/main): 7 to 40 lowercase hex.
const BACKMERGE_BRANCH_PREFIX = 'chore/backmerge-main-to-next-';
const BACKMERGE_SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Classify a PR as one of the release pipeline's own PRs.
 *
 * @param {{ headRef?: unknown, baseRef?: unknown, sameRepo?: unknown }} [pr]
 * @returns {string|null} a RELEASE_PIPELINE_PR_KIND value, or null when the PR
 *   is not a release-pipeline PR (including every fork PR).
 */
function releasePipelinePrKind({ headRef, baseRef, sameRepo } = {}) {
  if (sameRepo !== true) return null;
  if (typeof headRef !== 'string' || typeof baseRef !== 'string') return null;

  if (baseRef === 'main' && (RELEASE_BRANCH_RE.test(headRef) || HOTFIX_BRANCH_RE.test(headRef))) {
    return RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE;
  }
  if (baseRef === 'next' && headRef.startsWith(SYNC_BRANCH_PREFIX)
    && isReleaseVersion(headRef.slice(SYNC_BRANCH_PREFIX.length))) {
    return RELEASE_PIPELINE_PR_KIND.NEXT_VERSION_SYNC;
  }
  if (baseRef === 'next' && headRef.startsWith(BACKMERGE_BRANCH_PREFIX)
    && BACKMERGE_SHA_RE.test(headRef.slice(BACKMERGE_BRANCH_PREFIX.length))) {
    return RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE;
  }
  return null;
}

/** True iff the PR is one of the release pipeline's own PRs (see releasePipelinePrKind). */
function isReleasePipelinePr(pr) {
  return releasePipelinePrKind(pr) !== null;
}

module.exports = {
  RELEASE_PIPELINE_PR_KIND,
  BACKMERGE_BRANCH_PREFIX,
  releasePipelinePrKind,
  isReleasePipelinePr,
};

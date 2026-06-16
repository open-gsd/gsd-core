'use strict';

/**
 * PR target-branch policy — ADR-230.
 *
 * Extracted from .github/workflows/pr-target-validator.yml so the classification
 * logic can be unit-tested independently and required by the workflow at checkout
 * from the TRUSTED base-branch copy (fork-tamper-safe).
 *
 * Pure module: no I/O, no GitHub API calls, no side effects.
 *
 * See: docs/branching.md, docs/adr/230-introduce-next-integration-branch.md
 */

/**
 * The five patterns that allow a PR to target `main`.
 * Verbatim from the github-script in pr-target-validator.yml.
 *
 * @type {RegExp[]}
 */
const MAIN_ALLOWED_PATTERNS = [
  /^release\/\d+\.\d+\.0$/,           // release branches
  /^hotfix\/\d+\.\d+\.\d+$/,          // hotfix branches
  /^fix\/critical-/,                  // production-down emergencies
  /^chore\/backmerge-/,               // auto-backmerge from this workflow
  /^revert\/critical-/,               // emergency reverts
];

/**
 * Classify a pull request by its base and head branch names.
 *
 * @param {string} base  - The PR's target branch (e.g. 'next', 'main', 'release/1.2.0').
 * @param {string} head  - The PR's source branch (e.g. 'feat/my-feature').
 * @returns {{ decision: 'allowed' | 'blocked' | 'unusual' }}
 */
function classifyPrTarget(base, head) {
  // PRs targeting `next` are always fine.
  if (base === 'next') {
    return { decision: 'allowed' };
  }

  // PRs targeting `main`: only specific branch types allowed.
  if (base === 'main') {
    const allowed = MAIN_ALLOWED_PATTERNS.some(re => re.test(head));
    if (allowed) {
      return { decision: 'allowed' };
    }
    return { decision: 'blocked' };
  }

  // PRs targeting release/X.Y.0 or hotfix/X.Y.Z are fine (stabilization PRs).
  if (/^release\/\d+\.\d+\.0$/.test(base) || /^hotfix\/\d+\.\d+\.\d+$/.test(base)) {
    return { decision: 'allowed' };
  }

  // Any other target is unusual but not forbidden.
  return { decision: 'unusual' };
}

module.exports = {
  MAIN_ALLOWED_PATTERNS,
  classifyPrTarget,
};

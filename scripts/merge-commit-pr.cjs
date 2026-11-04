'use strict';

/**
 * Land one of the release pipeline's history-carrying PRs as a merge commit (#5894).
 *
 * Two PRs must keep a parent edge, or main and next stop sharing history and
 * the next release -> main merge conflicts in every version field:
 *
 *   release-merge           release/X.Y.0 | hotfix/X.Y.Z -> main        keeps the v<version> tag in main
 *   main-to-next-backmerge  chore/backmerge-main-to-next-<sha> -> next  keeps main an ancestor of next
 *
 * v1.19.0 broke both (#5729 and #5730 were squash-merged). This script is the
 * one sanctioned way to merge them, from auto-backmerge.yml, release.yml and a
 * maintainer's shell alike:
 *
 *   1. it merges through `PUT /repos/{repo}/pulls/{n}/merge` with
 *      merge_method=merge: never the merge queue, which squashes, and not
 *      `gh pr merge --admin`, which does not honor a ruleset bypass;
 *   2. the merge is pinned to the head sha it read (`sha=`), so a push after
 *      the read is refused rather than merged unseen;
 *   3. afterwards it proves the result: the merge commit has two parents, one
 *      of them the PR head, and the base branch now contains the PR head.
 *
 * Usage: node scripts/merge-commit-pr.cjs <pr-number> [--repo owner/name]
 * Prints one JSON result line; exits 0 when merged and verified, else 1.
 */

const { execFileSync } = require('node:child_process');
const { RELEASE_PIPELINE_PR_KIND, releasePipelinePrKind } = require('./release-pipeline-pr.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

const MERGE_COMMIT_PR_REASON = Object.freeze({
  MERGED: 'merged',
  USAGE: 'usage',
  PR_UNREADABLE: 'pr-unreadable',
  NOT_OPEN: 'not-open',
  NOT_A_HISTORY_PR: 'not-a-history-pr',
  MERGE_REFUSED: 'merge-refused',
  NOT_A_MERGE_COMMIT: 'not-a-merge-commit',
  ANCESTRY_BROKEN: 'ancestry-broken',
  TAG_NOT_IN_BASE: 'tag-not-in-base',
  VERIFY_UNREADABLE: 'verify-unreadable',
});

const HISTORY_KINDS = Object.freeze([
  RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE,
  RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE,
]);

const PR_NUMBER_RE = /^[1-9][0-9]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_TIMEOUT_MS = 30000;
const GH_MERGE_TIMEOUT_MS = 60000;

/** The release tag a release/hotfix head branch publishes: release/1.20.0 -> v1.20.0. */
function releaseTagFor(headRef) {
  const match = /^(?:release|hotfix)\/((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(String(headRef || ''));
  return match ? `v${match[1]}` : null;
}

/** Parse argv. Returns { prNumber, repo } or { error }. */
function parseArgs(argv, env = process.env) {
  let prNumber = null;
  let repo = env.GITHUB_REPOSITORY || 'open-gsd/gsd-core';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !REPO_RE.test(value)) return { error: '--repo needs owner/name' };
      repo = value;
      i += 1;
    } else if (prNumber === null && PR_NUMBER_RE.test(arg)) {
      prNumber = Number(arg);
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  if (prNumber === null) return { error: 'usage: merge-commit-pr.cjs <pr-number> [--repo owner/name]' };
  if (!REPO_RE.test(repo)) return { error: `invalid repository: ${repo}` };
  return { prNumber, repo };
}

/** Default gh runner: returns stdout; throws on non-zero exit (err.stderr carries gh's text). */
function defaultGh(args, { timeout = GH_TIMEOUT_MS } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

function errorText(err) {
  return String((err && (err.stderr || err.message)) || err).trim();
}

/**
 * Merge PR `prNumber` of `repo` with a merge commit and verify the history.
 * `gh(args, opts)` returns gh's stdout (JSON for `gh api`) and throws on failure.
 *
 * @returns {{ ok: boolean, reason: string, kind?: string, mergeSha?: string, detail?: string }}
 */
function mergeWithMergeCommit({ prNumber, repo, gh = defaultGh }) {
  let pr;
  try {
    pr = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}`]));
  } catch (err) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.PR_UNREADABLE, detail: errorText(err) };
  }
  if (!pr || pr.state !== 'open' || pr.merged === true) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.NOT_OPEN };
  }
  const head = pr.head || {};
  const base = pr.base || {};
  const headRepo = head.repo && typeof head.repo.full_name === 'string' ? head.repo.full_name : null;
  const kind = releasePipelinePrKind({
    headRef: head.ref,
    baseRef: base.ref,
    sameRepo: headRepo !== null && headRepo.toLowerCase() === repo.toLowerCase(),
  });
  if (!HISTORY_KINDS.includes(kind)) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.NOT_A_HISTORY_PR, kind: kind || undefined };
  }
  const headSha = head.sha;

  let merge;
  try {
    merge = JSON.parse(gh(
      ['api', '-X', 'PUT', `repos/${repo}/pulls/${prNumber}/merge`, '-f', 'merge_method=merge', '-f', `sha=${headSha}`],
      { timeout: GH_MERGE_TIMEOUT_MS },
    ));
  } catch (err) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.MERGE_REFUSED, kind, detail: errorText(err) };
  }
  if (!merge || merge.merged !== true || typeof merge.sha !== 'string') {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.MERGE_REFUSED, kind, detail: JSON.stringify(merge) };
  }
  const mergeSha = merge.sha;

  let commit;
  let compare;
  try {
    commit = JSON.parse(gh(['api', `repos/${repo}/commits/${mergeSha}`]));
    compare = JSON.parse(gh(['api', `repos/${repo}/compare/${headSha}...${base.ref}`]));
  } catch (err) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.VERIFY_UNREADABLE, kind, mergeSha, detail: errorText(err) };
  }
  const parents = commit && Array.isArray(commit.parents) ? commit.parents.map((p) => p && p.sha) : [];
  if (parents.length !== 2 || !parents.includes(headSha)) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.NOT_A_MERGE_COMMIT, kind, mergeSha, detail: `parents=${parents.join(',')}` };
  }
  if (!compare || compare.behind_by !== 0) {
    return { ok: false, reason: MERGE_COMMIT_PR_REASON.ANCESTRY_BROKEN, kind, mergeSha, detail: `behind_by=${compare && compare.behind_by}` };
  }
  if (kind === RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE) {
    const tag = releaseTagFor(head.ref);
    if (tag === null) {
      return { ok: false, reason: MERGE_COMMIT_PR_REASON.VERIFY_UNREADABLE, kind, mergeSha, detail: 'no release tag for ' + head.ref };
    }
    let tagCompare;
    try {
      tagCompare = JSON.parse(gh(['api', `repos/${repo}/compare/${tag}...${base.ref}`]));
    } catch (err) {
      return { ok: false, reason: MERGE_COMMIT_PR_REASON.VERIFY_UNREADABLE, kind, mergeSha, detail: errorText(err) };
    }
    if (!tagCompare || tagCompare.behind_by !== 0) {
      return { ok: false, reason: MERGE_COMMIT_PR_REASON.TAG_NOT_IN_BASE, kind, mergeSha, detail: `${tag} behind_by=${tagCompare && tagCompare.behind_by}` };
    }
  }
  return { ok: true, reason: MERGE_COMMIT_PR_REASON.MERGED, kind, mergeSha };
}

function main(argv = process.argv.slice(2), { gh = defaultGh, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv, env);
  if (args.error) {
    stderr.write(`::error::${args.error}\n`);
    stdout.write(`${JSON.stringify({ ok: false, reason: MERGE_COMMIT_PR_REASON.USAGE })}\n`);
    return 1;
  }
  const result = mergeWithMergeCommit({ prNumber: args.prNumber, repo: args.repo, gh });
  stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    stderr.write(`::error::PR #${args.prNumber} was not landed as a verified merge commit (${result.reason})${result.detail ? `: ${result.detail}` : ''}. `
      + 'Never put a release or back-merge PR in the merge queue or squash it: main and next must keep sharing history (#5894).\n');
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = { MERGE_COMMIT_PR_REASON, HISTORY_KINDS, GH_TIMEOUT_MS, GH_MERGE_TIMEOUT_MS, releaseTagFor, parseArgs, mergeWithMergeCommit, main };

'use strict';
// ci-rebase-check.cjs — Merge the PR base branch into the current PR head.
// Replaces the inline bash "Rebase check — merge PR base branch into PR head" step.
// Shell-agnostic: invoked as `node scripts/ci-rebase-check.cjs` from any shell.
//
// Required environment variables (set by the workflow step's `env:` block):
//   GITHUB_TOKEN    — access token for remote set-url
//   GITHUB_BASE_REF — PR base branch name (set by GitHub Actions on pull_request events)
//   GITHUB_REPOSITORY — owner/repo (set by GitHub Actions)
//
// Optional:
//   CI_REBASE_BASE_SHA — pin the merge to one exact base commit (#2472).
//
// Why the pin matters. Every job of a run executes this step independently, at
// whatever wall-clock moment it gets there — and Windows/macOS installs skew
// that by minutes across a 12-job matrix. Merging the moving `origin/<branch>`
// ref means that if the base advances mid-run, different jobs merge different
// trees. That was survivable when jobs only had to agree on pass/fail, but the
// sharded lane makes them agree on a PARTITION: each shard job computes the
// whole split and keeps its own slice, so jobs working from different trees can
// place a file in two shards or in none. Each job still looks internally
// consistent, so nothing errors — a test silently never runs and CI stays
// green. Pinning every job to `github.event.pull_request.base.sha`, which is
// fixed for the life of the run, removes the divergence at its source rather
// than detecting it after the fact.
//
// Exit 0 = merged cleanly (or merge was a no-op).
// Exit 1 = merge conflict or fetch failure.

const { execFileSync } = require('child_process');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

function run(cmd, args, opts) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', ...opts });
    return true; // success sentinel; execFileSync returns null with stdio:'inherit'
  } catch (e) {
    return false;
  }
}

function runOrThrow(cmd, args, label) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit' });
  } catch (e) {
    throw new ExitError(1, `::error::${label} failed`);
  }
}

const token = process.env.GITHUB_TOKEN || '';
const baseBranch = process.env.GITHUB_BASE_REF || 'main';
const repo = process.env.GITHUB_REPOSITORY || '';
// Resolve what to fetch and what to merge, pinned together so they can never
// disagree. Pure and exported so the pin contract is testable without spawning
// git: env in, refs out.
//
// Only a full 40-hex sha is accepted. Anything else — empty on push/dispatch
// events, or a malformed/injected value — falls back to the branch ref,
// preserving the pre-#2472 behavior rather than handing an arbitrary string to
// `git fetch` as a refspec.
function resolveBaseRefs(env = process.env, fallbackBranch = 'main') {
  const branch = env.GITHUB_BASE_REF || fallbackBranch;
  const raw = env.CI_REBASE_BASE_SHA || '';
  const sha = /^[0-9a-f]{40}$/.test(raw) ? raw : null;
  return {
    branch,
    sha,
    pinned: sha !== null,
    fetchRef: sha || branch,
    mergeRef: sha || `origin/${branch}`,
  };
}

const { fetchRef, mergeRef } = resolveBaseRefs(process.env, 'main');

function main() {
  // Configure git identity (needed for merge commit).
  runOrThrow('git', ['config', 'user.email', 'ci@gsd-redux'], 'git config user.email');
  runOrThrow('git', ['config', 'user.name', 'CI Rebase Check'], 'git config user.name');

  // Set authenticated remote URL.
  if (token && repo) {
    runOrThrow(
      'git',
      ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repo}.git`],
      'git remote set-url'
    );
  }

  // Fetch base branch with retry.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run('git', ['fetch', 'origin', fetchRef]);
    if (result) {
      break;
    }
    if (attempt === 3) {
      throw new ExitError(1, `::error::git fetch origin ${fetchRef} failed after 3 attempts.`);
    }
    // Wait before retry: attempt * 4 seconds.
    const waitMs = attempt * 4000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) { /* busy wait, acceptable in CI */ }
  }

  // Attempt merge.
  try {
    execFileSync('git', ['merge', '--no-edit', '--no-ff', mergeRef], { stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(
      `::error::This PR cannot cleanly merge origin/${baseBranch}. Rebase your branch onto current ${baseBranch} and push again.\n`
    );
    process.stderr.write('::error::Conflicting files:\n');
    try {
      execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { stdio: 'inherit' });
    } catch (_) { /* ignore */ }
    try {
      execFileSync('git', ['merge', '--abort'], { stdio: 'inherit' });
    } catch (_) { /* ignore */ }
    throw new ExitError(1);
  }
}

// Only run when invoked as the CI step. Guarded so a test can require this
// module for resolveBaseRefs without firing git fetch/merge as a side effect.
if (require.main === module) {
  runMain(main);
}

module.exports = { resolveBaseRefs };

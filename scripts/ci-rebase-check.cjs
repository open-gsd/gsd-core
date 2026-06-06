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
// Exit 0 = merged cleanly (or merge was a no-op).
// Exit 1 = merge conflict or fetch failure.

const { execFileSync } = require('child_process');

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
    process.stderr.write(`::error::${label} failed\n`);
    process.exit(1);
  }
}

const token = process.env.GITHUB_TOKEN || '';
const baseBranch = process.env.GITHUB_BASE_REF || 'main';
const repo = process.env.GITHUB_REPOSITORY || '';

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
  const result = run('git', ['fetch', 'origin', baseBranch]);
  if (result) {
    break;
  }
  if (attempt === 3) {
    process.stderr.write(`::error::git fetch origin ${baseBranch} failed after 3 attempts.\n`);
    process.exit(1);
  }
  // Wait before retry: attempt * 4 seconds.
  const waitMs = attempt * 4000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) { /* busy wait, acceptable in CI */ }
}

// Attempt merge.
try {
  execFileSync('git', ['merge', '--no-edit', '--no-ff', `origin/${baseBranch}`], { stdio: 'inherit' });
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
  process.exit(1);
}

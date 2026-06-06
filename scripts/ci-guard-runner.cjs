'use strict';
// ci-guard-runner.cjs — Assert the current runner is github-hosted.
// Replaces the inline bash "Guard — require GitHub-hosted runner" step.
// Shell-agnostic: invoked as `node scripts/ci-guard-runner.cjs` from any shell.
//
// Exit 0 = github-hosted runner confirmed.
// Exit 1 = not a github-hosted runner (emits GitHub Actions error annotation).

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const env = process.env.RUNNER_ENVIRONMENT || '';

function main() {
  if (env !== 'github-hosted') {
    throw new ExitError(
      1,
      `::error::Expected github-hosted runner. RUNNER_ENVIRONMENT=${env || 'unset'}`
    );
  }
}

runMain(main);

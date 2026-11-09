#!/usr/bin/env node
'use strict';

// ci-fix-next-rerun.cjs — #6076: re-run ONLY the `Base branch health` job of a
// PR's latest Tests run after the `fix-next` label was added or removed.
//
// Runs from .github/workflows/fix-next-rerun.yml (pull_request_target) against
// the BASE sha's copy of this file, never the PR's. The core is dependency
// injected (`gh`, `now`, `sleep`) so every branch is tested without a network.

const { execFile } = require('node:child_process');
const { runMain } = require('./lib/cli-exit.cjs');

const BASE_HEALTH_JOB_NAME = 'Base branch health';
const TESTS_WORKFLOW_FILE = 'test.yml';
const GH_TIMEOUT_MS = 30000;
const DEFAULT_DEADLINE_MS = 85 * 60 * 1000;
const DEFAULT_POLL_MS = 30 * 1000;
const PR_NUMBER_PATTERN = /^[1-9]\d*$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * @param {object} opts
 * @param {(args:string[]) => Promise<string>} opts.gh  stdout of `gh <args>`; throws on failure
 * @param {string} opts.repo      owner/repo
 * @param {string} opts.headSha   head sha from the label event payload
 * @param {string} opts.prNumber  PR number
 * @param {() => number} opts.now ms clock (read once at start, once per incomplete poll)
 * @param {(ms:number) => Promise<void>} opts.sleep
 * @param {number} opts.deadlineMs  how long to wait for the run to complete
 * @param {number} opts.pollMs
 * @returns {Promise<{action:'rerun'|'skip'|'error', reason:string, runId?:string, jobId?:string}>}
 */
async function rerunBaseHealth({
  gh, repo, headSha, prNumber, now, sleep, deadlineMs = DEFAULT_DEADLINE_MS, pollMs = DEFAULT_POLL_MS,
}) {
  try {
    const deadline = now() + deadlineMs;
    let run;
    for (;;) {
      const listed = JSON.parse(await gh([
        'run', 'list', '--workflow', TESTS_WORKFLOW_FILE, '--commit', headSha,
        '--event', 'pull_request', '--limit', '1', '--json', 'databaseId,status,conclusion',
      ]));
      if (!Array.isArray(listed) || listed.length === 0) return { action: 'skip', reason: 'no-run' };
      [run] = listed;
      if (run.status === 'completed') break;
      if (now() >= deadline) return { action: 'error', reason: 'timeout', runId: String(run.databaseId) };
      await sleep(pollMs);
    }
    const runId = String(run.databaseId);

    // A cancelled run was superseded by a newer one, which reads the label from
    // the API; re-running a job here would rejoin the Tests concurrency group
    // and could cancel that newer run.
    if (run.conclusion === 'cancelled') return { action: 'skip', reason: 'run-cancelled', runId };

    // A run waiting for approval has not executed; there is nothing to re-run.
    if (run.conclusion === 'action_required') return { action: 'skip', reason: 'run-awaiting-approval', runId };

    const readHead = async () => (await gh(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'])).trim();
    if ((await readHead()) !== headSha) return { action: 'skip', reason: 'head-moved', runId };

    const view = JSON.parse(await gh(['run', 'view', runId, '--json', 'jobs']));
    const jobs = view && Array.isArray(view.jobs) ? view.jobs : [];
    const job = jobs.find((j) => j && j.name === BASE_HEALTH_JOB_NAME);
    if (!job) return { action: 'error', reason: 'no-job', runId };
    const jobId = String(job.databaseId);

    // Second read immediately before the re-run, to shrink the stale-run window.
    if ((await readHead()) !== headSha) return { action: 'skip', reason: 'head-moved', runId };

    await gh(['run', 'rerun', runId, '--job', jobId]);
    return { action: 'rerun', reason: 'rerun', runId, jobId };
  } catch (err) {
    return { action: 'error', reason: `gh-failed: ${err && err.message ? err.message : String(err)}` };
  }
}

function realGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * @param {object} [deps]  test seams: env, gh, now, sleep, stdout, stderr, deadlineMs, pollMs
 * @returns {Promise<number>} exit code
 */
async function main(deps = {}) {
  const env = deps.env || process.env;
  const out = deps.stdout || ((s) => process.stdout.write(s));
  const errOut = deps.stderr || ((s) => process.stderr.write(s));

  const prNumber = (env.PR_NUMBER || '').trim();
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    errOut(`::error::PR_NUMBER must be a positive integer, got ${JSON.stringify(prNumber)}\n`);
    return 1;
  }
  const headSha = (env.HEAD_SHA || '').trim();
  if (!HEAD_SHA_PATTERN.test(headSha)) {
    errOut('::error::HEAD_SHA must be a 40-character hex sha\n');
    return 1;
  }
  const repo = (env.GH_REPO || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    errOut('::error::GH_REPO must be owner/repo\n');
    return 1;
  }

  const result = await rerunBaseHealth({
    gh: deps.gh || realGh,
    repo,
    headSha,
    prNumber,
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    deadlineMs: deps.deadlineMs,
    pollMs: deps.pollMs,
  });

  if (result.action === 'error') {
    errOut(`::error::fix-next re-run failed (${result.reason})${result.runId ? ` on Tests run ${result.runId}` : ''}; re-run "${BASE_HEALTH_JOB_NAME}" by hand.\n`);
    return 1;
  }
  if (result.action === 'skip') {
    out(`::notice::fix-next re-run skipped (${result.reason}); the newer or upcoming run reads the label from the API.\n`);
    return 0;
  }
  out(`Re-ran "${BASE_HEALTH_JOB_NAME}" (job ${result.jobId}) on Tests run ${result.runId}.\n`);
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  BASE_HEALTH_JOB_NAME,
  TESTS_WORKFLOW_FILE,
  DEFAULT_DEADLINE_MS,
  DEFAULT_POLL_MS,
  GH_TIMEOUT_MS,
  rerunBaseHealth,
  main,
};

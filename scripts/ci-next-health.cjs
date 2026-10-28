#!/usr/bin/env node
'use strict';

// ci-next-health.cjs — #4422 base-branch health gate.
//
// Risk asymmetry drives this design, same shape as scripts/ci-pr-mergeability.cjs
// but pointed the other direction: on 2026-09-06 three unrelated PRs merged on
// top of an already-broken `next` before anyone noticed, because nothing checked
// the base branch's OWN health before letting a PR land on it. A false positive
// here (a healthy `next` wrongly reported RED) blocks every PR merge in the repo
// until a human notices and applies the `fix-next` bypass label — annoying, but
// loud and immediately actionable. A false negative (a broken `next` reported
// healthy) reproduces the #4422 incident exactly. So, unlike the mergeability
// preflight, this gate does NOT fail open on a definite red signal — it fails
// open only when the signal itself is unavailable or inapplicable (wrong event,
// no resolvable base ref, an API read that throws). Once GitHub actually answers
// with a non-success conclusion for the base branch's last push-triggered Tests
// run, that is treated as authoritative and blocks — with one explicit, visible,
// human-operated escape hatch (the `fix-next` label) for the PR that is itself
// the fix-forward.
//
// Every non-success conclusion (`failure`, `cancelled`, `timed_out`,
// `action_required`, ...) is treated as RED, not just `failure` — a cancelled or
// timed-out run on the base branch is not evidence the branch is healthy, it is
// evidence nobody knows yet.

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const VERDICT = Object.freeze({
  CLEAN: 'CLEAN',
  RED: 'RED',
  BYPASSED: 'BYPASSED',
  SKIPPED_NOT_APPLICABLE: 'SKIPPED_NOT_APPLICABLE',
  INDETERMINATE: 'INDETERMINATE',
});

const APPLICABLE_EVENTS = new Set(['pull_request', 'merge_group']);
const BYPASS_LABEL = 'fix-next';
const TESTS_WORKFLOW_FILE = 'test.yml';

/**
 * Pure, total classifier: the GitHub "list workflow runs" response payload ->
 * CLEAN | RED | INDETERMINATE. Never throws.
 *
 * - Not an object, or `workflow_runs` isn't an array -> INDETERMINATE: the
 *   shape we depend on is not present, so nothing can be concluded.
 * - No completed push runs found yet (e.g. a brand-new `release/**`/`hotfix/**`
 *   branch with no Tests history) -> CLEAN: absence of evidence of red is not
 *   evidence of red, and a brand-new branch must not be permanently unmergeable.
 * - The most recent run's `conclusion === 'success'` -> CLEAN.
 * - Anything else (failure, cancelled, timed_out, action_required, ...) -> RED.
 */
function classifyRunConclusion(payload) {
  if (payload === null || typeof payload !== 'object') return VERDICT.INDETERMINATE;
  if (!Array.isArray(payload.workflow_runs)) return VERDICT.INDETERMINATE;
  if (payload.workflow_runs.length === 0) return VERDICT.CLEAN;
  const [latest] = payload.workflow_runs;
  if (latest && latest.conclusion === 'success') return VERDICT.CLEAN;
  return VERDICT.RED;
}

// Run statuses that mean "an attempt is still going". A run object reports the
// state of its LATEST attempt only, so a re-run of a red run reads as
// in-flight with no trace of the failure it is re-running.
const IN_FLIGHT_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

function isInFlight(run) {
  return Boolean(run) && IN_FLIGHT_STATUSES.has(run.status);
}

/**
 * Pure, total: the "list workflow runs" payload (newest first, ANY status) ->
 * the verdict, the run it rests on, and why. Never throws.
 *
 * A completed newest run is judged by classifyRunConclusion. An in-flight
 * newest run is never read as healthy on its own:
 *  - a re-run (`run_attempt` > 1) whose previous attempt did not succeed is RED
 *    — the fetcher attaches that attempt's conclusion as
 *    `previous_attempt_conclusion`, because the list endpoint cannot show it;
 *  - otherwise the newest SETTLED run decides (red stays RED, green is CLEAN).
 * This is what stops a mid-flight re-run from hiding the failure it re-runs
 * (2026-10-27: it let #5755 and #5750 through behind a red `next`).
 *
 * @returns {{verdict:string, run:(object|null), reason:string}}
 */
function classifyBaseRuns(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.workflow_runs)) {
    return { verdict: VERDICT.INDETERMINATE, run: null, reason: 'malformed-payload' };
  }
  const runs = payload.workflow_runs;
  if (runs.length === 0) return { verdict: VERDICT.CLEAN, run: null, reason: 'resolved' };

  const [newest] = runs;
  if (!isInFlight(newest)) {
    return {
      verdict: classifyRunConclusion({ workflow_runs: [newest] }),
      run: newest,
      reason: 'resolved',
    };
  }

  const prior = newest.previous_attempt_conclusion;
  if (typeof prior === 'string' && prior !== '' && prior !== 'success') {
    return { verdict: VERDICT.RED, run: newest, reason: 'rerun-in-flight-after-failure' };
  }
  // A re-run of an attempt that succeeded: the newest evidence is green, so an
  // older red run must not turn the gate red.
  if (prior === 'success') {
    return { verdict: VERDICT.CLEAN, run: newest, reason: 'rerun-in-flight-after-success' };
  }

  const settled = runs.find((run) => !isInFlight(run));
  if (!settled) return { verdict: VERDICT.CLEAN, run: null, reason: 'newest-in-flight-no-history' };
  return {
    verdict: classifyRunConclusion({ workflow_runs: [settled] }),
    run: settled,
    reason: 'newest-in-flight',
  };
}

// merge_group heads are `gh-readonly-queue/<base>/pr-<N>-<40-hex sha>`; the
// name carries only the LAST PR of the group.
const QUEUE_REF_PATTERN = /^(?:refs\/heads\/)?gh-readonly-queue\/(.+)\/pr-(\d+)-[0-9a-f]{40}$/;

/** @returns {{base:string, prNumber:number}|null} */
function parseQueueRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = QUEUE_REF_PATTERN.exec(ref.trim());
  if (!match) return null;
  return { base: match[1], prNumber: Number(match[2]) };
}

// Repository permissions that may apply the bypass label. `maintain` is
// reported as `write` by this endpoint's legacy `permission` field; both are
// accepted so a role-name change cannot silently lock the bypass out.
const BYPASS_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const EVENT_PAGES_MAX = 10;

/**
 * merge_group has no label surface, so read it back from the API. The bypass
 * is honoured only when ALL hold, and every failure is "not authorized" (RED),
 * never fail-open:
 *  1. the ref names a PR and the group holds exactly that one commit — a group
 *     of several PRs would let one labelled PR carry unlabelled ones;
 *  2. the PR currently carries the label;
 *  3. the actor of the label's latest `labeled` event has write or admin
 *     permission (triage-role users can apply labels).
 *
 * `ghGet(path)` returns parsed JSON or throws.
 *
 * @returns {Promise<{authorized:boolean, reason:string, actor?:string, prNumber?:number}>}
 */
async function evaluateQueueBypass({ headRef, baseRef, baseSha, headSha, repo, ghGet } = {}) {
  const parsed = parseQueueRef(headRef);
  if (!parsed) return { authorized: false, reason: 'queue-ref-unparseable' };
  // The queue branch must be for the branch whose health is being judged.
  if (typeof baseRef === 'string' && baseRef !== '' && parsed.base !== baseRef) {
    return { authorized: false, reason: 'queue-base-mismatch', prNumber: parsed.prNumber };
  }
  const { prNumber } = parsed;
  if (!baseSha || !headSha) return { authorized: false, reason: 'no-group-shas', prNumber };

  try {
    const compare = await ghGet(`/repos/${repo}/compare/${baseSha}...${headSha}`);
    if (!compare || compare.total_commits !== 1) {
      return { authorized: false, reason: 'multi-pr-group', prNumber };
    }

    const labels = await ghGet(`/repos/${repo}/issues/${prNumber}/labels?per_page=100`);
    const hasLabel = Array.isArray(labels) && labels.some((l) => l && l.name === BYPASS_LABEL);
    if (!hasLabel) return { authorized: false, reason: 'no-label', prNumber };

    let actor = null;
    let exhausted = false;
    for (let page = 1; page <= EVENT_PAGES_MAX; page += 1) {
      const events = await ghGet(`/repos/${repo}/issues/${prNumber}/events?per_page=100&page=${page}`);
      if (!Array.isArray(events)) break;
      for (const event of events) {
        if (event && event.event === 'labeled' && event.label && event.label.name === BYPASS_LABEL) {
          actor = event.actor && typeof event.actor.login === 'string' ? event.actor.login : null;
        }
      }
      if (events.length < 100) break;
      if (page === EVENT_PAGES_MAX) exhausted = true;
    }
    // More events than we read: the latest `labeled` event may be unseen, so
    // the applier is unknown. Fail closed.
    if (exhausted) return { authorized: false, reason: 'label-applier-unknown', prNumber };
    if (!actor) return { authorized: false, reason: 'label-applier-unknown', prNumber };

    const perm = await ghGet(`/repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`);
    const level = perm && typeof perm.permission === 'string' ? perm.permission : '';
    if (!BYPASS_PERMISSIONS.has(level)) {
      return { authorized: false, reason: 'label-applier-lacks-write', actor, prNumber };
    }
    return { authorized: true, reason: 'queue-label', actor, prNumber };
  } catch (err) {
    return { authorized: false, reason: `bypass-check-failed: ${err.message}`, prNumber };
  }
}

/**
 * Dependency-injected orchestrator. `fetchLatestRun` is an async function
 * taking the resolved base branch name and returning the parsed API payload
 * (or throwing) — injected so tests never touch the network.
 * `evaluateQueueBypass` (merge_group only) is an async function returning
 * `{authorized, reason, actor}`; it is how a queued fix-forward is recognised.
 *
 * @returns {Promise<{verdict:string, payload:*, reason:string}>}
 */
async function resolveNextHealth({
  fetchLatestRun, eventName, baseRef, labels, evaluateQueueBypass: queueBypass,
} = {}) {
  if (!APPLICABLE_EVENTS.has(eventName)) {
    return { verdict: VERDICT.SKIPPED_NOT_APPLICABLE, payload: null, reason: 'not-applicable-event' };
  }

  if (typeof baseRef !== 'string' || baseRef.trim() === '') {
    return { verdict: VERDICT.INDETERMINATE, payload: null, reason: 'no-base-ref' };
  }

  let payload = null;
  try {
    payload = await fetchLatestRun(baseRef);
  } catch (err) {
    return { verdict: VERDICT.INDETERMINATE, payload: null, reason: `fetch-failed: ${err.message}` };
  }

  const assessed = classifyBaseRuns(payload);
  // The run the verdict rests on, so annotations link the red run and not the
  // in-flight re-run that sits in front of it.
  const evidence = assessed.run ? { workflow_runs: [assessed.run] } : payload;
  if (assessed.verdict !== VERDICT.RED) {
    const reason = assessed.reason === 'resolved' ? 'resolved' : assessed.reason;
    return { verdict: assessed.verdict, payload: evidence, reason };
  }

  // Escape hatch for the PR that is itself the fix-forward. pull_request runs
  // read the label from the event (`labels`). merge_group events carry no
  // labels, so the queue run asks the API instead (evaluateQueueBypass).
  const labelList = Array.isArray(labels) ? labels : [];
  if (labelList.includes(BYPASS_LABEL)) {
    return { verdict: VERDICT.BYPASSED, payload: evidence, reason: 'bypass-label' };
  }

  if (eventName === 'merge_group' && typeof queueBypass === 'function') {
    let decision;
    try {
      decision = await queueBypass();
    } catch (err) {
      decision = { authorized: false, reason: `bypass-check-failed: ${err.message}` };
    }
    if (decision && decision.authorized) {
      return {
        verdict: VERDICT.BYPASSED,
        payload: evidence,
        reason: decision.reason || 'queue-label',
        actor: decision.actor,
      };
    }
    return {
      verdict: VERDICT.RED,
      payload: evidence,
      reason: `${assessed.reason === 'resolved' ? 'red' : assessed.reason}; bypass: ${decision && decision.reason}`,
    };
  }

  return { verdict: VERDICT.RED, payload: evidence, reason: assessed.reason === 'resolved' ? 'red' : assessed.reason };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-next-health.cjs',
    '',
    'CI-only gate: checks whether the PR/merge-group\'s base branch\'s own last',
    'push-triggered Tests run is red, and fails the job (exit 1) when it is —',
    'unless the PR carries the "fix-next" bypass label. A push run that is',
    'still in flight (including a re-run of a failed run) never counts as',
    'healthy: a re-run whose previous attempt failed is RED, otherwise the',
    'newest settled run decides. Every other case (wrong event, no',
    'resolvable base ref, an unreadable API read) fails open (exit 0).',
    '',
    'On merge_group the label is read back from the API: the queue ref must',
    'name a PR, the group must hold exactly one commit, the PR must carry the',
    'label, and whoever applied it must have write or admin permission.',
    '',
    'Environment variables read:',
    '  GITHUB_EVENT_NAME     workflow trigger event; only "pull_request" and',
    '                        "merge_group" are checked',
    '  GITHUB_REPOSITORY     owner/repo',
    '  GITHUB_TOKEN          optional bearer token for the API read',
    '  GITHUB_BASE_REF       PR base branch name (pull_request events; set',
    '                        automatically by GitHub Actions)',
    '  MERGE_GROUP_BASE_REF  merge-group base ref (merge_group events; the',
    '                        caller workflow must populate this from',
    '                        github.event.merge_group.base_ref — a leading',
    '                        "refs/heads/" prefix is stripped if present)',
    '  GITHUB_API_URL        GitHub API base URL (default: https://api.github.com)',
    '  PR_LABELS             comma-separated PR label names (pull_request events;',
    '                        the caller workflow must populate this from',
    '                        github.event.pull_request.labels.*.name); checked',
    '                        for the literal "fix-next" bypass label',
    '  MERGE_GROUP_HEAD_REF  merge-group queue branch',
    '                        (github.event.merge_group.head_ref; falls back to',
    '                        GITHUB_REF)',
    '  MERGE_GROUP_BASE_SHA  merge-group base sha (github.event.merge_group.base_sha)',
    '  MERGE_GROUP_HEAD_SHA  merge-group head sha (github.event.merge_group.head_sha;',
    '                        falls back to GITHUB_SHA)',
    '  GITHUB_OUTPUT         path to append verdict= step output to',
    '  GITHUB_STEP_SUMMARY   path to append a human-readable summary to',
  ].join('\n');
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      throw new ExitError(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
}

function writeOutput(lines) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath !== 'string' || outputPath === '') return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
  } catch (err) {
    // A failure while REPORTING the verdict must never invert the gate.
    process.stderr.write(`::warning::failed to write GITHUB_OUTPUT: ${err.message}\n`);
  }
}

function writeSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath !== 'string' || summaryPath === '') return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(summaryPath, `${text}\n`);
  } catch (err) {
    process.stderr.write(`::warning::failed to write GITHUB_STEP_SUMMARY: ${err.message}\n`);
  }
}

function resolveBaseRef(eventName) {
  if (eventName === 'pull_request') {
    return process.env.GITHUB_BASE_REF || '';
  }
  if (eventName === 'merge_group') {
    const raw = process.env.MERGE_GROUP_BASE_REF || '';
    return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  }
  return '';
}

function parseLabels(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function runUrlOf(payload) {
  const run = payload && Array.isArray(payload.workflow_runs) ? payload.workflow_runs[0] : undefined;
  return run && typeof run.html_url === 'string' ? run.html_url : '(unknown run URL)';
}

// `argv` defaults to real CLI argv but is a parameter so tests can call
// main() in-process (e.g. main([])) without inheriting the test runner's own
// argv, which would otherwise trip parseArgs's "unknown argument" branch.
async function main(argv = process.argv.slice(2)) {
  parseArgs(argv);

  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const baseRef = resolveBaseRef(eventName);
  const labels = parseLabels(process.env.PR_LABELS);

  // JSON GET against the API. `path` is either absolute-from-root (starts with
  // `/`) or a full URL. Returns parsed JSON (null if the body is not JSON).
  const ghGet = async (pathOrUrl) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBase}${pathOrUrl}`;
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gsd-core-ci-next-health',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  // No `status=completed` filter: an in-flight re-run must be visible so it
  // cannot hide the failure it is re-running (see classifyBaseRuns).
  const fetchLatestRun = async (branch) => {
    const payload = await ghGet(
      `/repos/${repo}/actions/workflows/${TESTS_WORKFLOW_FILE}/runs`
      + `?branch=${encodeURIComponent(branch)}&event=push&per_page=5`,
    );
    const newest = payload && Array.isArray(payload.workflow_runs) ? payload.workflow_runs[0] : undefined;
    if (isInFlight(newest) && Number(newest.run_attempt) > 1) {
      // The list shows only the latest attempt; the previous one holds the
      // failure being re-run. An API error here propagates -> INDETERMINATE.
      // If this read fails we cannot show the re-run is not hiding a failure,
      // and failing open here would reopen the hole this closes: treat an
      // unreadable previous attempt as not-success (RED).
      try {
        const previous = await ghGet(
          `/repos/${repo}/actions/runs/${newest.id}/attempts/${Number(newest.run_attempt) - 1}`,
        );
        newest.previous_attempt_conclusion = previous && typeof previous.conclusion === 'string'
          ? previous.conclusion : 'unknown';
      } catch {
        newest.previous_attempt_conclusion = 'unknown';
      }
    }
    return payload;
  };

  const evaluateQueue = () => evaluateQueueBypass({
    headRef: process.env.MERGE_GROUP_HEAD_REF || process.env.GITHUB_REF || '',
    baseRef,
    baseSha: process.env.MERGE_GROUP_BASE_SHA || '',
    headSha: process.env.MERGE_GROUP_HEAD_SHA || process.env.GITHUB_SHA || '',
    repo,
    ghGet,
  });

  const result = await resolveNextHealth({
    fetchLatestRun, eventName, baseRef, labels, evaluateQueueBypass: evaluateQueue,
  });

  writeOutput([`verdict=${result.verdict}`]);
  writeSummary(`Base branch health: ${result.verdict}${result.reason ? ` (${result.reason})` : ''}`);

  if (result.verdict === VERDICT.RED) {
    const runUrl = runUrlOf(result.payload);
    process.stderr.write(
      `::error::the base branch "${baseRef}"'s own last Tests run is red or still re-running after a failure: ${runUrl} (${result.reason}) — `
      + 'wait for a fix-forward merge, or if THIS pull request is the fix, ask a '
      + `maintainer with write access to apply the "${BYPASS_LABEL}" label and re-queue it `
      + '(the queue run reads the label from the API; it must be the only PR in its merge group).\n',
    );
    return 1;
  }

  if (result.verdict === VERDICT.BYPASSED) {
    const runUrl = runUrlOf(result.payload);
    const by = result.actor ? ` (label applied by ${result.actor})` : '';
    process.stderr.write(
      `::warning::the base branch "${baseRef}"'s own last Tests run is red: ${runUrl} — `
      + `a human applied the "${BYPASS_LABEL}" label to explicitly override this gate${by}.\n`,
    );
    return 0;
  }

  if (result.verdict === VERDICT.INDETERMINATE) {
    process.stderr.write(
      `::warning::could not determine "${baseRef || '(no base ref)'}"'s Tests health (${result.reason}); `
      + 'proceeding (fail-open).\n',
    );
    return 0;
  }

  process.stdout.write(`Base branch health: ${result.verdict}\n`);
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  VERDICT,
  BYPASS_LABEL,
  TESTS_WORKFLOW_FILE,
  classifyRunConclusion,
  classifyBaseRuns,
  parseQueueRef,
  evaluateQueueBypass,
  resolveNextHealth,
  main,
};

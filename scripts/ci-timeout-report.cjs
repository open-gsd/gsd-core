'use strict';

/**
 * scripts/ci-timeout-report.cjs
 *
 * Scheduled CI-timeout trending report (#4036). Polls GitHub's Actions REST
 * API for recently completed jobs across test.yml, mutation.yml, and
 * install-smoke.yml, resolves each job's declared `timeout-minutes` budget,
 * computes elapsed-vs-cap via scripts/lib/ci-job-timing.cjs, and appends
 * new (never-before-seen) records to a JSONL history file. Every record also
 * carries the triggering `runEvent` (e.g. `push`/`pull_request`) so entries
 * for jobs whose matrix genuinely differs by trigger (e.g. `smoke`'s
 * push-only macOS row) can be told apart in the persisted trend — records
 * are never filtered by event, only labeled.
 *
 * Invoked from a GitHub Actions workflow via actions/github-script, e.g.:
 *   const report = require(`${process.env.GITHUB_WORKSPACE}/scripts/ci-timeout-report.cjs`);
 *   const result = await report.main({ github, context, core });
 *
 * Also exports a second, independent check (#5101): `checkShardBalance`
 * evaluates the #5071 Windows conformance shard-balance criteria (median gap
 * and per-shard p90 vs. frozen baselines) from live `next` push runs and
 * opens/comments on one tracking issue when the shards drift out of balance.
 * It is wired into ci-timeout-report.yml as its own workflow step, not into
 * `main()`.
 */

const yaml = require('js-yaml');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeElapsedPct, isNearCap, formatNearCapNotice,
} = require('./lib/ci-job-timing.cjs');

const HISTORY_PATH = path.join(__dirname, '..', 'tests', 'ci-timeout-budget-history.jsonl');
const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

// Static job name → job-id rules, first match wins, checked in array order
// (test-inert before test, since both job names start with "test ").
const JOB_RULES = [
  { workflowFile: 'test.yml', jobKey: 'test-inert', test: (name) => name === 'test (inert CI)' },
  { workflowFile: 'test.yml', jobKey: 'test', test: (name) => name.startsWith('test (') && name !== 'test (inert CI)' },
  { workflowFile: 'test.yml', jobKey: 'coverage-gate', test: (name) => name === 'Coverage gate (merged shards)' },
  { workflowFile: 'test.yml', jobKey: 'test-conformance', test: (name) => name.startsWith('conformance test (') },
  { workflowFile: 'install-smoke.yml', jobKey: 'smoke', test: (name) => name.startsWith('smoke (') },
];

function resolveJobTimeoutMinutes({ jobName, workflowFile, workflowYamlText, covered }) {
  if (workflowFile === 'mutation.yml') {
    const m = jobName.match(/^Stryker \(([^)]+)\)$/);
    if (!m) return null;
    const moduleName = m[1];
    if (!covered || !Object.prototype.hasOwnProperty.call(covered, moduleName)) return null;
    return covered[moduleName].timeoutMinutes || 15;
  }

  const rule = JOB_RULES.find((r) => r.workflowFile === workflowFile && r.test(jobName));
  if (!rule) return null;

  const doc = yaml.load(workflowYamlText);
  const budget = doc && doc.jobs && doc.jobs[rule.jobKey] ? doc.jobs[rule.jobKey]['timeout-minutes'] : undefined;
  return typeof budget === 'number' ? budget : null;
}

/**
 * @param {{job: object, workflowFile: string, workflowYamlText: ?string, covered: ?object}} args
 *   `job.runEvent` is the triggering event (e.g. `push`/`pull_request`) — carried through to
 *   the returned record so entries whose matrix genuinely differs by trigger (e.g. `smoke`'s
 *   push-only macOS row) can be distinguished in the persisted history.
 */
function parseJobRecord({ job, workflowFile, workflowYamlText, covered }) {
  if (!job.completed_at) return null;
  // #5088: a job that never executed has no duration to report. GitHub's jobs
  // API marks it two ways: `conclusion: 'skipped'` (it still carries a
  // `completed_at`), and — for skipped AND cancelled-before-start jobs alike —
  // a `completed_at` one second BEFORE `started_at`. Passing either shape to
  // computeElapsedPct throws, and nothing above this catches, so one such job
  // used to discard the whole scheduled report. Skip it here, at the API
  // boundary; computeElapsedPct stays strict because the in-job near-cap check
  // feeds it a live job's own clock, where a negative span is a real error. A
  // `cancelled` job with a real span is NOT skipped: a job killed at its
  // timeout-minutes cap is reported as cancelled, and is exactly what this
  // report exists to record.
  // A zero-length span is treated the same way: GitHub's timestamps have
  // one-second resolution and no job that actually ran is provisioned, run and
  // torn down within the same second. A record without a string `name` is
  // skipped too — resolveJobTimeoutMinutes would throw on it the same way, and
  // lose the whole report for one malformed entry.
  if (typeof job.name !== 'string' || job.conclusion === 'skipped') return null;
  const startMs = Date.parse(job.started_at);
  const endMs = Date.parse(job.completed_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const timeoutMinutes = resolveJobTimeoutMinutes({ jobName: job.name, workflowFile, workflowYamlText, covered });
  if (timeoutMinutes == null) return null;

  const { elapsedMs, pct } = computeElapsedPct({
    startedAt: job.started_at, completedAt: job.completed_at, timeoutMinutes,
  });

  return {
    runId: job.run_id,
    jobName: job.name,
    workflowFile,
    sha: job.head_sha,
    runEvent: job.runEvent,
    completedAt: job.completed_at,
    elapsedMs,
    timeoutMinutes,
    pct,
  };
}

function buildReportLines(runs, { workflowFile, workflowYamlText, covered }) {
  const records = [];
  for (const { run, jobs } of runs) {
    for (const job of jobs) {
      const rec = parseJobRecord({
        job: {
          ...job, run_id: run.id, head_sha: run.head_sha, runEvent: run.event,
        },
        workflowFile,
        workflowYamlText,
        covered,
      });
      if (rec) records.push(rec);
    }
  }
  return records;
}

function dedupeAgainstHistory(newRecords, historyText) {
  const seen = new Set();
  for (const line of String(historyText || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      seen.add(`${rec.runId}::${rec.jobName}`);
    } catch {
      // Malformed history line — skip it rather than crash the whole report.
    }
  }
  return newRecords.filter((r) => !seen.has(`${r.runId}::${r.jobName}`));
}

function formatHistoryLine(record) {
  return `${JSON.stringify(record)}\n`;
}

const WORKFLOW_FILES = ['test.yml', 'mutation.yml', 'install-smoke.yml'];
const MAX_RUNS_PER_WORKFLOW = 15;

/**
 * Orchestration entry point — impure, invoked from actions/github-script.
 *
 * @param {{github: object, context: object, core: object, historyPath?: string, fs?: object}} args
 * @returns {Promise<{added: number, nearCap: number}>}
 */
async function main({
  github, context, core, historyPath = HISTORY_PATH, fs: fsImpl = fs,
}) {
  const { owner, repo } = context.repo;
  const mutationMatrix = require('./mutation-matrix.cjs');

  const allNewRecords = [];

  for (const workflowFile of WORKFLOW_FILES) {
    const covered = workflowFile === 'mutation.yml' ? mutationMatrix.COVERED : null;
    const workflowYamlText = workflowFile === 'mutation.yml'
      ? null
      : fsImpl.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), 'utf8');

    let runsList;
    try {
      runsList = await github.paginate(github.rest.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: workflowFile,
        status: 'completed',
        per_page: 30,
      });
    } catch (err) {
      core.warning(`ci-timeout-report: failed to list runs for ${workflowFile}: ${err.message}`);
      continue;
    }

    const runs = runsList.slice(0, MAX_RUNS_PER_WORKFLOW);
    const runsWithJobs = [];

    for (const run of runs) {
      try {
        const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          owner,
          repo,
          run_id: run.id,
          per_page: 50,
        });
        runsWithJobs.push({ run, jobs });
      } catch (err) {
        core.warning(`ci-timeout-report: failed to list jobs for ${workflowFile} run ${run.id}: ${err.message}`);
      }
    }

    const records = buildReportLines(runsWithJobs, { workflowFile, workflowYamlText, covered });
    allNewRecords.push(...records);
  }

  let historyText = '';
  try {
    historyText = fsImpl.readFileSync(historyPath, 'utf8');
  } catch {
    // First run — history file does not exist yet, treat as empty.
    historyText = '';
  }

  const deduped = dedupeAgainstHistory(allNewRecords, historyText);

  if (deduped.length > 0) {
    const newLines = deduped.map(formatHistoryLine).join('');
    fsImpl.appendFileSync(historyPath, newLines);
  }
  // First-run bootstrap when there is nothing new to append is handled by
  // `git add` picking up whatever the history file already contains.

  let nearCapCount = 0;
  for (const record of deduped) {
    if (!isNearCap(record.pct)) continue;
    nearCapCount += 1;

    const notice = formatNearCapNotice({
      label: `${record.jobName} (run ${record.runId})`,
      pct: record.pct,
      elapsedMs: record.elapsedMs,
      capMs: record.timeoutMinutes * 60000,
    });

    core.warning(notice.warningLine.replace(/^::warning title=CI budget::/, ''));

    if (core.summary) {
      core.summary.addRaw(`${notice.summaryMarkdown}\n`);
    }
  }

  return { added: deduped.length, nearCap: nearCapCount };
}

// #5101 — Windows conformance shard-balance check (#5071 criteria), frozen.
// baselineP90Ms is keyed by `shard` string ("i/n") and frozen independently
// so a future edit cannot mutate it via the outer object being frozen only
// shallowly.
const SHARD_BALANCE = Object.freeze({
  workflowFile: 'test.yml',
  branch: 'next',
  event: 'push',
  since: '2026-09-28T14:17:51Z', // #5097 merge
  minRuns: 10,
  windowRuns: 20,
  maxMedianGapMs: 120000,
  baselineShardTotal: 3,
  baselineP90Ms: Object.freeze({
    '1/3': 1824000,
    '2/3': 2046000,
    '3/3': 2208000,
  }),
  issueTitle: 'CI: Windows conformance shard balance regressed',
});

const WINDOWS_SHARD_JOB_RE = /^conformance test \(windows-latest, [^,)]+, shard (\d+)\/(\d+)\)$/;

/**
 * ms elapsed for a job, or `null` when the job never actually executed
 * (skipped; missing/unparseable start or completion timestamp; completed at
 * or before started). These are the same never-executed rules #5088 puts in
 * `parseJobRecord`; once #5102 merges, `parseJobRecord` should call this
 * helper once so the rule lives in exactly one place.
 *
 * @param {{name?: string, conclusion?: string, started_at?: ?string, completed_at?: ?string}} job
 * @returns {?number}
 */
function jobSpanMs(job) {
  if (typeof job.name !== 'string') return null;
  if (job.conclusion === 'skipped') return null;

  const started = Date.parse(job.started_at);
  const completed = Date.parse(job.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  if (completed <= started) return null;

  return completed - started;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Nearest-rank percentile: sorted ascending, index Math.ceil(p*n)-1, clamped.
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const idx = Math.max(0, Math.ceil(p * n) - 1);
  return sorted[idx];
}

/**
 * @param {Array<{run: object, jobs: object[]}>} runsWithJobs
 * @param {object} config
 * @returns {Array<{runId: number, createdAt: string, index: number, total: number, shard: string, elapsedMs: number}>}
 */
function extractShardSamples(runsWithJobs, config) {
  const samples = [];
  for (const { run, jobs } of runsWithJobs) {
    if (Date.parse(run.created_at) < Date.parse(config.since)) continue;

    for (const job of jobs) {
      const m = typeof job.name === 'string' ? job.name.match(WINDOWS_SHARD_JOB_RE) : null;
      if (!m) continue;

      const elapsedMs = jobSpanMs(job);
      if (elapsedMs == null) continue;

      samples.push({
        runId: run.id,
        createdAt: run.created_at,
        index: Number(m[1]),
        total: Number(m[2]),
        shard: `${m[1]}/${m[2]}`,
        elapsedMs,
      });
    }
  }
  return samples;
}

/**
 * @param {Array<ReturnType<typeof extractShardSamples>[number]>} samples
 * @param {object} config
 * @returns {{status: string, runs: number, total: ?number, window: number, perShard: object[], gapMs: ?number, breaches: object[]}}
 */
function evaluateShardBalance(samples, config) {
  if (samples.length === 0) {
    return {
      status: 'insufficient-data', runs: 0, total: null, window: config.windowRuns, perShard: [], gapMs: null, breaches: [],
    };
  }

  // Newest layout = the `total` of the sample belonging to the run with the
  // latest createdAt.
  let newestSample = samples[0];
  for (const s of samples) {
    if (Date.parse(s.createdAt) > Date.parse(newestSample.createdAt)) newestSample = s;
  }
  const newestTotal = newestSample.total;
  const sameLayout = samples.filter((s) => s.total === newestTotal);

  // Group by runId, keep the newest config.windowRuns runs by createdAt.
  const runsByIdMap = new Map();
  for (const s of sameLayout) {
    if (!runsByIdMap.has(s.runId)) runsByIdMap.set(s.runId, { createdAt: s.createdAt, samples: [] });
    runsByIdMap.get(s.runId).samples.push(s);
  }
  const runEntries = [...runsByIdMap.entries()].sort(
    (a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt),
  );
  const keptRunEntries = runEntries.slice(0, config.windowRuns);
  const keptRunIds = new Set(keptRunEntries.map(([runId]) => runId));
  const keptSamples = sameLayout.filter((s) => keptRunIds.has(s.runId));

  const runsCount = keptRunIds.size;

  if (newestTotal !== config.baselineShardTotal) {
    const perShard = buildPerShard(keptSamples, newestTotal, config);
    return {
      status: 'baseline-mismatch', runs: runsCount, total: newestTotal, window: config.windowRuns, perShard, gapMs: null, breaches: [],
    };
  }

  const perShard = buildPerShard(keptSamples, newestTotal, config);
  const populated = perShard.filter((s) => s.n > 0);

  if (runsCount < config.minRuns || populated.length < 2) {
    return {
      status: 'insufficient-data', runs: runsCount, total: newestTotal, window: config.windowRuns, perShard, gapMs: null, breaches: [],
    };
  }

  let slowest = populated[0];
  let fastest = populated[0];
  for (const s of populated) {
    if (s.medianMs > slowest.medianMs) slowest = s;
    if (s.medianMs < fastest.medianMs) fastest = s;
  }
  const gapMs = slowest.medianMs - fastest.medianMs;

  const breaches = [];
  if (gapMs > config.maxMedianGapMs) {
    breaches.push({
      kind: 'gap', slowest: slowest.shard, fastest: fastest.shard, gapMs, limitMs: config.maxMedianGapMs,
    });
  }
  for (const s of perShard) {
    if (s.p90Ms != null && s.baselineP90Ms != null && s.p90Ms > s.baselineP90Ms) {
      breaches.push({
        kind: 'p90', shard: s.shard, p90Ms: s.p90Ms, baselineP90Ms: s.baselineP90Ms,
      });
    }
  }

  return {
    status: breaches.length > 0 ? 'breach' : 'ok',
    runs: runsCount,
    total: newestTotal,
    window: config.windowRuns,
    perShard,
    gapMs,
    breaches,
  };
}

function buildPerShard(samples, total, config) {
  const byShard = new Map();
  for (const s of samples) {
    if (!byShard.has(s.shard)) byShard.set(s.shard, []);
    byShard.get(s.shard).push(s.elapsedMs);
  }

  const perShard = [];
  for (let index = 1; index <= total; index += 1) {
    const shard = `${index}/${total}`;
    const values = byShard.get(shard) || [];
    if (values.length === 0) {
      perShard.push({
        shard, n: 0, medianMs: null, p90Ms: null, baselineP90Ms: config.baselineP90Ms[shard] ?? null,
      });
      continue;
    }
    perShard.push({
      shard,
      n: values.length,
      medianMs: median(values),
      p90Ms: percentile(values, 0.9),
      baselineP90Ms: config.baselineP90Ms[shard] ?? null,
    });
  }
  return perShard;
}

function msToMinutes(ms) {
  return (ms / 60000).toFixed(1);
}

/**
 * Pure markdown formatter for a shard-balance evaluation result.
 * @param {ReturnType<typeof evaluateShardBalance>} result
 * @returns {string}
 */
function formatShardBalanceSummary(result) {
  const lines = [];
  lines.push('### Windows conformance shard balance (#5071)');
  lines.push('');
  lines.push(`Status: **${result.status}** (${result.runs}/${result.window} runs evaluated)`);
  lines.push('');
  lines.push('| shard | runs | median (min) | p90 (min) | baseline p90 (min) |');
  lines.push('|---|---|---|---|---|');
  for (const s of result.perShard) {
    lines.push(`| ${s.shard} | ${s.n} | ${s.medianMs == null ? '—' : msToMinutes(s.medianMs)} | ${s.p90Ms == null ? '—' : msToMinutes(s.p90Ms)} | ${s.baselineP90Ms == null ? '—' : msToMinutes(s.baselineP90Ms)} |`);
  }
  for (const b of result.breaches) {
    if (b.kind === 'gap') {
      lines.push(`- gap breach: shard ${b.slowest} vs ${b.fastest} — ${msToMinutes(b.gapMs)} min gap (limit ${msToMinutes(b.limitMs)} min)`);
    } else if (b.kind === 'p90') {
      lines.push(`- p90 breach: shard ${b.shard} — ${msToMinutes(b.p90Ms)} min (baseline ${msToMinutes(b.baselineP90Ms)} min)`);
    }
  }
  return lines.join('\n');
}

/**
 * Orchestration entry point for the #5101 shard-balance check — impure,
 * invoked from actions/github-script as an independent workflow step.
 *
 * @param {{github: object, context: object, core: object, config?: object}} args
 * @returns {Promise<object>}
 */
async function checkShardBalance({
  github, context, core, config = SHARD_BALANCE,
}) {
  try {
    const { owner, repo } = context.repo;

    const runLimit = config.windowRuns * 2;
    // The Actions API returns runs newest-first, so stopping paging once
    // `runLimit` runs are collected keeps the newest ones and bounds API
    // cost regardless of how far back `config.since` reaches (Octokit
    // paginate's documented `done()` early exit).
    let fetched = 0;
    const runsList = await github.paginate(github.rest.actions.listWorkflowRuns, {
      owner,
      repo,
      workflow_id: config.workflowFile,
      branch: config.branch,
      event: config.event,
      status: 'completed',
      created: `>=${config.since}`,
      per_page: Math.min(100, runLimit),
    }, (response, done) => {
      fetched += response.data.length;
      if (fetched >= runLimit) done();
      return response.data;
    });

    const sortedRuns = [...runsList].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    const candidateRuns = sortedRuns.slice(0, runLimit);

    const runsWithJobs = [];
    for (const run of candidateRuns) {
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner,
        repo,
        run_id: run.id,
        per_page: 100,
      });
      runsWithJobs.push({ run, jobs });
    }

    const samples = extractShardSamples(runsWithJobs, config);
    const result = evaluateShardBalance(samples, config);

    const summary = formatShardBalanceSummary(result);
    if (core.summary) {
      core.summary.addRaw(summary);
      await core.summary.write();
    }

    let issue = { action: 'none' };

    if (result.status === 'breach' || result.status === 'baseline-mismatch') {
      const breachKinds = result.breaches.map((b) => b.kind).join(', ');
      core.warning(`ci-timeout-report shard-balance: status=${result.status}${breachKinds ? ` breaches=${breachKinds}` : ''}`);

      const body = `${summary}\n\nSee #5071 / #5101 and docs/how-to/read-ci-timeout-signals.md for background on this check.`;

      const searchResult = await github.rest.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:issue is:open in:title "${config.issueTitle}"`,
      });
      const existing = (searchResult.data.items || []).find(
        (item) => item.title === config.issueTitle && !item.pull_request,
      );

      if (existing) {
        await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body });
        issue = { action: 'commented', number: existing.number };
      } else {
        const created = await github.rest.issues.create({ owner, repo, title: config.issueTitle, body });
        issue = { action: 'created', number: created.data.number };
      }
    }

    return { ...result, issue };
  } catch (err) {
    core.warning(`ci-timeout-report: shard-balance check failed: ${err.message}`);
    return { status: 'error', error: err.message, issue: { action: 'none' } };
  }
}

module.exports = {
  HISTORY_PATH,
  WORKFLOWS_DIR,
  JOB_RULES,
  resolveJobTimeoutMinutes,
  parseJobRecord,
  buildReportLines,
  dedupeAgainstHistory,
  formatHistoryLine,
  main,
  SHARD_BALANCE,
  WINDOWS_SHARD_JOB_RE,
  jobSpanMs,
  median,
  percentile,
  extractShardSamples,
  evaluateShardBalance,
  formatShardBalanceSummary,
  checkShardBalance,
};

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
 *
 * Rolling-PR helpers: the workflow keeps one PR (`ROLLING_PR`) rebuilt on
 * `next` each run. `seedFromRollingPr` seeds the history with the open PR's
 * pending rows, but only rows that pass `sanitizeHistoryText` AND that the
 * Actions API confirms (`matchesApiJob`), because the branch is untrusted
 * (`mergeHistoryTexts` shares `historyRecordKey` with dedupeAgainstHistory), and
 * `evaluateRollingPrApproval` is the gate deciding whether the workflow may
 * approve that PR.
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
  // The exact rules (skipped, missing/unparseable timestamps, zero-or-negative
  // span, non-string name) live in jobSpanMs, shared with the #5101
  // shard-balance check.
  if (jobSpanMs(job) === null) return null;

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

/**
 * Identity of one history line: `runId::jobName`, or `null` when the line is
 * blank, unparseable, not a JSON object, or lacks `runId`/`jobName`. Shared by
 * dedupeAgainstHistory and mergeHistoryTexts so the two cannot drift.
 *
 * @param {?string} lineText
 * @returns {?string}
 */
function historyRecordKey(lineText) {
  const text = String(lineText ?? '').replace(/\r$/, '').trim();
  if (!text) return null;
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  return recordKey(rec);
}

/**
 * `runId::jobName` for a parsed record, or `null` when `rec` is not a
 * non-null, non-array object carrying both `runId` and `jobName`.
 *
 * @param {*} rec
 * @returns {?string}
 */
function recordKey(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (rec.runId == null || rec.jobName == null) return null;
  return `${rec.runId}::${rec.jobName}`;
}

function dedupeAgainstHistory(newRecords, historyText) {
  const seen = new Set();
  for (const line of String(historyText || '').split('\n')) {
    const key = historyRecordKey(line);
    if (key !== null) seen.add(key);
  }
  return newRecords.filter((r) => !seen.has(recordKey(r)));
}

/**
 * Union of history texts, first occurrence wins, input order preserved. Lines
 * without a record key (malformed / incomplete) are kept once by exact text so
 * no data is silently dropped. Blank lines are dropped; CRLF is normalized.
 *
 * @param {...?string} texts
 * @returns {string}
 */
function mergeHistoryTexts(...texts) {
  const seen = new Set();
  const kept = [];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const key = historyRecordKey(line);
      const identity = key === null ? `raw:${line}` : key;
      if (seen.has(identity)) continue;
      seen.add(identity);
      kept.push(line);
    }
  }
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

// The rolling branch is untrusted input: anyone with write access can push to
// it, and its rows are seeded into the history the bot then republishes. Only
// rows exactly matching what parseJobRecord emits are accepted.
const HISTORY_RECORD_LIMITS = Object.freeze({ maxLineLength: 1024, maxLines: 20000 });

const HISTORY_RECORD_KEYS = new Set([
  'runId', 'jobName', 'workflowFile', 'sha', 'runEvent', 'completedAt', 'elapsedMs', 'timeoutMinutes', 'pct',
]);

const isAbsentOrNull = (v) => v === undefined || v === null;

/**
 * @param {*} rec
 * @returns {boolean}
 */
function isValidHistoryRecord(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (!Object.keys(rec).every((k) => HISTORY_RECORD_KEYS.has(k))) return false;
  if (!Number.isSafeInteger(rec.runId) || rec.runId <= 0) return false;
  if (typeof rec.jobName !== 'string' || rec.jobName.length < 1 || rec.jobName.length > 200) return false;
  // Control characters (U+0000-U+001F, U+007F), checked by code unit so the
  // pattern needs no control-character regex (eslint no-control-regex).
  for (let i = 0; i < rec.jobName.length; i += 1) {
    const code = rec.jobName.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (typeof rec.workflowFile !== 'string' || !/^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(rec.workflowFile)) return false;
  if (!isAbsentOrNull(rec.sha) && !(typeof rec.sha === 'string' && /^[0-9a-f]{40}$/.test(rec.sha))) return false;
  if (!isAbsentOrNull(rec.runEvent) && !(typeof rec.runEvent === 'string' && /^[a-z_]{1,50}$/.test(rec.runEvent))) return false;
  if (
    !isAbsentOrNull(rec.completedAt)
    && !(typeof rec.completedAt === 'string' && rec.completedAt.length <= 40 && !Number.isNaN(Date.parse(rec.completedAt)))
  ) {
    return false;
  }
  if (!Number.isFinite(rec.elapsedMs) || rec.elapsedMs < 0) return false;
  if (!Number.isFinite(rec.timeoutMinutes) || rec.timeoutMinutes <= 0) return false;
  if (!Number.isFinite(rec.pct) || rec.pct < 0) return false;
  return true;
}

/**
 * Keeps only well-formed, in-schema, size-bounded lines of untrusted history
 * text, deduped by record key.
 *
 * @param {*} text
 * @param {{maxLineLength?: number, maxLines?: number}} [limits]
 * @returns {{text: string, kept: number, dropped: number}}
 */
function sanitizeHistoryText(text, { maxLineLength, maxLines } = HISTORY_RECORD_LIMITS) {
  if (typeof text !== 'string') return { text: '', kept: 0, dropped: 0 };
  const keptLines = [];
  let dropped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (keptLines.length >= maxLines || line.length > maxLineLength) {
      dropped += 1;
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    if (!isValidHistoryRecord(rec)) {
      dropped += 1;
      continue;
    }
    keptLines.push(line);
  }
  const merged = mergeHistoryTexts(keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '');
  return { text: merged, kept: merged === '' ? 0 : merged.split('\n').length - 1, dropped };
}

// The single rolling PR the workflow maintains; the workflow reads these values.
const ROLLING_PR = Object.freeze({
  branch: 'chore/4036-ci-timeout-budget-history',
  base: 'next',
  historyFile: 'tests/ci-timeout-budget-history.jsonl',
  title: 'chore(#4036): CI timeout budget history update',
  body: [
    'Refs #4036',
    '',
    'Automated, data-only update to `tests/ci-timeout-budget-history.jsonl`: new job/shard wall-clock vs. `timeout-minutes` records collected by `.github/workflows/ci-timeout-report.yml`.',
    '',
    'This is the single rolling PR for these records. Each scheduled run rebuilds the branch on the current `next` tip with every pending record, so it never conflicts with a sibling and is up to date as of the run. It is approved by the workflow only when it is exactly this branch, from this repository, at the commit the workflow pushed, changing only the history file, and then merges through auto-merge once required checks pass.',
    '',
    '<!-- pr-template-exempt: automated data-only rolling PR maintained by .github/workflows/ci-timeout-report.yml (#5115) -->',
  ].join('\n'),
});

/**
 * Approve-or-refuse gate for the rolling PR. Strict: approves only an OPEN,
 * same-repository PR on the rolling branch, targeting the base, at the exact
 * commit the workflow pushed, changing only the history file.
 *
 * @param {{pr?: object, expectedHeadOid?: string}} [args]
 * @returns {{approve: boolean, reason: string}}
 */
function evaluateRollingPrApproval({ pr, expectedHeadOid } = {}) {
  const refuse = (reason) => ({ approve: false, reason });
  if (!pr || typeof pr !== 'object' || !expectedHeadOid) return refuse('missing-input');
  if (pr.state !== 'OPEN') return refuse('not-open');
  if (pr.isCrossRepository !== false) return refuse('cross-repository');
  if (pr.headRefName !== ROLLING_PR.branch) return refuse('wrong-branch');
  if (pr.baseRefName !== ROLLING_PR.base) return refuse('wrong-base');
  if (pr.headRefOid !== expectedHeadOid) return refuse('head-moved');
  if (
    !Array.isArray(pr.files)
    || pr.files.length !== 1
    || String(pr.files[0] && pr.files[0].path).replace(/\\/g, '/') !== ROLLING_PR.historyFile
  ) {
    return refuse('unexpected-files');
  }
  return { approve: true, reason: 'ok' };
}

/**
 * Lines of `text` whose identity (record key, else exact text — the same rule
 * as mergeHistoryTexts) is not present in `baseText`, deduped, in input order.
 *
 * @param {*} text
 * @param {*} baseText
 * @returns {string}
 */
function subtractHistoryText(text, baseText) {
  const identityOf = (line) => {
    const key = historyRecordKey(line);
    return key === null ? `raw:${line}` : key;
  };
  const linesOf = (value) => (typeof value === 'string' ? value : '')
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\r$/, ''))
    .filter((line) => line.trim());

  const seen = new Set(linesOf(baseText).map(identityOf));
  const kept = [];
  for (const line of linesOf(text)) {
    const identity = identityOf(line);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(line);
  }
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

/**
 * True only when `rec` equals, field for field, the record parseJobRecord
 * would emit from the Actions API's run and job (the exact shape
 * buildReportLines passes), so every stored field is verified and only jobs
 * main() itself would record are accepted.
 *
 * @param {object} rec
 * @param {{run?: object, job?: object, workflowYamlText?: ?string, covered?: ?object}} [api]
 * @returns {boolean}
 */
function matchesApiJob(rec, {
  run, job, workflowYamlText, covered,
} = {}) {
  if (!rec || typeof rec !== 'object') return false;
  if (!run || typeof run !== 'object' || !job || typeof job !== 'object') return false;
  const workflowFile = String(run.path || '').split('/').pop();
  if (!WORKFLOW_FILES.includes(workflowFile)) return false;
  const built = parseJobRecord({
    job: {
      ...job, run_id: run.id, head_sha: run.head_sha, runEvent: run.event,
    },
    workflowFile,
    workflowYamlText,
    covered,
  });
  if (built === null) return false;
  const expected = JSON.parse(JSON.stringify(built));
  const expectedKeys = Object.keys(expected);
  const recKeys = Object.keys(rec);
  if (expectedKeys.length !== recKeys.length) return false;
  return expectedKeys.every((k) => Object.prototype.hasOwnProperty.call(rec, k) && Object.is(expected[k], rec[k]));
}

/**
 * Per-workflow inputs parseJobRecord needs, loaded exactly as main() does.
 *
 * @param {string} workflowFile
 * @param {{readFileSync: Function}} fsImpl
 * @returns {{workflowYamlText: ?string, covered: ?object}}
 */
function loadWorkflowContext(workflowFile, fsImpl) {
  if (workflowFile === 'mutation.yml') {
    return { workflowYamlText: null, covered: require('./mutation-matrix.cjs').COVERED };
  }
  return {
    workflowYamlText: fsImpl.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), 'utf8'),
    covered: null,
  };
}

/**
 * Seeds the history file with the open rolling PR's pending rows, but only
 * those the Actions API confirms: the branch is writable by any collaborator,
 * so a well-formed row is not evidence the job ran. Impure — invoked from
 * actions/github-script. Any non-404 API failure rejects so the workflow step
 * fails and the publish step is skipped.
 *
 * @param {{github: object, context: object, core: object, historyPath?: string, fs?: object, maxRuns?: number}} args
 * @returns {Promise<{status: string, pr?: number, candidate: number, verified: number, dropped: number}>}
 */
async function seedFromRollingPr({
  github, context, core, historyPath = HISTORY_PATH, fs: fsImpl = fs, maxRuns = 200,
  workflowContext = (workflowFile) => loadWorkflowContext(workflowFile, fsImpl),
}) {
  const { owner, repo } = context.repo;
  const contextCache = new Map();
  const contextFor = (workflowFile) => {
    if (!contextCache.has(workflowFile)) contextCache.set(workflowFile, workflowContext(workflowFile));
    return contextCache.get(workflowFile);
  };
  const zeros = { candidate: 0, verified: 0, dropped: 0 };

  const listed = await github.rest.pulls.list({
    owner, repo, state: 'open', base: ROLLING_PR.base, head: `${owner}:${ROLLING_PR.branch}`, per_page: 10,
  });
  const pr = (listed.data || []).find((p) => (
    p.head && p.head.repo && p.head.repo.full_name === `${owner}/${repo}` && p.head.ref === ROLLING_PR.branch
  ));
  if (!pr) return { status: 'no-pr', ...zeros };

  let branchText;
  try {
    const { data } = await github.rest.repos.getContent({
      owner, repo, path: ROLLING_PR.historyFile, ref: pr.head.sha, mediaType: { format: 'raw' },
    });
    if (typeof data === 'string') branchText = data;
    else if (Buffer.isBuffer(data)) branchText = data.toString('utf8');
    else if (data instanceof ArrayBuffer) branchText = Buffer.from(data).toString('utf8');
    else if (data instanceof Uint8Array) branchText = Buffer.from(data).toString('utf8');
    else throw new Error('ci-timeout-report: unexpected getContent payload type (expected raw text)');
  } catch (err) {
    if (err && err.status === 404) return { status: 'no-file', pr: pr.number, ...zeros };
    throw err;
  }

  let baseText = '';
  try {
    baseText = fsImpl.readFileSync(historyPath, 'utf8');
  } catch {
    baseText = '';
  }

  const s = sanitizeHistoryText(subtractHistoryText(branchText, baseText));
  const rowsByRun = new Map();
  for (const rowLine of s.text.split('\n').filter(Boolean)) {
    const rec = JSON.parse(rowLine);
    if (!rowsByRun.has(rec.runId)) rowsByRun.set(rec.runId, []);
    rowsByRun.get(rec.runId).push({ line: rowLine, rec });
  }
  const candidate = s.kept;

  const verifiedLines = [];
  let rowsDropped = 0;
  let runIndex = 0;
  for (const [runId, rows] of rowsByRun) {
    runIndex += 1;
    if (runIndex > maxRuns) {
      rowsDropped += rows.length;
      continue;
    }
    let run;
    let jobs;
    try {
      run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data;
      jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner, repo, run_id: runId, per_page: 50,
      });
    } catch (err) {
      if (err && err.status === 404) {
        rowsDropped += rows.length;
        continue;
      }
      throw err;
    }
    const workflowFile = String((run && run.path) || '').split('/').pop();
    if (!WORKFLOW_FILES.includes(workflowFile)) {
      rowsDropped += rows.length;
      continue;
    }
    const { workflowYamlText, covered } = contextFor(workflowFile);
    for (const row of rows) {
      if (jobs.some((job) => matchesApiJob(row.rec, {
        run, job, workflowYamlText, covered,
      }))) verifiedLines.push(row.line);
      else rowsDropped += 1;
    }
  }

  const verified = verifiedLines.length;
  if (verified > 0) {
    fsImpl.writeFileSync(historyPath, mergeHistoryTexts(baseText, `${verifiedLines.join('\n')}\n`));
  }

  const dropped = s.dropped + rowsDropped;
  if (dropped > 0) {
    core.warning(`ci-timeout-report: dropped ${dropped} pending row(s) from the rolling PR that failed schema or API verification`);
  }
  core.info(`ci-timeout-report: rolling PR #${pr.number}: ${candidate} candidate row(s), ${verified} API-verified, ${dropped} dropped`);
  return {
    status: 'seeded', pr: pr.number, candidate, verified, dropped,
  };
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
 * or before started). The single definition of "never executed" for this
 * file: parseJobRecord (#5088) and extractShardSamples (#5101) both call it.
 * A zero-length span counts as never executed because GitHub's timestamps
 * have one-second resolution and no job that ran is provisioned, run and
 * torn down within the same second; a record without a string `name` is
 * skipped because resolveJobTimeoutMinutes would throw on it and lose the
 * whole report.
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
  historyRecordKey,
  recordKey,
  mergeHistoryTexts,
  HISTORY_RECORD_LIMITS,
  isValidHistoryRecord,
  sanitizeHistoryText,
  ROLLING_PR,
  evaluateRollingPrApproval,
  subtractHistoryText,
  matchesApiJob,
  seedFromRollingPr,
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

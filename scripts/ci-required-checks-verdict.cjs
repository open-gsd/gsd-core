#!/usr/bin/env node
'use strict';

// ci-required-checks-verdict.cjs — #4990 merge-queue readiness.
//
// auto-backmerge.yml used to admin-merge its own PR immediately after opening
// it, before a single required check had even started (#4707/#4708). This
// module is the single-shot verdict read that
// .github/workflows/backmerge-merge-when-green.yml uses to decide whether a
// specific commit sha's required checks are actually green — no polling, no
// long-running wait.
//
// SOURCE OF TRUTH (review fix, BLOCKER): an earlier version of this script
// read `gh pr checks --required`, which OMITS a required context that has no
// check run yet at all — a PR opened seconds ago, before any workflow has
// even started, would read as an empty/partial set and could be
// misclassified as satisfied. This version instead:
//   1. Loads the required CONTEXTS from the ruleset file on the checked-out
//      DEFAULT branch (never PR-controlled) via `--required-from <path>` —
//      the authoritative, server-independent list of what must be green.
//   2. Reads the ACTUAL check-run history for the commit via
//      `gh api repos/<repo>/commits/<sha>/check-runs --paginate`, which
//      returns EVERY check run GitHub has ever recorded for that sha,
//      including ones still queued/in_progress — so a not-yet-started
//      required context is visible as genuinely absent, not silently
//      dropped.
// This makes "missing" a real, distinct signal (folded into 'pending' by the
// classifier — see below) rather than an artifact of which flags a
// short-lived CLI happened to pass.
//
// TRUST BOUNDARY (review fix, MEDIUM, residual risk — read this): only check
// runs whose `app.id === GITHUB_ACTIONS_APP_ID` are considered, and only
// when the run's `name` exactly matches a required context string. This
// closes the obvious spoof (a non-Actions GitHub App, or a raw Checks-API
// call from an arbitrary token, posting a same-named check run). It does
// NOT close every spoof: a PR that itself ADDS OR MODIFIES a workflow file
// can make the Actions app post an arbitrarily-named check run — app.id
// alone cannot distinguish "the trusted required-check workflow, as it
// exists on the default branch" from "a same-repo PR's own edited copy of
// some workflow, run under the same Actions app identity". Defense in depth
// against THAT specific spoof lives in backmerge-merge-when-green.yml's
// separate CONTENT-BINDING check (verifying the PR tree contains nothing but
// the expected back-merge diff), not in this script — a PR that could forge
// a same-named Actions check run is, by construction, also a PR whose
// content-binding check would fail, since forging that check run requires
// committing a modified workflow file into the PR itself.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// Every gh subprocess call is time-bounded (CLAUDE.md: git/npm/gh subprocess
// calls need timeouts) — a `gh api` read is a GitHub API call over the
// network, in the git/network subprocess class CLAUDE.md caps at 5-30s; 30s
// is the top of that range. UNCHANGED from the prior version of this script
// — no new timeout-named numeric literal is introduced here.
const GH_TIMEOUT_MS = 30000;

/** GitHub's own "GitHub Actions" App id — stable, documented, not a secret. */
const GITHUB_ACTIONS_APP_ID = 15368;

/** Per-context states a check run normalizes to. */
const STATE = Object.freeze({ PASS: 'pass', PENDING: 'pending', RED: 'red' });

const PASS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/**
 * Pure, total: one GitHub check-run object -> STATE.
 *   - status !== 'completed'        -> PENDING (still queued/in_progress)
 *   - conclusion success/skipped/neutral -> PASS
 *   - conclusion cancelled          -> PENDING (concurrency supersession: a
 *     newer run for the same context follows; genuine staleness — nothing
 *     newer ever arrives — is caught by backmerge-merge-when-green.yml's
 *     scheduled staleness sweep, not by this classifier)
 *   - conclusion failure/timed_out/action_required/startup_failure/stale -> RED
 *   - anything else (including an unrecognized future conclusion value) -> RED,
 *     fail closed
 */
function normalizeCheckRunState(run) {
  if (!run || typeof run !== 'object') return STATE.RED;
  if (run.status !== 'completed') return STATE.PENDING;
  const conclusion = run.conclusion;
  if (PASS_CONCLUSIONS.has(conclusion)) return STATE.PASS;
  if (conclusion === 'cancelled') return STATE.PENDING;
  if (RED_CONCLUSIONS.has(conclusion)) return STATE.RED;
  return STATE.RED;
}

/**
 * A run's primary ordering key: `started_at`, falling back to `created_at`
 * (always present per the Checks API contract) when `started_at` is null —
 * a queued/in_progress run commonly has no `started_at` yet. Returns `null`
 * when NEITHER is present.
 */
function sortKey(run) {
  return (run && (run.started_at || run.created_at)) || null;
}

/**
 * started_at/created_at (completed_at tie-break) compare: true iff `a` is
 * strictly newer than `b`.
 *
 * Review fix (NIT): a run with NO usable timestamp (missing both
 * started_at and created_at) is treated as the NEWEST, not the oldest —
 * a bare `|| ''` fallback sorts a queued/in_progress run with no
 * started_at yet BEHIND an older, already-completed run (empty string
 * sorts before any real timestamp), which would let a stale completed
 * result mask a fresher, still-running one. "Unknown recency" must never
 * resolve to "definitely old".
 */
function isNewerRun(a, b) {
  const aKey = sortKey(a);
  const bKey = sortKey(b);
  if (aKey === null && bKey === null) {
    // Neither run has a usable timestamp at all — fall through to
    // completed_at below rather than declaring either "newer".
  } else if (aKey === null) {
    return true;
  } else if (bKey === null) {
    return false;
  } else if (aKey !== bKey) {
    return aKey > bKey;
  }
  const aCompleted = (a && a.completed_at) || '';
  const bCompleted = (b && b.completed_at) || '';
  return aCompleted > bCompleted;
}

/**
 * Pure, total: reduce a raw check-run array (as returned by
 * `gh api .../check-runs --paginate`) to `{ [context]: STATE }`, one entry
 * per required context that has AT LEAST ONE matching, trusted run — a
 * context with none is simply absent from the result (the caller,
 * classifyRequiredChecks, treats an absent context as PENDING).
 *
 * Filters: only `app.id === GITHUB_ACTIONS_APP_ID` runs are considered
 * (residual risk documented in the module header); only runs whose `name`
 * exactly equals one of `requiredContexts`. When more than one trusted run
 * matches the same context (re-runs, retries), the NEWEST wins by
 * `started_at`, tie-broken by `completed_at` — this is what lets a fresh
 * green re-run supersede an older red one, and an older green NEVER masks a
 * newer red.
 */
function reduceCheckRunsToContextStates(checkRuns, requiredContexts) {
  const requiredSet = new Set(requiredContexts);
  const best = {}; // context -> { state, raw }
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    const appId = run.app && run.app.id;
    if (appId !== GITHUB_ACTIONS_APP_ID) continue;
    const name = run.name;
    if (typeof name !== 'string' || !requiredSet.has(name)) continue;
    const state = normalizeCheckRunState(run);
    const existing = best[name];
    if (!existing || isNewerRun(run, existing.raw)) {
      best[name] = { state, raw: run };
    }
  }
  const result = {};
  for (const [name, entry] of Object.entries(best)) result[name] = entry.state;
  return result;
}

/**
 * THE pure classifier (review fix: exported over NORMALIZED per-context
 * states, decoupled from the raw-API-parsing/newest-run-selection concerns
 * of reduceCheckRunsToContextStates above). `contextStates` maps a subset of
 * `requiredContexts` to a STATE; any required context absent from it is
 * treated as PENDING (never as an error, never as satisfied — "missing" and
 * "pending" are the same signal to a caller deciding whether to merge).
 *
 * Verdict: any RED -> 'red'; else any PENDING (including any missing
 * context) -> 'pending'; else (every required context present and PASS)
 * -> 'green'.
 *
 * @returns {{verdict:'green'|'pending'|'red', perContext:Record<string,string>}}
 *   `perContext` reports the EFFECTIVE state (including 'pending' for a
 *   missing context) for every entry in `requiredContexts`, for diagnostics.
 */
function classifyRequiredChecks(requiredContexts, contextStates) {
  const states = contextStates && typeof contextStates === 'object' ? contextStates : {};
  const perContext = {};
  for (const context of requiredContexts) {
    perContext[context] = states[context] || STATE.PENDING;
  }
  const values = Object.values(perContext);
  let verdict;
  if (values.includes(STATE.RED)) verdict = 'red';
  else if (values.includes(STATE.PENDING)) verdict = 'pending';
  else verdict = 'green';
  return { verdict, perContext };
}

/**
 * Pure: extract the required-status-check context names from a PARSED
 * ruleset document (e.g. .github/rulesets/main-protection.json). Throws if
 * no `required_status_checks` rule is present — an unreadable/malformed
 * source of truth must never silently resolve to "nothing is required"
 * (which would make every commit read as trivially green).
 */
function parseRequiredContexts(rulesetDoc) {
  const rules = (rulesetDoc && rulesetDoc.rules) || [];
  const rule = rules.find((r) => r && r.type === 'required_status_checks');
  if (!rule) {
    throw new Error('parseRequiredContexts: no required_status_checks rule found in the ruleset document');
  }
  const checks = (rule.parameters && rule.parameters.required_status_checks) || [];
  const contexts = checks.map((c) => c && c.context).filter((c) => typeof c === 'string' && c.length > 0);
  if (contexts.length === 0) {
    throw new Error('parseRequiredContexts: required_status_checks rule has zero contexts');
  }
  return contexts;
}

/** Load + parse the ruleset file at `rulesetPath` and extract its required contexts. */
function loadRequiredContexts(rulesetPath) {
  const raw = fs.readFileSync(rulesetPath, 'utf8');
  const doc = JSON.parse(raw);
  return parseRequiredContexts(doc);
}

/**
 * Parse the raw stdout of `gh api ... --paginate` (NO `--jq`/`--slurp`) into
 * one flat check-run array.
 *
 * Review fix (BLOCKER, code#1): `gh api --paginate --slurp --jq '...'` is
 * not a valid combination — `--slurp` and `--jq` cannot both apply the way
 * an earlier version of this script assumed (every real invocation errored).
 * `--paginate` alone emits ONE JSON document per page, concatenated back to
 * back on stdout with NO separator between them (e.g. `{"check_runs":[...]}
 * {"check_runs":[...]}`for a 2-page result) — this parses that shape
 * directly via bracket-depth scanning (respecting quoted strings, so a
 * `}`/`{` inside a string value never miscounts) rather than depending on
 * any further `gh`-side flag combination.
 *
 * Each parsed document is expected to be a check-runs LIST-endpoint page
 * object (`{ total_count, check_runs: [...] }`); its `check_runs` array is
 * flattened into the result. A page object with a missing/non-array
 * `check_runs` contributes nothing (tolerated — an edge-case empty page
 * shape, not evidence of corruption). A bare top-level array document (used
 * by this script's own tests, and tolerated defensively) is flattened
 * as-is.
 *
 * @throws {Error} on empty-but-non-whitespace, unbalanced, or otherwise
 *   unparseable input — the caller (readVerdict) turns that into the
 *   'error' verdict. A purely empty/whitespace string is NOT an error (it
 *   is what a genuinely zero-page response looks like) and returns `[]`.
 */
function parseCheckRunsPages(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('parseCheckRunsPages: expected a string');
  }
  if (stdout.trim() === '') {
    return [];
  }

  const docTexts = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) {
        throw new Error('parseCheckRunsPages: unbalanced closing bracket');
      }
      if (depth === 0 && start !== -1) {
        docTexts.push(stdout.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString) {
    throw new Error('parseCheckRunsPages: truncated/unbalanced JSON');
  }
  if (docTexts.length === 0) {
    throw new Error('parseCheckRunsPages: no JSON documents found in non-empty input');
  }

  const checkRuns = [];
  for (const text of docTexts) {
    const doc = JSON.parse(text);
    if (Array.isArray(doc)) {
      checkRuns.push(...doc);
    } else if (doc && Array.isArray(doc.check_runs)) {
      checkRuns.push(...doc.check_runs);
    }
  }
  return checkRuns;
}

/**
 * Single-shot orchestrator: read `run({ sha, repo })`, tolerate a thrown
 * error (network, `gh` missing, auth, a non-2xx API response) by resolving
 * 'error' — never by guessing. A run() that resolves CLEANLY but with
 * unparseable output (review fix, MINOR: this used to resolve 'none';
 * "clean exit, garbage data" and "a real read failure" are the same signal
 * to a caller deciding whether it is safe to merge — both must fail closed
 * the same way) also resolves 'error'.
 *
 * @returns {Promise<{verdict:'green'|'pending'|'red'|'error', perContext:Record<string,string>}>}
 */
async function readVerdict({ sha, repo, requiredContexts, run }) {
  let stdout;
  try {
    stdout = await run({ sha, repo });
  } catch {
    return { verdict: 'error', perContext: {} };
  }

  let checkRuns;
  try {
    checkRuns = parseCheckRunsPages(stdout);
  } catch {
    return { verdict: 'error', perContext: {} };
  }

  const contextStates = reduceCheckRunsToContextStates(checkRuns, requiredContexts);
  return classifyRequiredChecks(requiredContexts, contextStates);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-required-checks-verdict.cjs --sha <40-hex> --repo <owner/repo>',
    '    --required-from <path> [--pr <N>]',
    '',
    'Single-shot read of a commit sha\'s required status checks, sourced from',
    '.github/rulesets/main-protection.json (or whatever --required-from names)',
    'on the checked-out DEFAULT branch, cross-referenced against',
    '`gh api repos/<repo>/commits/<sha>/check-runs --paginate`. Prints the',
    'verdict as JSON and exits:',
    '  0 = green (every required context has a trusted, passing check run)',
    '  2 = pending (any required context is missing, queued, in_progress, or cancelled)',
    '  1 = red (a required context failed/timed out/etc.) or a read/parse error',
    '',
    '--pr <N> is optional and cosmetic only (included in log/error messages);',
    'it plays no part in which checks are read.',
  ].join('\n');
}

/** Positive-integer validation: rejects 0 (CLAUDE.md limit-1/limit/limit+1: 0 reject, 1/2 accept). */
function isPositiveIntegerString(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function parseArgs(argv) {
  const out = { sha: undefined, repo: undefined, requiredFrom: undefined, pr: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      throw new ExitError(0);
    } else if (arg === '--sha') {
      out.sha = argv[++i];
    } else if (arg === '--repo') {
      out.repo = argv[++i];
    } else if (arg === '--required-from') {
      out.requiredFrom = argv[++i];
    } else if (arg === '--pr') {
      out.pr = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.sha || !/^[0-9a-f]{40}$/i.test(out.sha)) {
    throw new Error('--sha <40-hex> is required');
  }
  if (!out.repo || typeof out.repo !== 'string' || !out.repo.includes('/')) {
    throw new Error('--repo <owner/repo> is required');
  }
  if (!out.requiredFrom || typeof out.requiredFrom !== 'string') {
    throw new Error('--required-from <path> is required');
  }
  if (out.pr !== undefined && !isPositiveIntegerString(out.pr)) {
    throw new Error('--pr, when given, must be a positive integer (0 is not a valid PR number)');
  }
  return out;
}

/**
 * Pure: the exact argv for the `gh api` read of every check run recorded
 * for `sha`. `--paginate` alone (review fix, BLOCKER, code#1: NOT combined
 * with `--slurp`/`--jq`, which is not a valid combination and errored on
 * every real invocation) — its multi-document stdout shape is parsed by
 * parseCheckRunsPages above.
 */
function buildCheckRunsArgv({ sha, repo }) {
  return ['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate'];
}

/** The default `run` seam: one bounded `gh api` invocation. See buildCheckRunsArgv. */
function defaultRun({ sha, repo }) {
  return execFileSync('gh', buildCheckRunsArgv({ sha, repo }), { timeout: GH_TIMEOUT_MS, encoding: 'utf8' });
}

/**
 * @param {{argv?:string[], run?:Function, stdout?:{write:Function}, stderr?:{write:Function}}} [opts]
 * Every dependency is injectable so tests drive this in-process — never by
 * spawning a fake `gh` binary on PATH (review fix, BLOCKER, Windows:
 * execFileSync without a shell cannot resolve a PATH-shadowed `gh.cmd`, so a
 * fake-binary test would silently fall through to the REAL gh.exe on a
 * Windows runner instead of the fake).
 * @returns {Promise<number>} the process exit code.
 */
async function main({
  argv = process.argv.slice(2),
  run = defaultRun,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { sha, repo, requiredFrom, pr } = parseArgs(argv);
  const requiredContexts = loadRequiredContexts(requiredFrom);

  const result = await readVerdict({ sha, repo, requiredContexts, run });
  stdout.write(`${JSON.stringify(result)}\n`);

  const label = pr ? `PR #${pr} (sha ${sha})` : `sha ${sha}`;

  if (result.verdict === 'green') return 0;
  if (result.verdict === 'pending') return 2;
  if (result.verdict === 'red') {
    const failing = Object.entries(result.perContext)
      .filter(([, state]) => state === STATE.RED)
      .map(([context]) => context);
    stderr.write(`::error::required checks are red for ${label}: ${failing.join(', ')}\n`);
  } else {
    stderr.write(`::error::could not read required checks for ${label}\n`);
  }
  return 1;
}

if (require.main === module) {
  runMain(() => main({
    argv: process.argv.slice(2),
    run: defaultRun,
    stdout: process.stdout,
    stderr: process.stderr,
  }));
}

module.exports = {
  GITHUB_ACTIONS_APP_ID,
  STATE,
  GH_TIMEOUT_MS,
  normalizeCheckRunState,
  isNewerRun,
  reduceCheckRunsToContextStates,
  classifyRequiredChecks,
  parseRequiredContexts,
  loadRequiredContexts,
  parseCheckRunsPages,
  buildCheckRunsArgv,
  readVerdict,
  defaultRun,
  parseArgs,
  isPositiveIntegerString,
  main,
};

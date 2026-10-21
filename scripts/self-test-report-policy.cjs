#!/usr/bin/env node
'use strict';

/**
 * Self-test report policy (#5612).
 *
 * A fix PR from someone who is not a listed maintainer must carry a
 * `## Self-test report` section holding a fenced `json` block that records what
 * the submitter ran: a failing-first test (fails on the base, passes on the
 * head), the commands, the environment, and a passing full suite, bound to the
 * PR's CURRENT head commit.
 *
 * TRUST MODEL. This validates shape and sha binding, not truth. A local run
 * cannot be attested; CI on the merge-group commit stays authoritative. The
 * report is a head start for the reviewer and a nudge on effort, nothing more.
 * Every result here is advisory until a maintainer chooses to require it.
 *
 * Pure module: the workflow hands in the PR body, head ref, title, author, head
 * sha and the maintainer list (read from the BASE sha, never the PR).
 */

const fs = require('node:fs');
const { runMain } = require('./lib/cli-exit.cjs');
const { parseMaintainers } = require('./reviewed-or-maintainer-policy.cjs');

const REASON = Object.freeze({
  OK_NOT_A_FIX: 'ok_not_a_fix',
  OK_MAINTAINER_AUTHOR: 'ok_maintainer_author',
  OK_BOT_AUTHOR: 'ok_bot_author',
  OK_REPORT: 'ok_report',
  FAIL_NO_REPORT: 'fail_no_report',
  FAIL_MALFORMED_JSON: 'fail_malformed_json',
  FAIL_SCHEMA: 'fail_schema',
  FAIL_STALE_SHA: 'fail_stale_sha',
  FAIL_NOT_FAILING_FIRST: 'fail_not_failing_first',
  FAIL_SUITE_NOT_PASSED: 'fail_suite_not_passed',
  FAIL_MAINTAINERS_UNREADABLE: 'fail_maintainers_unreadable',
  FAIL_INPUT_INVALID: 'fail_input_invalid',
});

const SCHEMA_VERSION = 1;
const TOOLS = new Set(['gsd-test', 'npm-test', 'manual']);
const SUITE_RESULTS = new Set(['passed', 'failed', 'skipped']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const EXCERPT_MAX = 2000;
const SECTION_TITLE = 'self-test report';

/** A PR is a "fix PR" when its head ref is fix/… or its title is a fix. */
function isFixPr({ headRef, title }) {
  if (typeof headRef === 'string' && headRef.startsWith('fix/')) return true;
  return typeof title === 'string' && /^fix(\([^)]*\))?!?:/i.test(title.trim());
}

function isBotLogin(login) {
  return typeof login === 'string' && /\[bot\]$/i.test(login);
}

/**
 * Find the first fenced ```json block inside the `## Self-test report` section.
 * Fence-aware: a `#` line inside a fence is not a heading. The section ends at
 * the next heading of the same or a higher level.
 * @returns {{found: boolean, json: string|null}}
 */
function extractReport(body) {
  const lines = String(body || '').split(/\r?\n/);
  let inFence = false;
  let fenceMarker = '';
  let sectionLevel = 0;
  let capturing = false;
  let captured = [];

  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (!inFence && fence) {
      if (sectionLevel > 0 && !capturing && fence[2].toLowerCase() === 'json') {
        capturing = true;
        captured = [];
      }
      inFence = true;
      fenceMarker = fence[1];
      continue;
    }
    if (inFence) {
      if (fence && fence[1][0] === fenceMarker[0] && fence[1].length >= fenceMarker.length && fence[2] === '') {
        inFence = false;
        if (capturing) return { found: true, json: captured.join('\n') };
        continue;
      }
      if (capturing) captured.push(line);
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\*\*/g, '').trim().toLowerCase();
      if (sectionLevel === 0) {
        if (text === SECTION_TITLE) sectionLevel = level;
      } else if (level <= sectionLevel) {
        return { found: false, json: null };
      }
    }
  }
  return { found: false, json: null };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} report - parsed JSON
 * @param {string} headSha
 * @returns {{ok: boolean, reason: string, problems: string[]}}
 */
function validateReport(report, headSha) {
  const problems = [];
  const fail = (reason) => ({ ok: false, reason, problems });

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    problems.push('the report must be a JSON object');
    return fail(REASON.FAIL_SCHEMA);
  }
  if (report.schema !== SCHEMA_VERSION) problems.push(`schema must be ${SCHEMA_VERSION}`);
  if (typeof report.head_sha !== 'string' || !SHA_RE.test(report.head_sha)) {
    problems.push('head_sha must be the 40-hex sha of your final commit');
  }
  if (!TOOLS.has(report.tool)) problems.push(`tool must be one of ${[...TOOLS].join(', ')}`);

  const ff = report.failing_first;
  if (!ff || typeof ff !== 'object' || Array.isArray(ff)) {
    problems.push('failing_first must be an object');
  } else if (ff.not_applicable_reason !== undefined) {
    if (!isNonEmptyString(ff.not_applicable_reason)) {
      problems.push('failing_first.not_applicable_reason must be a non-empty explanation');
    }
  } else {
    if (!isNonEmptyString(ff.test)) problems.push('failing_first.test must name the test file');
    if (typeof ff.fails_on_base !== 'boolean') problems.push('failing_first.fails_on_base must be true or false');
    if (typeof ff.passes_on_head !== 'boolean') problems.push('failing_first.passes_on_head must be true or false');
  }

  if (!Array.isArray(report.commands) || report.commands.length === 0 || !report.commands.every(isNonEmptyString)) {
    problems.push('commands must be a non-empty list of the commands you ran');
  }

  const suite = report.full_suite;
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    problems.push('full_suite must be an object');
  } else {
    if (!isNonEmptyString(suite.command)) problems.push('full_suite.command must name the command');
    if (!SUITE_RESULTS.has(suite.result)) problems.push(`full_suite.result must be one of ${[...SUITE_RESULTS].join(', ')}`);
    if (!isCount(suite.passed)) problems.push('full_suite.passed must be a non-negative integer');
    if (!isCount(suite.failed)) problems.push('full_suite.failed must be a non-negative integer');
  }

  const env = report.environment;
  if (!env || typeof env !== 'object' || Array.isArray(env) || !isNonEmptyString(env.os) || !isNonEmptyString(env.node)) {
    problems.push('environment must give os and node');
  }

  if (!isNonEmptyString(report.output_excerpt) || report.output_excerpt.length > EXCERPT_MAX) {
    problems.push(`output_excerpt must be a non-empty excerpt of at most ${EXCERPT_MAX} characters`);
  }

  if (problems.length > 0) return fail(REASON.FAIL_SCHEMA);

  // Structurally sound. Now the substantive checks, most informative first.
  if (report.head_sha.toLowerCase() !== String(headSha).toLowerCase()) {
    problems.push(`head_sha ${report.head_sha} is not the PR's current head ${headSha}; update the report after your last push`);
    return fail(REASON.FAIL_STALE_SHA);
  }
  if (ff.not_applicable_reason === undefined && !(ff.fails_on_base === true && ff.passes_on_head === true)) {
    problems.push('the failing-first test must fail on the base and pass on your head');
    return fail(REASON.FAIL_NOT_FAILING_FIRST);
  }
  if (suite.result !== 'passed' || suite.failed !== 0) {
    problems.push('the full suite must have passed with no failures');
    return fail(REASON.FAIL_SUITE_NOT_PASSED);
  }
  return { ok: true, reason: REASON.OK_REPORT, problems };
}

/**
 * @param {object} input
 * @param {string} input.body
 * @param {string} input.headRef
 * @param {string} input.title
 * @param {string} input.authorLogin
 * @param {string} input.headSha - 40 hex, read live
 * @param {Set<string>|null} input.maintainers - lowercase logins
 * @returns {{ok: boolean, reason: string, problems: string[]}}
 */
function evaluateSelfTestReport({ body, headRef, title, authorLogin, headSha, maintainers }) {
  const none = [];
  if (typeof authorLogin !== 'string' || authorLogin === '' || typeof headSha !== 'string' || !SHA_RE.test(headSha)) {
    return { ok: false, reason: REASON.FAIL_INPUT_INVALID, problems: none };
  }
  if (!isFixPr({ headRef, title })) return { ok: true, reason: REASON.OK_NOT_A_FIX, problems: none };
  if (isBotLogin(authorLogin)) return { ok: true, reason: REASON.OK_BOT_AUTHOR, problems: none };
  if (!(maintainers instanceof Set) || maintainers.size === 0) {
    return { ok: false, reason: REASON.FAIL_MAINTAINERS_UNREADABLE, problems: none };
  }
  if (maintainers.has(authorLogin.toLowerCase())) {
    return { ok: true, reason: REASON.OK_MAINTAINER_AUTHOR, problems: none };
  }

  const extracted = extractReport(body);
  if (!extracted.found) {
    return { ok: false, reason: REASON.FAIL_NO_REPORT, problems: ['no ```json block under a "## Self-test report" heading'] };
  }
  let parsed;
  try {
    parsed = JSON.parse(extracted.json);
  } catch (error) {
    return { ok: false, reason: REASON.FAIL_MALFORMED_JSON, problems: [`the report is not valid JSON: ${error.message}`] };
  }
  return validateReport(parsed, headSha);
}

function main() {
  let maintainersText;
  try {
    maintainersText = fs.readFileSync(process.env.MAINTAINERS_FILE || '.github/MAINTAINERS', 'utf8');
  } catch {
    maintainersText = undefined;
  }
  const parsed = parseMaintainers(maintainersText);

  const result = evaluateSelfTestReport({
    body: process.env.PR_BODY || '',
    headRef: process.env.HEAD_REF || '',
    title: process.env.PR_TITLE || '',
    authorLogin: process.env.PR_AUTHOR_LOGIN || '',
    headSha: process.env.HEAD_SHA || '',
    maintainers: parsed.ok ? parsed.logins : null,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const problem of result.problems) {
    // Annotation text is a fixed template plus the validator's own wording; the
    // PR author controls values, not this string, except head_sha which is hex-checked.
    process.stderr.write(`::error::Self-test report: ${problem.replace(/[\r\n]+/g, ' ').slice(0, 300)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${result.ok ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `reason=${result.reason}\n`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = { REASON, SCHEMA_VERSION, EXCERPT_MAX, isFixPr, extractReport, validateReport, evaluateSelfTestReport };

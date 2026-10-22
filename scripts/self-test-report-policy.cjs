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
const PLACEHOLDER_RE = /^<[^<>]*>$/;
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
 *
 * - Fence-aware: a `#` line inside a fence is not a heading. A fence may carry
 *   trailing info after the language (```json title="x"); only its first word
 *   names the language. A closing fence has no info and is at least as long as
 *   the opener, with the same character.
 * - HTML comments are skipped outside fences, so a block hidden in a comment
 *   (invisible in the rendered PR) is not the report.
 * - The section ends at the next heading of the same or a higher level.
 * - The first json block wins.
 *
 * @returns {{found: boolean, json: string|null}}
 */
// Lines longer than this are not fence or heading syntax. Capping what the
// regexes see keeps a crafted line of whitespace from costing more than a bounded
// amount of work (the body is attacker-controlled); captured JSON keeps its full text.
const SYNTAX_LINE_MAX = 1000;

/**
 * ATX heading → {level, text}, parsed without a backtracking regex: a body line
 * is attacker input and the obvious `^(#+)\s+(.*?)\s*#*\s*$` is cubic on a long
 * run of spaces. A trailing run of `#` is a closing sequence only when preceded
 * by whitespace (or the text is only hashes).
 */
function parseHeading(line) {
  const trimmed = line.trim();
  let level = 0;
  while (level < trimmed.length && trimmed[level] === '#') level += 1;
  if (level < 1 || level > 6) return null;
  if (level >= trimmed.length || !/\s/.test(trimmed[level])) return null;
  let text = trimmed.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end < text.length && (end === 0 || /\s/.test(text[end - 1]))) text = text.slice(0, end).trimEnd();
  return { level, text: text.replace(/\*\*/g, '').trim().toLowerCase() };
}

function extractReport(body) {
  const lines = String(body || '').split(/\r?\n/);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inComment = false;
  let sectionLevel = 0;
  let capturing = false;
  let captured = [];

  for (const full of lines) {
    const line = full.length > SYNTAX_LINE_MAX ? full.slice(0, SYNTAX_LINE_MAX) : full;
    if (!inFence) {
      if (inComment) {
        if (line.includes('-->')) inComment = false;
        continue;
      }
      const commentAt = line.indexOf('<!--');
      if (commentAt !== -1 && line.indexOf('-->', commentAt + 4) === -1) {
        inComment = true;
        continue;
      }
    }

    if (!inFence) {
      const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)(?:\s.*)?$/.exec(line);
      if (open) {
        if (sectionLevel > 0 && !capturing && open[2].toLowerCase() === 'json') {
          capturing = true;
          captured = [];
        }
        inFence = true;
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        continue;
      }
    } else {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false;
        if (capturing) return { found: true, json: captured.join('\n') };
        continue;
      }
      if (capturing) captured.push(full);
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      if (sectionLevel === 0) {
        if (heading.text === SECTION_TITLE) sectionLevel = heading.level;
      } else if (heading.level <= sectionLevel) {
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

/** Names of report fields whose string value is still an unfilled `<…>` placeholder. */
function placeholderFields(report) {
  const found = [];
  const check = (name, value) => {
    if (typeof value === 'string' && PLACEHOLDER_RE.test(value.trim())) found.push(name);
  };
  check('head_sha', report.head_sha);
  check('output_excerpt', report.output_excerpt);
  if (report.failing_first && typeof report.failing_first === 'object') {
    check('failing_first.test', report.failing_first.test);
    check('failing_first.not_applicable_reason', report.failing_first.not_applicable_reason);
  }
  if (Array.isArray(report.commands)) report.commands.forEach((c) => check('commands', c));
  if (report.full_suite && typeof report.full_suite === 'object') check('full_suite.command', report.full_suite.command);
  if (report.environment && typeof report.environment === 'object') {
    check('environment.os', report.environment.os);
    check('environment.node', report.environment.node);
  }
  return [...new Set(found)];
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

  // A value still in `<…>` is the template, not something the submitter filled in.
  for (const name of placeholderFields(report)) problems.push(`${name} is still the template placeholder; fill it in`);

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
  if (suite.result !== 'passed' || suite.failed !== 0 || suite.passed < 1) {
    problems.push('the full suite must have passed, with at least one passing test and no failures');
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

/** A value from the environment, or from the file named by `<NAME>_FILE` (live reads are too big for env). */
function fromEnvOrFile(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
  return process.env[name] || '';
}

function main() {
  let maintainersText;
  try {
    maintainersText = fs.readFileSync(process.env.MAINTAINERS_FILE || '.github/MAINTAINERS', 'utf8');
  } catch {
    maintainersText = undefined;
  }
  const parsed = parseMaintainers(maintainersText);

  const body = fromEnvOrFile('PR_BODY');
  const title = fromEnvOrFile('PR_TITLE');

  const result = body === undefined || title === undefined
    ? { ok: false, reason: REASON.FAIL_INPUT_INVALID, problems: [] }
    : evaluateSelfTestReport({
      body,
      headRef: process.env.HEAD_REF || '',
      title,
      authorLogin: process.env.PR_AUTHOR_LOGIN || '',
      headSha: process.env.HEAD_SHA || '',
      maintainers: parsed.ok ? parsed.logins : null,
    });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const problem of result.problems) {
    // The annotation text is the validator's own wording plus, for a JSON syntax
    // error, the parser's message (which can echo attacker text): strip newlines
    // so no extra workflow command can start a line.
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

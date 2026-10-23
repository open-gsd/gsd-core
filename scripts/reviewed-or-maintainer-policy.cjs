#!/usr/bin/env node
'use strict';

/**
 * "Reviewed or maintainer" policy (#5607).
 *
 * A pull request passes when EITHER
 *   1. its author is listed in .github/MAINTAINERS (a maintainer's own PR needs
 *      no second reviewer), OR
 *   2. someone other than the author, holding write/maintain/admin permission,
 *      has an APPROVED review on the CURRENT head sha as their latest standing
 *      review.
 *
 * Why this is a check and not a ruleset review count: a ruleset's
 * required_approving_review_count is one number for every author, so it cannot
 * say "required unless the author is a maintainer". The sole maintainer cannot
 * approve their own PR, which is what pushed merges onto `--admin` (#4990).
 *
 * Everything that could wrongly COUNT an approval fails closed here: a stale
 * sha, the author's own review, a reviewer without write access, a later
 * dismissal or change request by the same reviewer, a truncated review list, an
 * unreadable maintainer file. Wrongly FAILING only asks a maintainer for one
 * more review.
 *
 * This module is pure. The workflow gathers reviews and roles with `gh api` and
 * hands them in as files; the policy and the maintainer list are read from the
 * BASE branch, never from the PR (.github/workflows/reviewed-or-maintainer.yml).
 */

const fs = require('node:fs');
const { runMain } = require('./lib/cli-exit.cjs');

const REASON = Object.freeze({
  OK_MAINTAINER_AUTHOR: 'ok_maintainer_author',
  OK_APPROVED: 'ok_approved',
  FAIL_NO_APPROVAL: 'fail_no_approval',
  FAIL_STALE_APPROVAL_ONLY: 'fail_stale_approval_only',
  FAIL_MAINTAINERS_UNREADABLE: 'fail_maintainers_unreadable',
  FAIL_REVIEWS_INCOMPLETE: 'fail_reviews_incomplete',
  FAIL_INPUT_INVALID: 'fail_input_invalid',
});

// Permission levels allowed to give a qualifying approval. GitHub's
// `role_name` for collaborators: read, triage, write, maintain, admin.
const APPROVER_ROLES = new Set(['write', 'maintain', 'admin']);

// A GitHub login: alphanumerics and single hyphens, 1-39 chars, optional
// `[bot]` suffix. Anything else on a MAINTAINERS line is reported, not trusted.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

// Review states that change a reviewer's standing. COMMENTED and PENDING do
// not: a later comment does not withdraw an approval on GitHub either.
const STANDING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * @param {unknown} text - contents of .github/MAINTAINERS
 * @returns {{ok: boolean, logins: Set<string>, invalid: string[]}}
 */
function parseMaintainers(text) {
  const logins = new Set();
  const invalid = [];
  if (typeof text !== 'string') return { ok: false, logins, invalid };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    if (LOGIN_RE.test(line)) logins.add(line.toLowerCase());
    else invalid.push(line);
  }
  return { ok: logins.size > 0, logins, invalid };
}

function isBot(entry) {
  const user = entry && entry.user;
  return Boolean(user && (user.type === 'Bot' || /\[bot\]$/i.test(String(user.login || ''))));
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * @param {object} input
 * @param {string} input.authorLogin
 * @param {Set<string>} input.maintainers - lowercase logins
 * @param {Array<{user: {login: string}, state: string, commit_id: string}>} input.reviews - chronological
 * @param {Record<string, string>} input.roles - lowercase login -> permission role name
 * @param {string} input.headSha - 40 hex
 * @param {boolean} input.reviewsComplete - false when the review list may be truncated
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateReviewed({ authorLogin, maintainers, reviews, roles, headSha, reviewsComplete }) {
  if (typeof authorLogin !== 'string' || authorLogin === '') {
    return { ok: false, reason: REASON.FAIL_INPUT_INVALID };
  }
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) {
    return { ok: false, reason: REASON.FAIL_INPUT_INVALID };
  }
  if (!(maintainers instanceof Set) || maintainers.size === 0) {
    return { ok: false, reason: REASON.FAIL_MAINTAINERS_UNREADABLE };
  }

  const author = lower(authorLogin);
  if (maintainers.has(author)) return { ok: true, reason: REASON.OK_MAINTAINER_AUTHOR };

  if (!Array.isArray(reviews)) return { ok: false, reason: REASON.FAIL_INPUT_INVALID };
  if (reviewsComplete !== true) return { ok: false, reason: REASON.FAIL_REVIEWS_INCOMPLETE };

  // Latest standing review per reviewer (input is chronological).
  const standing = new Map();
  for (const entry of reviews) {
    const login = lower(entry && entry.user && entry.user.login);
    if (login === '' || !STANDING_STATES.has(entry.state)) continue;
    standing.set(login, entry);
  }

  let sawStaleApproval = false;
  for (const [login, entry] of standing) {
    if (login === author) continue;
    if (entry.state !== 'APPROVED') continue;
    // An app or bot (for example github-actions[bot] when Actions may approve
    // PRs) is not a human review, whatever permission it holds.
    if (isBot(entry)) continue;
    const role = roles && typeof roles === 'object' ? roles[login] : undefined;
    if (!APPROVER_ROLES.has(role)) continue;
    if (lower(entry.commit_id) === lower(headSha)) return { ok: true, reason: REASON.OK_APPROVED };
    sawStaleApproval = true;
  }

  return {
    ok: false,
    reason: sawStaleApproval ? REASON.FAIL_STALE_APPROVAL_ONLY : REASON.FAIL_NO_APPROVAL,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function main() {
  const maintainersText = (() => {
    try {
      return fs.readFileSync(process.env.MAINTAINERS_FILE || '.github/MAINTAINERS', 'utf8');
    } catch {
      return undefined;
    }
  })();
  const parsed = parseMaintainers(maintainersText);
  for (const line of parsed.invalid) {
    process.stderr.write(`::warning::MAINTAINERS: ignored malformed line: ${JSON.stringify(line)}\n`);
  }

  const reviews = process.env.REVIEWS_FILE ? readJson(process.env.REVIEWS_FILE) : undefined;
  const roles = process.env.ROLES_FILE ? readJson(process.env.ROLES_FILE) : undefined;

  const result = evaluateReviewed({
    authorLogin: process.env.PR_AUTHOR_LOGIN || '',
    maintainers: parsed.ok ? parsed.logins : null,
    reviews,
    roles: roles && typeof roles === 'object' ? roles : {},
    headSha: process.env.HEAD_SHA || '',
    // The workflow's `gh api --paginate` either returns every page or exits
    // non-zero before this runs; it states completeness explicitly.
    reviewsComplete: process.env.REVIEWS_COMPLETE === 'true',
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${result.ok ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `reason=${result.reason}\n`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = { REASON, APPROVER_ROLES, parseMaintainers, evaluateReviewed };

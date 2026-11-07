'use strict';

/**
 * Release ancestry check (#5894): `main` must be an ancestor of `next`.
 *
 * auto-backmerge.yml keeps that true by landing a merge commit of main into
 * next after every release. When the back-merge is squashed (#5730), main and
 * next stop sharing history and the next release -> main merge conflicts in
 * every version field. release.yml runs this before cutting or finalizing a
 * release so the break surfaces there, with the fix, instead of as a 91-file
 * conflict on the merge-back PR.
 *
 * Usage: node scripts/release-ancestry.cjs [--ancestor origin/main] [--descendant origin/next]
 * Exits 0 when the ancestor is reachable from the descendant, else 1.
 */

const { execFileSync } = require('node:child_process');
const { runMain } = require('./lib/cli-exit.cjs');

const ANCESTRY_VERDICT = Object.freeze({
  ANCESTOR: 'ancestor',
  DIVERGED: 'diverged',
  UNKNOWN: 'unknown',
});

const GIT_TIMEOUT_MS = 15000;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Default git runner: returns { status } for `git <args>`. */
function defaultGit(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
    return { status: 0 };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : null };
  }
}

/**
 * `git merge-base --is-ancestor` exits 0 (ancestor), 1 (not), or another code
 * (an error, e.g. an unknown ref). Only 0 and 1 are verdicts; anything else is
 * UNKNOWN, and the CLI treats UNKNOWN as a failure.
 */
function checkAncestry({ ancestor, descendant, git = defaultGit }) {
  const { status } = git(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (status === 0) return ANCESTRY_VERDICT.ANCESTOR;
  if (status === 1) return ANCESTRY_VERDICT.DIVERGED;
  return ANCESTRY_VERDICT.UNKNOWN;
}

function parseArgs(argv) {
  const out = { ancestor: 'origin/main', descendant: 'origin/next' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--ancestor' || flag === '--descendant') && typeof value === 'string' && REF_RE.test(value)) {
      out[flag.slice(2)] = value;
      i += 1;
    } else {
      return { error: `unexpected argument: ${flag}` };
    }
  }
  return out;
}

function main(argv = process.argv.slice(2), { git = defaultGit, stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    stderr.write(`::error::${args.error}\n`);
    return 1;
  }
  const verdict = checkAncestry({ ancestor: args.ancestor, descendant: args.descendant, git });
  stdout.write(`${JSON.stringify({ verdict, ancestor: args.ancestor, descendant: args.descendant })}\n`);
  if (verdict === ANCESTRY_VERDICT.ANCESTOR) return 0;
  stderr.write(verdict === ANCESTRY_VERDICT.DIVERGED
    ? `::error::${args.ancestor} is not an ancestor of ${args.descendant}, so the next release -> main merge will conflict (#5894). `
      + 'Land a back-merge of main into next as a merge commit first: push chore/backmerge-main-to-next-<short sha of main> '
      + '(next plus `git merge -s ours --no-ff origin/main`), open it against next, and merge it with '
      + '`node scripts/merge-commit-pr.cjs <PR>` as a repo admin. Never send it through the merge queue.\n'
    : `::error::could not read the ancestry of ${args.ancestor} and ${args.descendant} (git failed). Fetch both refs and retry.\n`);
  return 1;
}

if (require.main === module) runMain(main);

module.exports = { ANCESTRY_VERDICT, GIT_TIMEOUT_MS, checkAncestry, parseArgs, main };

'use strict';

// The review workflow's text (#3079, #1318, #1698): review.md documents review.default_reviewers no-flag selection, its
// precedence (individual flags, then --all, then the config), unknown and undetected slug handling and the failure path
// when every configured reviewer is unavailable; the Review Instructions region of the fenced build_prompt block
// requires source verification with file:line evidence and a graceful-degradation clause (the region is read with the
// sectionizer's fence matcher: a nested shorter fence does not end the block); every `codex exec` line (none today:
// the invocation moved into the lane descriptor) captures the review with -o, never redirects stdout into the review
// file, and discards stdout to /dev/null. The lane, runner and opencode-handler cases stay in the reduced
// tests/review-default-reviewers-workflow.test.cjs. Was the text half of that test (its #1698 block was folded in).

const path = require('node:path');
const { loadLib } = require('./lib/load-lib.cjs');

const REVIEW = 'gsd-core/workflows/review.md';
const SECTIONIZER = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const REAL_ROOT = path.join(__dirname, '..', '..', '..');
const WS = /\s/;
const REVIEW_TARGET = '{run_dir}/gsd-review-codex.md';

const isWord = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

// The `codex exec` lines other than the `--help` one.
const codexExecLines = (text) => text.split('\n').filter((line) => line.includes('codex exec') && !line.includes('codex exec --help'));

// /\s-o\s+\{run_dir\}\/gsd-review-codex\.md\b/ as a walk: a blank, `-o`, one or more blanks, the target, no word character after.
function capturesViaO(line) {
  for (let at = line.indexOf('-o'); at !== -1; at = line.indexOf('-o', at + 1)) {
    if (at === 0 || !WS.test(line[at - 1])) continue;
    let pos = at + 2;
    const blanks = pos;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (pos > blanks && line.startsWith(REVIEW_TARGET, pos) && !isWord(line[pos + REVIEW_TARGET.length])) return true;
  }
  return false;
}

// `>`, optional blanks, `target`, no word character after: the walk of />\s*target\b/.
function redirectsTo(line, target) {
  for (let at = line.indexOf('>'); at !== -1; at = line.indexOf('>', at + 1)) {
    let pos = at + 1;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (line.startsWith(target, pos) && !isWord(line[pos + target.length])) return true;
  }
  return false;
}

// The `## Review Instructions` section of the first ```markdown block after the build_prompt step, or the reason
// there is none. The opening fence is a backtick run followed by `markdown`; the closing fence is the matcher's `closes`.
function reviewInstructionsOf(text, matchFenceDelimiter) {
  const stepAt = text.indexOf('<step name="build_prompt">');
  if (stepAt === -1) return { error: 'build_prompt step must exist' };
  const lines = text.slice(stepAt).split('\n');
  let opener = null;
  let bodyStart = -1;
  for (let i = 0; i < lines.length && opener === null; i += 1) {
    const fence = matchFenceDelimiter(lines[i]);
    if (fence && fence.char === '`' && /^markdown\s*$/.test(fence.trailing)) {
      opener = { char: '`', len: fence.len };
      bodyStart = i + 1;
    }
  }
  if (opener === null) return { error: 'build_prompt must contain a ```markdown prompt block' };
  let bodyEnd = -1;
  for (let i = bodyStart; i < lines.length && bodyEnd === -1; i += 1) {
    const fence = matchFenceDelimiter(lines[i]);
    if (fence && fence.closes(opener)) bodyEnd = i;
  }
  if (bodyEnd === -1) return { error: 'build_prompt markdown fence must be closed' };
  const fenced = lines.slice(bodyStart, bodyEnd).join('\n');
  const heading = fenced.indexOf('## Review Instructions');
  if (heading === -1) return { error: 'fenced prompt must contain a ## Review Instructions section' };
  const next = fenced.indexOf('\n## ', heading + 1);
  return { region: next === -1 ? fenced.slice(heading) : fenced.slice(heading, next) };
}

const missingFrom = (region, phrases) => phrases.filter((phrase) => !region.includes(phrase));

function buildCheck({ loadSectionizer }) {
  return function check(ctx) {
    const sectionizer = loadLib(loadSectionizer, SECTIONIZER);
    if (sectionizer.error) ctx.fail(REVIEW, sectionizer.error);
    const review = ctx.doc(REVIEW);
    review
      .has('review.default_reviewers', 'review workflow must reference review.default_reviewers for no-flag selection')
      .has('Individual reviewer flags', 'review workflow must document precedence: flags > --all > review.default_reviewers')
      .has('--all', 'review workflow must document the --all override in the precedence order')
      .has('Unknown slugs warn', 'review workflow must document unknown slug handling')
      .has('Known-but-undetected slugs', 'review workflow must document undetected slug handling')
      .has('all configured reviewers are unavailable', 'review workflow must document the failure path when configured reviewers are unavailable')
      .has('fail', 'review workflow must document the failure path when configured reviewers are unavailable');

    let regionProblem = false;
    review.satisfies((text) => {
      if (sectionizer.error) return true;
      const found = reviewInstructionsOf(text, sectionizer.lib.matchFenceDelimiter);
      regionProblem = Boolean(found.error);
      return found.error || true;
    }, 'the build_prompt prompt block must carry a Review Instructions region');
    const regionPhrases = (phrases, why) => review.satisfies((text) => {
      if (sectionizer.error || regionProblem) return true;
      const missing = missingFrom(reviewInstructionsOf(text, sectionizer.lib.matchFenceDelimiter).region, phrases);
      return missing.length === 0 || `missing ${JSON.stringify(missing)}`;
    }, why);
    regionPhrases(['Verify against source', 'check each claim against the actual code', '`path/to/file:line`'],
      'build_prompt Review Instructions region must require source verification + file:line evidence');
    regionPhrases(['If you cannot read the repo (no file access)', 'downgrade that finding to an open question'],
      'build_prompt Review Instructions region must degrade gracefully for prompt-only reviewers');

    review
      .satisfies((text) => {
        const bad = codexExecLines(text).find((line) => !capturesViaO(line));
        return bad === undefined || `codex exec invocation must capture the review via -o {run_dir}/gsd-review-codex.md: ${bad.trim()}`;
      }, 'every codex exec invocation captures the review via -o <FILE>')
      .satisfies((text) => {
        const bad = codexExecLines(text).find((line) => redirectsTo(line, REVIEW_TARGET));
        return bad === undefined || `codex exec must not redirect stdout into the review file (teardown noise pollutes it): ${bad.trim()}`;
      }, 'no codex exec invocation redirects stdout into the review file')
      .satisfies((text) => {
        const bad = codexExecLines(text).find((line) => !redirectsTo(line, '/dev/null'));
        return bad === undefined || `codex exec must discard stdout to /dev/null so teardown output is not captured: ${bad.trim()}`;
      }, 'every codex exec invocation discards stdout to /dev/null');
  };
}

const realSectionizer = () => require(path.join(REAL_ROOT, SECTIONIZER));

module.exports = {
  // The linear walkers and the loader seam, exported for the differential properties and the loader cases of
  // tests/text-contracts.batch11.test.cjs.
  walkers: { codexExecLines, capturesViaO, redirectsTo, reviewInstructionsOf, buildCheck },
  id: 'review-default-reviewers-workflow',
  issue: '#3079',
  check: buildCheck({ loadSectionizer: realSectionizer }),
};

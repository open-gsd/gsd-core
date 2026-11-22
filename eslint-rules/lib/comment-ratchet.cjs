'use strict';

/**
 * comment-ratchet: what the two comment rules of ADR-6315 item 24 (#6342) find,
 * and the per-file baseline that lets them go live before every old site is fixed.
 *
 * A *directive* is a comment that begins with `eslint-disable`,
 * `eslint-disable-next-line`, `eslint-disable-line`, `allow-test-rule:` or
 * `allow-unbounded-subprocess:`. It must name an issue (`#NNN`) so a reader can
 * find out why the exemption exists and when it can go. A comment that only
 * mentions a directive in prose does not begin with one and is not a directive.
 *
 * A *comment block* is a block comment, or a run of line comments on
 * consecutive lines. A block over MAX_COMMENT_BLOCK_LINES lines is a
 * measurement log or an essay; it belongs in `docs/research/data/`, linked.
 *
 * The baseline is `eslint-rules/comment-ratchet.baseline.json`:
 * `{ "<repo-relative file>": { "directive": N, "block": N } }`. A file may carry
 * up to its baseline of each kind and no more. A file with FEWER sites than its
 * entry is not an error: a PR that merged first and removed one would otherwise
 * break every PR queued behind it until the shared file was regenerated. The
 * entry is lowered by `scripts/gen-comment-ratchet-baseline.cjs --write` (its
 * `--check` reports every entry above the file's count), so the numbers go down
 * when a maintainer runs it, and an empty baseline is the end state.
 */

const MAX_COMMENT_BLOCK_LINES = 15;

const DIRECTIVE_PREFIXES = Object.freeze([
  'eslint-disable-next-line',
  'eslint-disable-line',
  'eslint-disable',
  'allow-test-rule:',
  'allow-unbounded-subprocess:',
]);

const ISSUE_REF = /#\d+/;

/** @returns {boolean} whether `text` (a comment's value) begins with a directive */
function isDirective(text) {
  const trimmed = text.trim();
  return DIRECTIVE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Comments that are directives and name no issue.
 * @param {{type: string, value: string, loc: object}[]} comments
 */
function bareDirectives(comments) {
  return comments.filter((c) => isDirective(c.value) && !ISSUE_REF.test(c.value));
}

/**
 * Comment blocks longer than `max` lines. Consecutive `//` lines merge into one
 * block; a `/* *\/` comment is its own block. A shebang is not a comment here.
 * @param {{type: string, value: string, loc: {start: {line: number}, end: {line: number}}}[]} comments
 * @param {number} [max]
 * @param {(comment: object) => boolean} [startsLine] whether nothing but whitespace precedes the
 *   comment on its line; a trailing `code(); // note` is not part of a block
 * @returns {{loc: object, lines: number}[]} one entry per over-long block, at its first line
 */
function longBlocks(comments, max = MAX_COMMENT_BLOCK_LINES, startsLine = () => true) {
  const found = [];
  let run = null;
  const flush = () => {
    if (run && run.lines > max) found.push(run);
    run = null;
  };
  for (const c of comments) {
    if (c.type === 'Line' && !startsLine(c)) {
      flush();
    } else if (c.type === 'Line') {
      if (run && c.loc.start.line === run.endLine + 1) {
        run.lines += 1;
        run.endLine = c.loc.end.line;
      } else {
        flush();
        run = { loc: c.loc, lines: 1, endLine: c.loc.end.line };
      }
    } else {
      flush();
      const lines = c.loc.end.line - c.loc.start.line + 1;
      if (lines > max) found.push({ loc: c.loc, lines });
    }
  }
  flush();
  return found;
}

/**
 * Decide what to report for one file.
 * @param {number} count how many sites the file has
 * @param {number} allowed the file's baseline
 * @returns {{excess: number, stale: number}} sites beyond the baseline, and baseline beyond the sites
 */
function judge(count, allowed) {
  return { excess: Math.max(0, count - allowed), stale: Math.max(0, allowed - count) };
}

module.exports = {
  MAX_COMMENT_BLOCK_LINES,
  DIRECTIVE_PREFIXES,
  isDirective,
  bareDirectives,
  longBlocks,
  judge,
};

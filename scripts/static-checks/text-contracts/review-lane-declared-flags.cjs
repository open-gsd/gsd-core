'use strict';

// Since #6087 every review-lane sub refuses a flag the CLI surface registry does not declare for it, so a shipped
// file that passes one fails at run time: review.md's `review-lane plan ... --json` exited 1 and left
// gsd-review-lanes.json empty (#6713). Every `gsd_run [query] review-lane <sub>` (or `review-lane.<sub>`) call in
// shipped Markdown names a declared sub and passes only flags dispatch accepts for it: the sub's declared flags and
// the global ones, and the `--flag=value` form only for a declared eq-flag. Tokens after the sub's passthrough
// marker are candidate argv, not its flags.

const { loadLib } = require('./lib/load-lib.cjs');

const CLI_SURFACE_LIB = 'gsd-core/bin/lib/cli-surface.cjs';
const SECTIONIZER_LIB = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const loadCliSurface = () => require('../../../gsd-core/bin/lib/cli-surface.cjs');
const loadSectionizer = () => require('../../../gsd-core/bin/lib/markdown-sectionizer.cjs');

// The shipped Markdown roots that carry review-lane calls (workflows, references, commands and both skill trees).
const ROOTS = ['gsd-core', 'commands/gsd', 'skills', 'pi/package-skills'];
const REVIEW_MD = 'gsd-core/workflows/review.md';

// A call ends at a pipe, redirect, `;`, `&`, `)`, backtick or line end. Before matching, `\`-continued lines are
// joined, an inline code span's soft line breaks become spaces, and a `<name>` placeholder or a nested `$(...)`
// without a gsd_run call becomes one value token, so neither ends the call early.
const CALL = /gsd_run\s+(?:query\s+)?review-lane(?:\s+|\.)([a-z][a-z-]*)([^|;&>)`\n]*)/g;
const PLACEHOLDER = /<[A-Za-z][^<>\s]*>/g;
const SUBSTITUTION = /\$\((?![^()]*gsd_run)[^()]*\)/g;
// An inline span runs over soft line breaks but not across a blank line (CommonMark ends it at the paragraph).
const INLINE_SPAN = /(?<!`)`(?!`)(?:[^`\n]|\n(?![ \t]*\n))+`(?!`)/g;
// A flag token, bare, quoted, or as the word of a `${VAR:+--flag}` expansion; group 2 is an `=value` suffix.
const FLAG_TOKEN = /^(?:\$\{\w+:\+)?["']?--([a-z][a-z0-9-]*)(=\S*)?/;

/** The shell text of `text`: fenced bodies, then the prose with inline spans unwrapped; continuations joined. */
function shellText(text, scanFencedBlocks) {
  const lines = text.split('\n');
  const inFence = new Array(lines.length).fill(false);
  const bodies = [];
  for (const block of scanFencedBlocks(lines)) {
    const end = block.closeLineIdx === -1 ? lines.length : block.closeLineIdx;
    for (let i = block.openLineIdx; i <= Math.min(end, lines.length - 1); i += 1) inFence[i] = true;
    bodies.push(lines.slice(block.openLineIdx + 1, end).join('\n'));
  }
  const prose = lines.filter((_, i) => !inFence[i]).join('\n')
    .replace(INLINE_SPAN, (span) => span.replace(/\n/g, ' '));
  return [...bodies, prose].join('\n').replace(/\\\n/g, ' ').replace(PLACEHOLDER, 'x').replace(SUBSTITUTION, 'x');
}

/** Each review-lane call in `text`: the sub and its argument tokens. */
function reviewLaneCalls(text, scanFencedBlocks) {
  return [...shellText(text, scanFencedBlocks).matchAll(CALL)]
    .map((m) => ({ sub: m[1], tokens: m[2].trim().split(/\s+/).filter(Boolean) }));
}

/** The violations of one call against dispatch's acceptance rules. */
function callViolations({ sub, tokens }, { CLI_SURFACE, GLOBAL_FLAGS }) {
  const verb = `review-lane.${sub}`;
  if (!Object.prototype.hasOwnProperty.call(CLI_SURFACE, verb)) return [`${verb} is not declared in CLI_SURFACE`];
  const spec = CLI_SURFACE[verb];
  const spaced = new Set([
    ...(spec.valueFlags ?? []), ...(spec.booleanFlags ?? []), ...(spec.optionalValueFlags ?? []),
    ...GLOBAL_FLAGS.valueFlags, ...GLOBAL_FLAGS.booleanFlags,
  ]);
  const equals = new Set([...(spec.eqFlags ?? []), ...GLOBAL_FLAGS.eqFlags]);
  const marker = spec.passthroughAfter ? tokens.indexOf(spec.passthroughAfter) : -1;
  const own = marker === -1 ? tokens : tokens.slice(0, marker);
  const violations = [];
  for (const token of own) {
    // The shell removes a matching pair of outer quotes, so "--help" reaches dispatch as --help.
    if (GLOBAL_FLAGS.helpTokens.includes(token.replace(/^(["'])(.*)\1$/, '$2'))) continue;
    const m = FLAG_TOKEN.exec(token);
    if (!m) continue;
    const [, flag, value] = m;
    if (value !== undefined ? !equals.has(flag) : !spaced.has(flag)) {
      violations.push(`${verb} passes undeclared --${flag}${value !== undefined ? '=' : ''}`);
    }
  }
  return violations;
}

module.exports = {
  id: 'review-lane-declared-flags',
  issue: '#6713',
  check(ctx, loadSurface = loadCliSurface, loadFences = loadSectionizer) {
    const surface = loadLib(loadSurface, CLI_SURFACE_LIB);
    const fences = loadLib(loadFences, SECTIONIZER_LIB);
    if (surface.error) ctx.fail(CLI_SURFACE_LIB, surface.error);
    if (fences.error) ctx.fail(SECTIONIZER_LIB, fences.error);
    if (surface.error || fences.error) return;
    const { scanFencedBlocks } = fences.lib;
    // review.md must be in the scan: a renamed or deleted workflow is a finding, not a clean pass.
    ctx.exists(REVIEW_MD, 'the review-lane call scan must cover the /gsd-review workflow');
    for (const root of ROOTS) {
      for (const rel of ctx.list(root, '.md', 'the shipped Markdown is what the review-lane call scan covers')) {
        ctx.doc(rel).satisfies((text) => {
          const calls = reviewLaneCalls(text, scanFencedBlocks);
          // The scan must see the call #6713 was about, so a pattern that matches nothing cannot pass.
          if (rel === REVIEW_MD && !calls.some((c) => c.sub === 'plan')) return 'no review-lane plan call found in review.md';
          const violations = calls.flatMap((call) => callViolations(call, surface.lib));
          return violations.length === 0 || violations.join('; ');
        }, 'every review-lane call must pass only flags dispatch accepts for its sub');
      }
    }
  },
};

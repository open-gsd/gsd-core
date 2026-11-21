'use strict';

/**
 * max-comment-block-lines (ADR-6315 item 24, #6342)
 *
 * A comment block (a block comment, or consecutive `//` lines) may not exceed
 * 15 lines. A longer one is a measurement log or an essay: move it to
 * `docs/research/data/` and link it. Each file may carry up to its baseline of
 * over-long blocks (`comment-ratchet.baseline.json`); a file with fewer than
 * its baseline is lowered by the generator. See `lib/comment-ratchet.cjs`.
 */

const path = require('node:path');
const { MAX_COMMENT_BLOCK_LINES, longBlocks, judge } = require('./lib/comment-ratchet.cjs');

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: { description: `A comment block is at most ${MAX_COMMENT_BLOCK_LINES} lines` },
    schema: [{ type: 'object', properties: { baseline: { type: 'object' } }, additionalProperties: false }],
    messages: {
      long: `This comment block is {{lines}} lines; the ceiling is ${MAX_COMMENT_BLOCK_LINES}. Move it to docs/research/data/ and link it.`,
      excess: `This comment block is {{lines}} lines; the ceiling is ${MAX_COMMENT_BLOCK_LINES}. The file has {{count}} over-long blocks and its baseline allows {{allowed}}.`,
    },
  },
  create(context) {
    const options = context.options[0] || {};
    // The baseline arrives as a rule option (eslint.config.mjs loads the JSON), so a change to it
    // changes the resolved config and invalidates ESLint's result cache.
    const baseline = options.baseline || {};
    const rel = path.relative(context.cwd, context.filename).split(path.sep).join('/');
    const allowed = (baseline[rel] && baseline[rel].block) || 0;
    return {
      Program() {
        const sourceCode = context.sourceCode;
        const startsLine = (comment) => {
          const before = sourceCode.getTokenBefore(comment, { includeComments: true });
          return !before || before.loc.end.line < comment.loc.start.line;
        };
        const blocks = longBlocks(sourceCode.getAllComments(), MAX_COMMENT_BLOCK_LINES, startsLine);
        const { excess } = judge(blocks.length, allowed);
        if (excess > 0) {
          // A file with FEWER blocks than its entry is not an error (see directive-names-issue.cjs).
          for (const block of blocks.slice(allowed)) {
            context.report({
              loc: block.loc,
              messageId: allowed === 0 ? 'long' : 'excess',
              data: { lines: block.lines, count: blocks.length, allowed },
            });
          }
        }
      },
    };
  },
};

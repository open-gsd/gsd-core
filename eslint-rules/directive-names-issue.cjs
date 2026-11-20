'use strict';

/**
 * directive-names-issue (ADR-6315 item 24, #6342)
 *
 * An exemption directive (`eslint-disable*`, `allow-test-rule:`,
 * `allow-unbounded-subprocess:`) must name an issue as `#NNN`, so a reader can
 * find out why it exists and when it can go. Each file may carry up to its
 * baseline of bare directives (`comment-ratchet.baseline.json`); a file with
 * fewer than its baseline must lower it. See `lib/comment-ratchet.cjs`.
 */

const path = require('node:path');
const { bareDirectives, judge } = require('./lib/comment-ratchet.cjs');
const defaultBaseline = require('./comment-ratchet.baseline.json');

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'An exemption directive names the issue that justifies it' },
    schema: [{ type: 'object', properties: { baseline: { type: 'object' } }, additionalProperties: false }],
    messages: {
      bare: 'This exemption directive names no issue. Add `#NNN` for the issue that justifies it and says when it can go.',
      excess: 'This file has {{count}} exemption directives with no issue reference; its baseline allows {{allowed}}. Name an issue (`#NNN`) in the new one.',
      stale: 'This file has {{count}} exemption directives with no issue reference but a baseline of {{allowed}}. Lower its entry in eslint-rules/comment-ratchet.baseline.json to {{count}} (remove the entry at 0).',
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const baseline = options.baseline || defaultBaseline;
    const rel = path.relative(context.cwd, context.filename).split(path.sep).join('/');
    const allowed = (baseline[rel] && baseline[rel].directive) || 0;
    return {
      Program() {
        const bare = bareDirectives(context.sourceCode.getAllComments());
        const { excess, stale } = judge(bare.length, allowed);
        if (excess > 0) {
          // The baseline covers the first `allowed` sites; the rest are the new ones.
          for (const comment of bare.slice(allowed)) {
            context.report({
              loc: comment.loc,
              messageId: allowed === 0 ? 'bare' : 'excess',
              data: { count: bare.length, allowed },
            });
          }
        } else if (stale > 0) {
          context.report({ loc: { line: 1, column: 0 }, messageId: 'stale', data: { count: bare.length, allowed } });
        }
      },
    };
  },
};

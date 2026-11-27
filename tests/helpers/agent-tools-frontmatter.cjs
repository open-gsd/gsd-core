'use strict';

/**
 * tests/helpers/agent-tools-frontmatter.cjs — shared frontmatter readers for
 * agent-contract tests. parseTools was duplicated verbatim in
 * tests/agent-tools.install.test.cjs and
 * tests/6508-roadmapper-edit-tool-grant.test.cjs; CLAUDE.md's shared-parser
 * parity rule ("when two surfaces share a constant, array or parser, add a
 * parity test that fails if they diverge") is satisfied the stronger way:
 * ONE copy both files require, so they cannot diverge.
 */

const { parseFrontmatter } = require('../../gsd-core/bin/lib/frontmatter.cjs');

/**
 * Read the tools: frontmatter as a token list. tools may be a string or an
 * array; trailing '#...' comments are stripped; tokens split on commas and
 * whitespace.
 */
function parseTools(content) {
  const tools = (parseFrontmatter(content) || {}).tools;
  if (tools === undefined || tools === null) return [];
  if (typeof tools === 'object' && !Array.isArray(tools)) return [];
  return (Array.isArray(tools) ? tools : [tools])
    .flatMap((value) => String(value).replace(/\s+#.*$/, '').split(/[,\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Everything after the closing --- frontmatter fence; the directive body. */
function bodyOf(content) {
  const fence = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(content);
  return fence ? content.slice(fence[0].length) : content;
}

module.exports = { parseTools, bodyOf };

'use strict';

/**
 * no-adhoc-markdown-parsing
 *
 * Flags hand-rolled markdown-structure scanning in src/*.cts that duplicates
 * the canonical seam (src/markdown-sectionizer.cts). Applies to two patterns:
 *
 *   1. FENCE-BLOCK-STRIP — regex literals whose source contains a triple-backtick
 *                          or triple-tilde fence delimiter AND a multiline body
 *                          ([\s\S] or [\S\s]), indicating the regex strips/matches
 *                          a fenced CODE BLOCK spanning multiple lines.
 *
 *                          A bare single-line fence-opener test like /^```/ or
 *                          /^\s*(?:```|~~~)/ is NOT flagged — that is line
 *                          detection / normalisation, not block-stripping.
 *
 *   2. SECTION-COLLECT   — regex literals of the shape
 *                          /(#{...}\n)([\s\S]*?)(?=\n#{...}|$)/  (a heading
 *                          capture followed by a non-greedy body up to a heading
 *                          lookahead). These hand-roll what collectSection() owns.
 *                          Fingerprint: [\\s\\S] (multiline body) AND (?= lookahead
 *                          that references a heading anchor #.
 *
 * Per-finding exemption: add  // allow-adhoc-markdown: <reason>  as a
 * trailing comment on the same source line, OR as a standalone comment on the
 * line immediately preceding the flagged node.  (Mirrors no-source-grep's
 * // allow-test-rule: mechanism but is scoped to individual findings.)
 *
 * Authors must import from src/markdown-sectionizer.cts instead.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hand-rolled markdown-structure scanning (fence-block-strip, section-collect) in src/*.cts — import the markdown-sectionizer seam instead.',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      fenceRegex:
        'Ad-hoc fence-block-strip regex detected (triple-fence delimiter + multiline body). Import stripFencedCode() from ./markdown-sectionizer instead. Suppress with: // allow-adhoc-markdown: <reason>',
      sectionCollect:
        'Ad-hoc section-collect regex detected (heading + [\\s\\S]*? + lookahead). Import collectSection() from ./markdown-sectionizer instead. Suppress with: // allow-adhoc-markdown: <reason>',
    },
  },

  create(context) {
    // Only run on src/*.cts files
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (!/(?:^|\/)src\/[^/]+\.cts$/.test(filename.replace(/\\/g, '/'))) {
      return {};
    }

    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;

    /**
     * Check whether a node has a trailing  // allow-adhoc-markdown: <reason>
     * comment on the same source line, OR a standalone allow comment on the
     * line immediately before the node's start line.
     */
    function isAllowed(node) {
      const nodeStartLine = node.loc.start.line;

      const allComments = sourceCode.getAllComments();
      return allComments.some((c) => {
        if (!/allow-adhoc-markdown:\s*\S/.test(c.value)) return false;
        // Same line, or one line above
        return c.loc.start.line === nodeStartLine || c.loc.start.line === nodeStartLine - 1;
      });
    }

    // ── Fence-block-strip detection ──────────────────────────────────────────
    // A regex literal whose source contains ``` or ~~~ AND contains [\s\S] or
    // [\S\s] (a multiline body), indicating it strips/matches a fenced block.
    // A bare /^```/ or /^\s*(?:```|~~~)/ (line-detection, no multiline body)
    // is explicitly NOT flagged.
    const TRIPLE_BACKTICK = '```'; // ```
    const TRIPLE_TILDE = '~~~';

    function isFenceBlockStripRegex(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      const src = node.regex.pattern || '';
      // Must contain a triple fence delimiter
      if (!src.includes(TRIPLE_BACKTICK) && !src.includes(TRIPLE_TILDE)) return false;
      // Must ALSO contain a multiline body marker — i.e. it spans blocks, not just lines
      const hasMultilineBody = src.includes('[\\s\\S]') || src.includes('[\\S\\s]');
      return hasMultilineBody;
    }

    // ── Section-collect regex detection ─────────────────────────────────────
    // Matches patterns of the shape:
    //   /(#{1,6}...\n)([\s\S]*?)(?=\n#{...}|$)/
    // The key fingerprint is: [\\s\\S] (or [\s\S]) AND (?= (lookahead) AND # in
    // the same regex, forming the "body up to next heading" construct.
    function isSectionCollectRegex(node) {
      if (node.type !== 'Literal' || !node.regex) return false;
      const src = node.regex.pattern || '';
      // Must contain [\s\S] (the non-greedy body)
      const hasMultilineBody = src.includes('[\\s\\S]') || src.includes('[\\S\\s]');
      if (!hasMultilineBody) return false;
      // Must contain a lookahead (?= that references a heading anchor #
      const hasHeadingLookahead = /\(\?=.*#/.test(src);
      return hasHeadingLookahead;
    }

    return {
      Literal(node) {
        // 1. Fence-block-strip regex
        if (isFenceBlockStripRegex(node)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'fenceRegex' });
          }
          return;
        }

        // 2. Section-collect regex
        if (isSectionCollectRegex(node)) {
          if (!isAllowed(node)) {
            context.report({ node, messageId: 'sectionCollect' });
          }
        }
      },
    };
  },
};

module.exports = rule;

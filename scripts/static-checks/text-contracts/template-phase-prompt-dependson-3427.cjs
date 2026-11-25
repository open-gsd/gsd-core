'use strict';

// The phase-prompt template teaches only full-form `depends_on` plan ids (#3427 / #3473 B8). resolveDependencyId
// resolves a token only when it is a full plan id or a canonical id, so a bare short-form suffix (`"01"`) resolves to
// nothing and every caller silently drops the edge, collapsing the phase into wave 1. Every non-empty `depends_on:`
// example in gsd-core/templates/phase-prompt.md lists `NN-NN` full-form ids only, and the template carries enough
// examples (at least 8, at least one non-empty) that the check is not vacuous. Was
// tests/template-phase-prompt-dependson-3427.test.cjs; its good/bad sample test is a case of
// tests/text-contracts.test.cjs on the exported helpers.

const FULL_FORM_ID = /^\d{2}-\d{2}$/;
const DEPENDS_ON_LINE = /^[ \t]{0,50}depends_on:[ \t]{0,50}(\[[^\]]{0,500}\])[ \t]{0,50}(?:#.{0,500})?$/;
const MIN_EXAMPLES = 8;

// Every `depends_on:` example line of a body as { line, text, tokens }; tokens is [] for `depends_on: []`.
function extractDependsOnExamples(body) {
  const out = [];
  body.split('\n').forEach((line, i) => {
    const match = line.match(DEPENDS_ON_LINE);
    if (!match) return;
    const raw = match[1].trim();
    if (raw === '[]') {
      out.push({ line: i + 1, text: line, tokens: [] });
      return;
    }
    const tokens = raw.slice(1, -1).trim().split(',').map((piece) => piece.trim().replace(/^["']|["']$/g, ''));
    out.push({ line: i + 1, text: line, tokens });
  });
  return out;
}

// Every token of every example that is not a full-form plan id.
function shortFormTokens(examples) {
  const bad = [];
  for (const example of examples) {
    for (const token of example.tokens) {
      if (!FULL_FORM_ID.test(token)) bad.push({ ...example, token });
    }
  }
  return bad;
}

module.exports = {
  extractDependsOnExamples, // exported for the sample cases in tests/text-contracts.test.cjs
  shortFormTokens,
  id: 'template-phase-prompt-dependson-3427',
  issue: '#3427',
  check(ctx) {
    ctx.doc('gsd-core/templates/phase-prompt.md')
      .satisfies((text) => {
        const examples = extractDependsOnExamples(text);
        if (examples.length < MIN_EXAMPLES) return `found ${examples.length} depends_on examples, expected at least ${MIN_EXAMPLES}`;
        return examples.some((example) => example.tokens.length > 0) || 'no non-empty depends_on example';
      }, 'the template must carry depends_on examples to check (non-vacuous)')
      // A bound of the example pattern must not fail open: a `depends_on:` line it does not parse (indented, spaced or
      // listed past a bound, a YAML list item `- depends_on: ...`, or malformed) would drop out of the examples and let a
      // short-form id hide behind it. The test had the list-item gap too.
      .satisfies((text) => {
        const parsed = new Set(extractDependsOnExamples(text).map((example) => example.line));
        const unparsed = [];
        text.split('\n').forEach((line, i) => {
          const bare = line.trimStart();
          const key = (bare.startsWith('- ') ? bare.slice(2) : bare).trimStart();
          if (key.startsWith('depends_on:') && !parsed.has(i + 1)) unparsed.push(`line ${i + 1}: ${line.trim().slice(0, 80)}`);
        });
        return unparsed.length === 0 || unparsed.join('; ');
      }, 'a depends_on line that cannot be parsed by the example pattern (past a bound, or malformed) would hide short-form ids from the check')
      .satisfies((text) => {
        const bad = shortFormTokens(extractDependsOnExamples(text));
        return bad.length === 0 || bad.map((b) => `line ${b.line}: token "${b.token}" in ${b.text.trim()}`).join('; ');
      }, 'every non-empty depends_on example must list full-form plan ids (e.g. ["03-01"]), never bare short-form suffixes like ["01"]: the resolver drops those edges silently (#3427)');
  },
};

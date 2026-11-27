'use strict';

// gsd-verifier defines gsd_run in every mode (#5004): re-verification mode skips Step 1, so a resolver that lives only
// in Step 1 leaves Steps 4 and 5 with no gsd_run and the agent falls back to a disk-wide `find /`. The resolver
// include sits once, in a mode-independent preamble that precedes Step 0, not in Step 1, and no gsd_run call comes
// before it. Was tests/verifier-gsd-run-all-modes.test.cjs.

const RESOLVER_REF = 'references/gsd-run-resolver.md';

// The offset of the start of the line holding the first gsd_run call, or -1: optional indent, optional `NAME=$(`
// with an upper-case name, `gsd_run`, whitespace, a lower-case word. A linear scan, so no length of indent, name or
// gap hides a call that runs before the resolver.
function firstGsdRunCall(text) {
  // A line ends at \n, \r, U+2028 or U+2029, the line terminators a multiline `^` starts after.
  const isLineEnd = (ch) => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ';
  let lineStart = 0;
  for (;;) {
    let i = lineStart;
    while (i < text.length && !isLineEnd(text[i]) && /\s/.test(text[i])) i++; // any indent, form feed and vertical tab included
    let j = i;
    while (/[A-Z_]/.test(text[j] || '')) j++;
    if (j > i && text.startsWith('=$(', j)) i = j + 3;
    if (text.startsWith('gsd_run', i)) {
      let k = i + 'gsd_run'.length;
      const gapStart = k;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (k > gapStart && /[a-z]/.test(text[k] || '')) return lineStart;
    }
    let end = lineStart;
    while (end < text.length && !isLineEnd(text[end])) end++;
    if (end >= text.length) return -1;
    lineStart = end + 1;
  }
}

module.exports = {
  id: 'verifier-gsd-run-all-modes',
  issue: '#5004',
  check(ctx) {
    const agent = ctx.doc('agents/gsd-verifier.md')
      .has(RESOLVER_REF, 'the agent must include the shared resolver reference')
      .has('## Step 0:', 'the Step 0 heading must exist')
      .before(RESOLVER_REF, '## Step 0:', 'the resolver include must precede Step 0 (re-verification skips Step 1)')
      .satisfies((text) => {
        const count = text.split(RESOLVER_REF).length - 1;
        return count === 1 || `found ${count}`;
      }, 'there must be exactly one resolver include')
      .satisfies((text) => {
        const includeAt = text.indexOf(RESOLVER_REF);
        const firstUse = firstGsdRunCall(text);
        return firstUse > includeAt || `the first gsd_run call is at ${firstUse}, the resolver include at ${includeAt}`;
      }, 'the first gsd_run invocation must come after the resolver include');

    agent.slice('## Step 1:', '\n## ')
      .lacks(RESOLVER_REF, 'Step 1 is initial-mode only and must not be the resolver definition site');

    agent.slice('## Resolver Bootstrap', '\n## ')
      .has(RESOLVER_REF, 'the preamble must hold the resolver include')
      .has('find /', 'the preamble must name the disk-wide find it forbids')
      .has('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs', 'the preamble must require the resolver per Bash call');
  },
};

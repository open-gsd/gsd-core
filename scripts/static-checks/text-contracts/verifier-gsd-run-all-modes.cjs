'use strict';

// gsd-verifier defines gsd_run in every mode (#5004): re-verification mode skips Step 1, so a resolver that lives only
// in Step 1 leaves Steps 4 and 5 with no gsd_run and the agent falls back to a disk-wide `find /`. The resolver
// include sits once, in a mode-independent preamble that precedes Step 0, not in Step 1, and no gsd_run call comes
// before it. Was tests/verifier-gsd-run-all-modes.test.cjs.

const RESOLVER_REF = 'references/gsd-run-resolver.md';

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
        const firstUse = text.search(/^[ \t]{0,200}(?:[A-Z_]{1,60}=\$\()?gsd_run\s{1,20}[a-z]/m);
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

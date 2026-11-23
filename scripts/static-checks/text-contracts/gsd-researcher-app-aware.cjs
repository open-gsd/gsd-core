'use strict';

// Application-aware research (#1988): gsd-phase-researcher maps capabilities to architectural tiers in a Step 1.5
// between Steps 1 and 2 (a pure reasoning step, standard tiers, a Capability table); gsd-planner sanity-checks
// plans against the Architectural Responsibility Map; gsd-plan-checker has a tier verification dimension; the
// research template carries the map section with a Tier table. A step 2 marker that is missing is a finding where
// the test cut the text off at the wrong place (`substring(start, -1)`). Was tests/gsd-researcher-app-aware.test.cjs.

const ARM = 'Architectural Responsibility Map';
const TOOL_PATTERNS = ['```bash', 'node "$HOME', 'gsd-tools.cjs', 'WebSearch', 'Context7', 'mcp__'];
const TIERS = ['browser', 'frontend', 'API', 'database'];

// Where the `## Step 1.5` heading (at a line start) that names the map starts (-1 when no such heading line).
function armStepStart(text) {
  let at = text.indexOf('## Step 1.5');
  while (at !== -1) {
    const lineEnd = text.indexOf('\n', at);
    const atLineStart = at === 0 || text[at - 1] === '\n';
    if (atLineStart && text.slice(at, lineEnd === -1 ? undefined : lineEnd).includes(ARM)) return at;
    at = text.indexOf('## Step 1.5', at + 1);
  }
  return -1;
}

// The text from `start` to the next `## Step 2:` at a line start, or the reason there is none.
function untilStep2(text, start) {
  const end = text.indexOf('\n## Step 2:', start);
  return end === -1 ? { error: 'no "## Step 2:" heading after the step' } : { section: text.slice(start, end) };
}

module.exports = {
  id: 'gsd-researcher-app-aware',
  issue: '#1988',
  check(ctx) {
    ctx.doc('agents/gsd-phase-researcher.md')
      .has(ARM, 'gsd-phase-researcher.md must contain "Architectural Responsibility Map"')
      .before('## Step 1:', '## Step 1.5:', 'Step 1.5 (the Architectural Responsibility Mapping step) must come after Step 1')
      .before('## Step 1.5:', '## Step 2:', 'Step 1.5 (the Architectural Responsibility Mapping step) must come before Step 2')
      .satisfies((text) => {
        const start = armStepStart(text);
        if (start === -1) return 'no Step 1.5 heading names the Architectural Responsibility Map';
        const { error, section } = untilStep2(text, start);
        if (error) return error;
        const found = TOOL_PATTERNS.filter((pattern) => section.includes(pattern));
        return found.length === 0 || `found ${found.join(', ')}`;
      }, 'the Architectural Responsibility Mapping step must be pure reasoning (no tool calls)')
      .satisfies((text) => {
        const start = armStepStart(text);
        if (start === -1) return 'no Step 1.5 heading names the Architectural Responsibility Map';
        const { error, section } = untilStep2(text, start);
        if (error) return error;
        const found = TIERS.filter((tier) => section.toLowerCase().includes(tier.toLowerCase()));
        return found.length >= 3 || `found: ${found.join(', ')}`;
      }, 'the step must mention at least 3 standard architectural tiers')
      .satisfies((text) => {
        const start = armStepStart(text);
        if (start === -1) return 'no Step 1.5 heading names the Architectural Responsibility Map';
        const { error, section } = untilStep2(text, start);
        if (error) return error;
        return (section.includes('|') && section.includes('Capability')) || 'no table with a Capability column';
      }, 'the step must specify a table output format with a Capability column');

    ctx.doc('agents/gsd-planner.md')
      .has(ARM, 'gsd-planner.md must reference the Architectural Responsibility Map')
      .has(/sanity[ -]check/, 'gsd-planner.md must include a sanity check against the Architectural Responsibility Map');

    ctx.doc('agents/gsd-plan-checker.md')
      .has(/Architectural Responsibility Map|Architectural Tier/, 'gsd-plan-checker.md must have a verification dimension for architectural tier mapping')
      .has(/tier owner|tier mismatch|responsibility map/, 'the plan-checker verification dimension must check for tier mismatches against the responsibility map');

    ctx.doc('gsd-core/templates/research.md')
      .has(ARM, 'the research template must include an Architectural Responsibility Map section')
      .satisfies((text) => {
        const at = text.indexOf(ARM);
        if (at === -1) return 'no Architectural Responsibility Map section';
        const end = text.indexOf('\n## ', at);
        const section = text.slice(at, end !== -1 ? end : at + 500);
        return (section.includes('|') && (section.includes('Tier') || section.includes('tier'))) || 'no table with a Tier column';
      }, 'the research template section must include a table format with a Tier column');
  },
};

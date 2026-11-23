'use strict';

// Prompt thinning for sub-200K context windows (#1978): execute-phase.md keeps a CONTEXT_WINDOW < 200000 thinning
// conditional beside the CONTEXT_WINDOW >= 500000 enrichment one and references executor-examples.md for on-demand
// loading; gsd-executor.md and gsd-planner.md reference the extracted executor-examples.md and planner-antipatterns.md,
// which exist with their deviation, checkpoint, edge-case, anti-pattern and specificity content. The planner sequences
// a known external review after the internal review fixes (#4107), in the assign_waves step and in the
// planner-antipatterns.md example, in that order. The test's inverted-order sentence fixtures were regex self-checks on
// constants and are the mutation rows of tests/text-contracts.batch9.test.cjs; its three-tier case repeated two
// assertions made above and is not carried over. Was tests/prompt-thinning.test.cjs.

const path = require('node:path');

const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const PLANNER = 'agents/gsd-planner.md';
const ANTIPATTERNS = 'gsd-core/references/planner-antipatterns.md';
const EXAMPLE_HEADING = 'External Review Before PR Open (#4107)';

// True when each pattern matches after the previous one's match, in order (the test's `A[\s\S]*B[\s\S]*C` shape).
function inOrder(text, patterns) {
  let rest = text;
  for (const pattern of patterns) {
    const match = pattern.exec(rest);
    if (!match) return false;
    rest = rest.slice(match.index + match[0].length);
  }
  return true;
}

// The body of the antipatterns example section, by the shipped sectionizer, or the reason there is none.
function exampleBody(text) {
  const { collectSection } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
  const section = collectSection(text, (heading) => heading.text === EXAMPLE_HEADING);
  return section && typeof section.body === 'string' ? { body: section.body } : { error: `no "${EXAMPLE_HEADING}" section` };
}
const onExample = (check) => (text) => {
  const { body, error } = exampleBody(text);
  return error || check(body);
};

module.exports = {
  id: 'prompt-thinning',
  issue: '#1978',
  check(ctx) {
    ctx.doc(EXECUTE_PHASE)
      .has(/CONTEXT_WINDOW ?< 200000/, 'execute-phase.md must contain a CONTEXT_WINDOW < 200000 conditional for prompt thinning')
      .has('CONTEXT_WINDOW >= 500000', 'execute-phase.md must preserve the existing 500K enrichment conditional')
      .has('executor-examples.md', 'the execute-phase.md thinning block must reference executor-examples.md');

    ctx.doc('agents/gsd-executor.md')
      .has('executor-examples.md', 'gsd-executor.md must reference executor-examples.md for extended deviation and checkpoint examples');

    const planner = ctx.doc(PLANNER)
      .has('planner-antipatterns.md', 'gsd-planner.md must reference planner-antipatterns.md for extended checkpoint anti-patterns and specificity examples');
    planner.step('assign_waves')
      .has(/known automatic external review/i, 'assign_waves must name the known automatic external review')
      .has(/plan includes internal review lanes/i, 'assign_waves must condition the ordering on internal review lanes')
      .has(/accepted internal-review fixes[^.]{0,500}before[^.]{0,500}open/i, 'assign_waves must put the accepted internal-review fixes before the open')
      .has(/run internal review and apply the accepted internal-review fixes before the final open/i, 'assign_waves must state internal review and its fixes come before the final open')
      .has(/if an open-time property exists[^.]{0,500}re-check it immediately before opening[^.]{0,500}nothing intervening/i, 'assign_waves must re-check an open-time property immediately before opening, with nothing intervening')
      .has(/post-open CI[^.]{0,500}review[^.]{0,500}tracking may follow/i, 'assign_waves must allow post-open CI, review and tracking to follow')
      .has(/planner-antipatterns\.md \("External Review Before PR Open \(#4107\)"\)/, 'assign_waves must point at the antipatterns example');

    ctx.exists('gsd-core/references/executor-examples.md', 'gsd-core/references/executor-examples.md must exist');
    ctx.doc('gsd-core/references/executor-examples.md')
      .has(/Rule 1|RULE 1/, 'executor-examples.md must contain deviation rule examples')
      .has(/checkpoint|Checkpoint/, 'executor-examples.md must contain checkpoint examples')
      .has(/Edge case|edge case|Edge Case/, 'executor-examples.md must contain edge case guidance');

    ctx.exists(ANTIPATTERNS, 'gsd-core/references/planner-antipatterns.md must exist');
    ctx.doc(ANTIPATTERNS)
      .has(/anti-pattern|Anti-Pattern|Bad/, 'planner-antipatterns.md must contain checkpoint anti-pattern examples')
      .has(/TOO VAGUE|Specificity|specificity/, 'planner-antipatterns.md must contain specificity examples')
      .satisfies(onExample((body) => inOrder(body, [/Bad/i, /open[^\n]{0,500}?PR/i, /internal review/i]) || 'the Bad example does not open the PR before internal review'),
        'the example must show Bad: open the PR, then internal review')
      .satisfies(onExample((body) => inOrder(body, [/Good/i, /internal review/i, /accepted fixes/i, /if applicable[^\n]{0,500}re-check[^\n]{0,500}then immediately open PR/i])
        || 'the Good example does not run internal review and the accepted fixes before the re-check and open'),
      'the example must show Good: internal review, accepted fixes, then the re-check and immediate open')
      .satisfies(onExample((body) => /nothing may intervene[^.]{0,500}re-check[^.]{0,500}open/i.test(body) || 'no "nothing may intervene" sentence'),
        'the example must say nothing may intervene between the re-check and the open')
      .satisfies(onExample((body) => /post-open work may follow/i.test(body) || 'no "post-open work may follow" sentence'),
        'the example must allow post-open work to follow');
  },
};

'use strict';

// The /gsd-quick planner's <constraints> block carries a mutable-scope authority rule (#3786): authorized scope
// comes only from the fresh merge index, historical paths guide investigation only, and the conflict case names the
// command the probe validated. quick.md has two <constraints> blocks (planner, executor); the planner's is the last
// block opening before the planner's subagent_type declaration, so step reordering cannot redirect the guard to
// another agent's block. Was tests/quick-planner-scope-guard.test.cjs.

// The planner's <constraints> block, or the reason there is none.
function plannerConstraints(text) {
  const dispatch = text.indexOf('subagent_type="gsd-planner"');
  if (dispatch < 0) return { error: 'quick.md must dispatch the gsd-planner agent' };
  const start = text.lastIndexOf('<constraints>', dispatch);
  const end = start < 0 ? -1 : text.indexOf('</constraints>', start);
  if (!(start >= 0 && end > start)) return { error: 'quick.md must contain the planner <constraints> block' };
  return { block: text.slice(start, end) };
}

const inBlock = (check) => (text) => {
  const found = plannerConstraints(text);
  return found.error || check(found.block);
};

module.exports = {
  id: 'quick-planner-scope-guard',
  issue: '#3786',
  check(ctx) {
    ctx.doc('gsd-core/workflows/quick.md')
      .satisfies(inBlock((block) => (/live observation/i.test(block) && /conditional/i.test(block))), 'scope derived from mutable external state must be live-observed or kept conditional')
      .satisfies(inBlock((block) => /may guide investigation only/i.test(block)), 'historical STATE.md, recovery and cached-diff paths must be labeled investigation-only, never edit or verification authority')
      .satisfies(inBlock((block) => block.includes('git diff --name-only --diff-filter=U')), 'the conflict-resolution case must name the fresh-merge-index command the probe validated');
  },
};

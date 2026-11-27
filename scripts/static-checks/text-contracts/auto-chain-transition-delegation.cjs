'use strict';

// Auto-chain completion delegates post-processing to the transition workflow (#1526): execute-phase @-includes
// transition.md inside a delegate_post_completion_to_transition step that names post-completion mode and the skip set
// (verify_completion, update_roadmap_and_state) and starts at evolve_project; the lighter standalone
// update_project_md step is gone; transition.md declares the post_completion_mode step with the exact skip set and
// still documents standalone mode. Was tests/auto-chain-transition-delegation.test.cjs.

const DELEGATE = 'delegate_post_completion_to_transition';
const INCLUDE = '@~/.claude/gsd-core/workflows/transition.md';

module.exports = {
  id: 'auto-chain-transition-delegation',
  issue: '#1526',
  check(ctx) {
    const exec = ctx.doc('gsd-core/workflows/execute-phase.md')
      .has(DELEGATE, 'execute-phase must have a delegation step')
      .has(INCLUDE, 'execute-phase must @-include transition.md')
      .before(DELEGATE, INCLUDE, 'the transition include must be inside the delegation step')
      .lacks('<step name="update_project_md"', 'the standalone update_project_md step must be removed (delegated to transition.evolve_project)');
    exec.slice(`<step name="${DELEGATE}`, '</step>')
      .has(/post-completion mode/i, 'the delegation step must name post-completion mode')
      .has(/verify_completion/, 'the delegation step must reference the verify step to skip')
      .has(/update_roadmap_and_state/, 'the delegation step must reference the roadmap/state step to skip')
      .has(/evolve_project/, 'the delegation step must name evolve_project as the delegation start');

    ctx.doc('gsd-core/workflows/transition.md')
      .slice('<step name="post_completion_mode"', '</step>')
      .has(/SKIP\s{1,20}`verify_completion`\s{1,20}and\s{1,20}`update_roadmap_and_state`/i, 'the mode must name the exact skip set')
      .has(/evolve_project/, 'the mode must begin at evolve_project')
      .has(/Standalone transition/i, 'standalone (mode 1) must still be documented');
  },
};

'use strict';

// execute-phase's handle_branching warns when local is ahead of origin (#2639): it counts commits ahead with
// `git rev-list --count` before the `git checkout -b` fork, and the warning says the local commits are ahead or
// unpushed, so the user knows they will be missing from the phase branch. Was
// tests/execute-phase-branch-base-ahead-warning.test.cjs.

module.exports = {
  id: 'execute-phase-branch-base-ahead-warning',
  issue: '#2639',
  check(ctx) {
    ctx.doc('gsd-core/workflows/execute-phase.md')
      .has(/rev-list[^\n]{0,500}--count[^\n]{0,500}DEFAULT_BRANCH/i, 'handle_branching must check if local $DEFAULT_BRANCH is ahead of origin before forking (git rev-list --count): unpushed local commits are otherwise silently missing from the phase branch')
      .has(/ahead[^\n]{0,500}origin[^\n]{0,500}DEFAULT_BRANCH|unpushed/i, 'handle_branching must warn that local commits are ahead/unpushed when forking from origin');
  },
};

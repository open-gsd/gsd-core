'use strict';

// /gsd-code-review dispatches --fix (#3727): the code-review.md initialize step names code-review-flags.cjs to parse the
// --fix, --all and --auto flags, the host gates a dispatch-fix section on flag:--fix that points at the dispatch-fix.md
// step file, and that file holds the dispatch_fix step, which delegates to code-review-fix.md (which spawns
// gsd-code-fixer; the test's `gsd-code-fixer || code-review-fix.md` alternative was implied by the workflow reference). The flag-parsing and workflow-dispatch behaviour of code-review-flags.cjs stays in the test of this
// name: its subject is code. Was the structural half of tests/code-review-flags.test.cjs.

const WORKFLOW = 'gsd-core/workflows/code-review.md';
const DISPATCH_FIX = 'gsd-core/workflows/code-review/steps/dispatch-fix.md';
const INITIALIZE = '<step name="initialize">';

module.exports = {
  id: 'code-review-flags',
  issue: '#3727',
  check(ctx) {
    ctx.doc(WORKFLOW)
      .satisfies((text) => {
        const start = text.indexOf(INITIALIZE);
        if (start === -1) return 'the workflow has no initialize step';
        // The step ends at the first closing tag after it; with none, the section runs to the last character (as the test read it).
        const end = text.indexOf('</step>', start);
        return text.slice(start, end).includes('code-review-flags.cjs') || 'the initialize step does not name it';
      }, 'the initialize step must reference code-review-flags.cjs to parse the --fix/--all/--auto flags')
      .has('<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->', 'code-review.md must gate a dispatch-fix section on flag:--fix (missing: --fix is silently a no-op)')
      .has('gsd-core/workflows/code-review/steps/dispatch-fix.md', 'the gated dispatch-fix section must point at the dispatch-fix.md step file');

    ctx.doc(DISPATCH_FIX)
      .has('<step name="dispatch_fix">', 'the dispatch-fix.md step file must contain the dispatch_fix step')
      .has('code-review-fix.md', 'the dispatch_fix step must reference the code-review-fix.md workflow (which spawns gsd-code-fixer)');
  },
};

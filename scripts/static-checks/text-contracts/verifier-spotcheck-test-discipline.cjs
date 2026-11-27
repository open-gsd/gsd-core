'use strict';

// gsd-verifier Step 7b must not present the runner-specific full-suite `| grep` anti-pattern, and must steer toward
// enumerate-for-existence and single-named-test-for-pass (#25); the assertions are scoped to the Step 7b section.
// Was tests/verifier-spotcheck-test-discipline.test.cjs.

module.exports = {
  id: 'verifier-spotcheck-test-discipline',
  issue: '#25',
  check(ctx) {
    ctx.doc('agents/gsd-verifier.md')
      .slice('## Step 7b', '## Step 7c')
      .lacks('npm test -- --grep "$PHASE_TEST_PATTERN" 2>&1 | grep -q "passing"', 'the runner-specific `npm test --grep` example must stay removed (it mis-generalizes to `<full-suite> | grep`)')
      .has(/cargo test -- --list/, 'Step 7b should show the correct `cargo test -- --list` enumeration form')
      .has(/pytest --collect-only/, 'Step 7b should list pytest enumeration')
      .has(/vitest list/, 'Step 7b should list vitest enumeration')
      .has(/go test -list/, 'Step 7b should list go enumeration')
      .has(/-- --exact/, 'Step 7b should show the cargo single-named-test form')
      .has(/pytest -k/, 'Step 7b should show the pytest single-named-test form')
      .has(/vitest run -t/, 'Step 7b should show the vitest single-named-test form')
      .has(/at most once per verification/i, 'Step 7b should forbid invoking the full workspace test command more than once per verification')
      .has(/grep/i, 'Step 7b should call out the full-suite grep anti-pattern')
      .has(/per must-have|per truth/i, 'Step 7b should say the anti-pattern is per must-have');
  },
};

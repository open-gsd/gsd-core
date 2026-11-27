'use strict';

// docs-required.yml and changeset-required.yml check out with `fetch-depth: 50`, never `fetch-depth: 0`, and keep
// an explicit "Fetch base ref for diff" step. Both run a lint script that takes a three-dot git diff
// (`git diff --name-only origin/${base}...HEAD`): a full-history clone is wasteful, depth 50 covers nearly every PR,
// and the explicit base-ref fetch puts the merge-base in place (the workflow fails closed when it is deeper).
// security-scan.yml legitimately uses fetch-depth: 0 and is not covered. Was tests/policy-lint-shallow-checkout.test.cjs.

const WORKFLOWS = ['docs-required.yml', 'changeset-required.yml'];

module.exports = {
  id: 'policy-lint-shallow-checkout',
  check(ctx) {
    for (const name of WORKFLOWS) {
      ctx.doc(`.github/workflows/${name}`)
        .has('fetch-depth: 50', `${name}: checkout must use fetch-depth: 50 (a full-history clone with fetch-depth: 0, or none, is wrong)`)
        .lacks('fetch-depth: 0', `${name}: fetch-depth: 0 (full-history clone) must be replaced with fetch-depth: 50`)
        .has('Fetch base ref for diff', `${name}: must have an explicit "Fetch base ref for diff" step so the three-dot diff has its merge-base`);
    }
  },
};

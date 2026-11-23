'use strict';

// gsd-planner carries a reachability_check step between derive_must_haves and estimate_scope, with creation-path
// verification and an UNREACHABLE marker, and the file stays under the 50000-character limit. The original accepted
// `creation path`, `creation_path` or `reachable` for the verification logic; the real file carries `creation path`,
// which is what the contract asks for (`reachable` would be satisfied by an unrelated line). Was
// tests/reachability-check.test.cjs.

const SIZE_LIMIT = 50000;

module.exports = {
  id: 'reachability-check',
  check(ctx) {
    ctx.doc('agents/gsd-planner.md')
      .has('<step name="reachability_check">', 'missing the reachability_check step')
      .before('derive_must_haves', 'reachability_check', 'the reachability_check step must come after derive_must_haves')
      .before('reachability_check', 'estimate_scope', 'the reachability_check step must come before estimate_scope')
      .has('creation path', 'missing creation path verification logic')
      .has('UNREACHABLE', 'missing the UNREACHABLE marker for failed checks')
      .shorterThan(SIZE_LIMIT, `the file must stay under the ${SIZE_LIMIT} character limit`);
  },
};

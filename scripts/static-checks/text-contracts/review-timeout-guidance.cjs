'use strict';

// review.md's invoke_reviewers step gives the prompt-fed reviewers explicit Bash timeout guidance (#2194): without
// it each lane inherits the host default and a source-grounded review is killed mid-review with empty output.
// The step says lanes run sequentially, recommends a high millisecond value, and frames a slow-lane empty output as
// a timeout, not a crash. Was tests/review-timeout-guidance.test.cjs.

module.exports = {
  id: 'review-timeout-guidance',
  issue: '#2194',
  check(ctx) {
    ctx.doc('gsd-core/workflows/review.md')
      .step('invoke_reviewers')
      .has(/sequential|in sequence|not in parallel/i, 'the step must state that lanes run sequentially')
      .has(/timeout/i, 'the reviewer blocks must carry Bash timeout guidance')
      .has(/900000|1200000/, 'timeout guidance must recommend a high ms value (>= 900000) so a slow lane is not killed')
      .has(/timeout[^\n]{1,500}not[^\n]{1,500}crash|not a crash/i, 'the guidance must distinguish a timeout kill from a crash so operators do not misdiagnose it');
  },
};

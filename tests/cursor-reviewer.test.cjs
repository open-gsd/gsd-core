'use strict';

// The text of the Cursor CLI reviewer in /gsd-review (review.md, the command file, help, COMMANDS.md, FEATURES.md and
// their ja-JP and ko-KR mirrors) is the `cursor-reviewer` text contract (scripts/static-checks/text-contracts/
// cursor-reviewer.cjs, run by lint:ci). These cases stay a test because their subject is product code: the lane
// descriptor and the invocation plan the review-lane modules resolve for the cursor lane (#1960, Phase 5b #2799).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

const cursorLane = () => REVIEWER_LANES.find((l) => l.slug === 'cursor');

describe('Cursor CLI reviewer lane (#1960)', () => {
  test('invocation uses the cursor-agent single binary, not two-token "cursor agent"', () => {
    const lane = cursorLane();
    assert.equal(lane.invoke.binary, 'cursor-agent');
    assert.ok(lane.invoke.args.includes('-p'));
  });

  test('invocation includes --output-format text', () => {
    const lane = cursorLane();
    const i = lane.invoke.args.indexOf('--output-format');
    assert.ok(i !== -1);
    assert.equal(lane.invoke.args[i + 1], 'text');
  });

  test('the prompt is a file-path ARGUMENT, never piped on stdin', () => {
    // Print mode takes the prompt as an argument, and a full plan set inline would approach the
    // 32,767-char Windows execFileSync ceiling, hence the file reference.
    const lane = cursorLane();
    assert.equal(lane.invoke.promptChannel, 'argv-file-ref');
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/rd', repoRoot: '/repo' });
    assert.equal(r.ok, true);
    assert.equal(r.plan.stdin, null, 'nothing may be fed on stdin');
    assert.ok(r.plan.argv[r.plan.argv.length - 1].includes('/rd/gsd-review-prompt.md'));
  });

  test('the lane declares its REVIEWS.md section', () => {
    // Phase 5b renders sections from each lane's declared `reviewsSection`, and uniqueness across lanes is
    // enforced by the parity gate (ADR-2782 D8).
    assert.equal(cursorLane().reviewsSection, 'Cursor');
    const sections = REVIEWER_LANES.map((l) => l.reviewsSection);
    assert.equal(
      sections.filter((x) => x === 'Cursor').length, 1,
      'two lanes sharing a heading would silently merge their output in REVIEWS.md',
    );
  });
});

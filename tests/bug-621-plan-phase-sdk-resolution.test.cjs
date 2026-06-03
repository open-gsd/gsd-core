// allow-test-rule: source-text-is-the-product
// plan-phase.md workflow text IS what the runtime loads and the agent executes,
// so asserting on its bash invocations tests the deployed contract directly.
// Regression guard for #621: the §13e post-planning-gaps gap-analysis step must
// invoke gsd-tools through the resolved `gsd_run` launcher (defined once in the
// canonical preamble), NOT a hardcoded "$HOME/.claude/.../gsd-tools.cjs" path —
// which misses a working global install when no project-local runtime exists.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');

// The #621 bug form: a direct `node "$HOME/.../gsd-tools.cjs" <cmd>` invocation.
// This is deliberately distinct from the canonical launcher preamble, which
// references $HOME only inside a `[ -f "$HOME/..." ]` probe / `GSD_TOOLS=` assignment
// and always invokes the tool as `node "$GSD_TOOLS"` (the resolved variable) — so the
// preamble never matches this pattern and is not a false positive.
const HARDCODED_HOME_INVOCATION = /node\s+"\$HOME\/[^"]*gsd-tools\.cjs"/;

describe('bug #621: plan-phase post-planning-gaps SDK resolution', () => {
  const content = fs.readFileSync(PLAN_PHASE, 'utf8');

  test('no hardcoded "node \\"$HOME/.../gsd-tools.cjs\\"" invocation survives anywhere in plan-phase.md', () => {
    const offending = content
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => HARDCODED_HOME_INVOCATION.test(line))
      .map((o) => o.n);
    assert.deepEqual(
      offending,
      [],
      `plan-phase.md must invoke gsd-tools via the resolved gsd_run launcher, not a hardcoded $HOME path. Offending line(s): ${offending.join(', ') || '(none)'}`,
    );
  });

  test('post-planning-gaps gap-analysis is invoked via the gsd_run launcher', () => {
    const gapLine = content
      .split(/\r?\n/)
      .find((line) => /\bgap-analysis --phase-dir\b/.test(line));
    assert.ok(gapLine, 'expected a gap-analysis --phase-dir invocation in plan-phase.md');
    assert.match(gapLine, /gsd_run gap-analysis --phase-dir/, 'gap-analysis must be invoked via the resolved gsd_run launcher');
    assert.doesNotMatch(gapLine, HARDCODED_HOME_INVOCATION, 'gap-analysis line must not hardcode a $HOME gsd-tools path');
  });
});

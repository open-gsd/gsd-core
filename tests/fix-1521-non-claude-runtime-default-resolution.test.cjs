'use strict';
/**
 * Regression tests for #1521: every non-Claude runtime stamps its own runtime
 * identity + workflow.use_worktrees=false into emitted workflows.
 *
 * GSD's worktree isolation relies on Claude Code's isolation="worktree" spawn
 * parameter, which no other runtime honors. #1519 (Codex-only fix) is
 * generalized here to ALL non-Claude runtimes.
 *
 * All tests assert on the SUT's RETURN VALUE (engine output), not raw file reads,
 * except the parity integration test which carries the allow-test-rule exemption.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// #1521: use the canonical list from the conversion module rather than a hand-rolled
// local array that can drift from the real runtime set.
const { NON_CLAUDE_RUNTIMES: NON_CLAUDE } = conversion;
const WORKFLOWS = [
  'execute-phase.md', 'autonomous.md', 'manager.md', 'diagnose-issues.md', 'quick.md',
];

const CLAUDE_RUNTIME_LINE = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
const TRUE_WT_LINE = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
const FALSE_WT_LINE = 'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"';

// ---------------------------------------------------------------------------
// Parity across ALL non-Claude runtimes × all 5 workflows
// ---------------------------------------------------------------------------

test('parity: every non-Claude runtime stamps its own runtime default and use_worktrees=false on all workflows (#1521)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1521)
  for (const rt of NON_CLAUDE) {
    for (const wf of WORKFLOWS) {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
        'utf8',
      );
      const out = conversion._applyRuntimeRewrites(src, rt, `$HOME/.${rt}/`, true, undefined);

      // No un-stamped claude runtime line may survive
      assert.ok(
        !out.includes(CLAUDE_RUNTIME_LINE),
        `${rt}/${wf}: residual un-stamped claude runtime read — _stampNonClaudeRuntimeDefaults not applied`,
      );

      // No un-stamped use_worktrees=true line may survive
      assert.ok(
        !out.includes(TRUE_WT_LINE),
        `${rt}/${wf}: residual un-stamped use_worktrees=true read — _stampNonClaudeRuntimeDefaults not applied`,
      );

      // If the source had a runtime read, the output must have --default <rt>
      if (src.includes(CLAUDE_RUNTIME_LINE)) {
        assert.ok(
          out.includes(`config-get runtime --default ${rt} --raw 2>/dev/null || echo "${rt}"`),
          `${rt}/${wf}: runtime line not stamped to --default ${rt}`,
        );
      }

      // If the source had a use_worktrees read, the output must have --default false
      if (src.includes(TRUE_WT_LINE)) {
        assert.ok(
          out.includes(FALSE_WT_LINE),
          `${rt}/${wf}: use_worktrees line not defaulted to false`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Claude unchanged — no stamping for the native runtime
// ---------------------------------------------------------------------------

test('claude runtime leaves runtime default and use_worktrees=true unchanged (#1521)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'),
    'utf8',
  );
  const out = conversion._applyRuntimeRewrites(src, 'claude', '$HOME/.claude/', true, undefined);

  // Claude emit must preserve the original --default claude line
  if (src.includes(CLAUDE_RUNTIME_LINE)) {
    assert.ok(
      out.includes(CLAUDE_RUNTIME_LINE),
      `claude/execute-phase.md: expected original claude runtime line to survive; got mutated`,
    );
  }

  // Claude emit must NOT gain --default false for use_worktrees
  assert.ok(
    !out.includes(FALSE_WT_LINE),
    `claude/execute-phase.md: use_worktrees line must NOT be stamped false for claude runtime`,
  );
});

// ---------------------------------------------------------------------------
// fc property — identity: each runtime stamps itself, claude stays unchanged
// ---------------------------------------------------------------------------

test('property: _stampNonClaudeRuntimeDefaults stamps each non-claude runtime and leaves claude unchanged (#1521)', () => {
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  fc.assert(
    fc.property(fc.constantFrom(...NON_CLAUDE, 'claude'), (rt) => {
      const out = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
      if (rt === 'claude') {
        return out.includes('--default claude') && !/--default (?!claude)/.test(out);
      }
      return out.includes(`--default ${rt}`) && !out.includes('--default claude');
    }),
  );
});

// ---------------------------------------------------------------------------
// fc property — idempotence: stamping twice equals once
// ---------------------------------------------------------------------------

test('property: _stampNonClaudeRuntimeDefaults is idempotent (#1521)', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...NON_CLAUDE),
      fc.constantFrom('runtime', 'use_worktrees'),
      (rt, which) => {
        const line =
          which === 'runtime'
            ? 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n'
            : 'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
        const once = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
        const twice = conversion._applyRuntimeRewrites(once, rt, `$HOME/.${rt}/`, true, undefined);
        return once === twice;
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Guard generalization: execute-phase.md uses != "claude" not = "codex"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Guard generalization: execute-phase.md, quick.md, and diagnose-issues.md
// all use != "claude" (not = "codex") for the worktree guard (#1521)
// ---------------------------------------------------------------------------

test('execute-phase.md, quick.md, and diagnose-issues.md guards are generalized to != "claude" (not Codex-specific) (#1521)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1521)
  const GUARD_WORKFLOWS = ['execute-phase.md', 'quick.md', 'diagnose-issues.md'];
  for (const wf of GUARD_WORKFLOWS) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', wf),
      'utf8',
    );
    assert.ok(
      src.includes('[ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: expected generalized guard [ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]`,
    );
    assert.ok(
      !src.includes('[ "$RUNTIME" = "codex" ] && [ "$USE_WORKTREES" != "false" ]'),
      `${wf}: found Codex-specific guard — should have been generalized to != "claude"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Orchestration gating: manager.md + autonomous.md gate background dispatch on
// the typed FLATTEN query. #1708 (ADR-1239 Phase B) graduated #1521's
// codex-specific check to a documentation-sourced shouldFlattenDispatch — the
// prose now branches on `FLATTEN` (false = background), not a runtime name.
// ---------------------------------------------------------------------------

test('manager.md and autonomous.md gate run_in_background on FLATTEN=false, not a runtime name (#1521, graduated by #1708)', () => {
  // allow-test-rule: orchestration dispatch gating in manager/autonomous .md is the runtime contract surface (#1521/#1708)
  const manager = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md'),
    'utf8',
  );
  const autonomous = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md'),
    'utf8',
  );

  // Both files must gate run_in_background on the typed FLATTEN decision (not a runtime name)
  assert.ok(
    /If `FLATTEN` is `false`[\s\S]{0,500}?run_in_background=true/.test(manager),
    'manager.md: expected run_in_background dispatch gated on FLATTEN=false (typed dispatch-should-flatten query)',
  );
  assert.ok(
    /If `FLATTEN` is `false`[\s\S]{0,1200}?run_in_background=true/.test(autonomous),
    'autonomous.md: expected run_in_background dispatch gated on FLATTEN=false (typed dispatch-should-flatten query)',
  );

  // Inline is the else branch, keyed on FLATTEN — never a runtime name
  assert.ok(
    /Otherwise[\s\S]{0,250}?inline/i.test(manager),
    'manager.md: expected "Otherwise ... inline" branch keyed on FLATTEN',
  );
  assert.ok(
    /Otherwise[\s\S]{0,250}?inline/i.test(autonomous),
    'autonomous.md: expected "Otherwise ... inline" branch keyed on FLATTEN',
  );
  // And the old runtime-name gating must be gone (no `RUNTIME` is `codex` dispatch gate)
  assert.ok(
    !/`RUNTIME` is `codex`[\s\S]{0,500}?run_in_background=true/.test(manager),
    'manager.md: must no longer gate run_in_background on the runtime name',
  );
});

test('manager.md and autonomous.md no longer contain old "not claude" background-dispatch gating (#1521)', () => {
  // allow-test-rule: orchestration dispatch gating in manager/autonomous .md is the runtime contract surface (#1521)
  const manager = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md'),
    'utf8',
  );
  const autonomous = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md'),
    'utf8',
  );

  // The old phrasing that unconditionally sent every non-claude runtime to background must be gone
  assert.ok(
    !manager.includes('If `RUNTIME` is not `claude` (e.g. Codex)'),
    'manager.md: old "If `RUNTIME` is not `claude` (e.g. Codex)" gating must be replaced',
  );
  assert.ok(
    !autonomous.includes('On other runtimes:'),
    'autonomous.md: old "On other runtimes:" branch label must be replaced',
  );
});

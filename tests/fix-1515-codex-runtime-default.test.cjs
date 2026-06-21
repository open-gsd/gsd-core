'use strict';
/**
 * Regression tests for bug #1515: Codex install with runtime-neutral
 * .planning/config.json resolves runtime as 'claude' and enables worktree
 * isolation (unsafe for Codex).
 *
 * Root causes:
 *   A) config-get reads in workflows lacked --raw → output JSON-quoted →
 *      every comparison like [ "$RUNTIME" = "codex" ] failed silently.
 *   B) The conversion engine emitted --default claude for every runtime →
 *      neutral Codex config fell back to claude default.
 *
 * All tests assert on the SUT's RETURN VALUE (engine output), not raw file reads,
 * except the integration test (test 4) which is explicitly the source↔engine
 * parity guard and carries the allow-test-rule exemption.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// ---------------------------------------------------------------------------
// Unit tests: engine stamps codex-specific defaults into emitted workflows
// ---------------------------------------------------------------------------

test('codex emit stamps its own runtime default into the runtime-resolution line', () => {
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  const out = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
  assert.ok(
    out.includes('config-get runtime --default codex --raw'),
    `Expected 'config-get runtime --default codex --raw' in output; got:\n${out}`,
  );
  assert.ok(
    out.includes('|| echo "codex")'),
    `Expected '|| echo "codex")' in output; got:\n${out}`,
  );
  assert.ok(
    !out.includes('--default claude'),
    `Expected '--default claude' to be fully rewritten; got:\n${out}`,
  );
  assert.ok(
    !out.includes('echo "claude"'),
    `Expected 'echo "claude"' to be fully rewritten; got:\n${out}`,
  );
});

test('codex emit defaults workflow.use_worktrees to false', () => {
  const line =
    'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
  const out = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
  assert.ok(
    out.includes('config-get workflow.use_worktrees --default false --raw'),
    `Expected 'config-get workflow.use_worktrees --default false --raw' in output; got:\n${out}`,
  );
  assert.ok(
    out.includes('|| echo "false")'),
    `Expected '|| echo "false")' in output; got:\n${out}`,
  );
  assert.ok(
    !out.includes('|| echo "true")'),
    `Expected '|| echo "true")' to be fully rewritten; got:\n${out}`,
  );
});

test('non-codex runtime (cursor) does NOT rewrite the runtime default — stamping is codex-scoped', () => {
  const line =
    'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  const out = conversion._applyRuntimeRewrites(line, 'cursor', '/home/u/.cursor/', true, undefined);
  assert.ok(
    out.includes('--default claude --raw'),
    `Expected cursor output to preserve '--default claude --raw'; got:\n${out}`,
  );
  assert.ok(
    !out.includes('--default codex'),
    `Expected cursor output NOT to contain '--default codex'; got:\n${out}`,
  );
});

// ---------------------------------------------------------------------------
// Integration / parity guard: real source ↔ engine output for codex (all surfaces)
// ---------------------------------------------------------------------------

test('regression: every edited workflow gets codex-stamped (source↔engine parity, all surfaces) (#1515)', () => {
  // allow-test-rule: emitted workflow runtime-resolution shell block is the runtime contract surface (#1515) — asserts on engine-transformed output of the real source
  const WORKFLOWS = ['execute-phase.md', 'autonomous.md', 'manager.md', 'diagnose-issues.md', 'quick.md'];
  const CLAUDE_RUNTIME = 'config-get runtime --default claude --raw 2>/dev/null || echo "claude"';
  const CODEX_RUNTIME = 'config-get runtime --default codex --raw 2>/dev/null || echo "codex"';
  const TRUE_WT = 'config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"';
  const FALSE_WT = 'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"';
  for (const wf of WORKFLOWS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', wf), 'utf8');
    const out = conversion._applyRuntimeRewrites(src, 'codex', '$HOME/.codex/', true, undefined);
    // No un-stamped claude/true resolution line may survive codex emit on ANY surface.
    assert.ok(!out.includes(CLAUDE_RUNTIME), `${wf}: residual un-stamped runtime read — engine regex no longer matches source line (parity drift)`);
    assert.ok(!out.includes(TRUE_WT), `${wf}: residual un-stamped use_worktrees read — parity drift`);
    // If the source HAS such a read, the codex form must be present.
    if (src.includes(CLAUDE_RUNTIME)) assert.ok(out.includes(CODEX_RUNTIME), `${wf}: runtime read not stamped to codex`);
    if (src.includes(TRUE_WT)) assert.ok(out.includes(FALSE_WT), `${wf}: use_worktrees read not defaulted to false`);
  }
});

// ---------------------------------------------------------------------------
// Property tests (RULESET.TESTS.property-based-testing)
// ---------------------------------------------------------------------------

test('property: runtime stamping applies iff runtime is codex (#1515)', () => {
  const RUNTIMES = ['claude','codex','cursor','cline','windsurf','augment','trae','qwen','hermes','gemini','opencode','kilo','copilot','antigravity','codebuddy'];
  const line = 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n';
  fc.assert(fc.property(fc.constantFrom(...RUNTIMES), (rt) => {
    const out = conversion._applyRuntimeRewrites(line, rt, `$HOME/.${rt}/`, true, undefined);
    return rt === 'codex'
      ? out.includes('--default codex --raw') && !out.includes('--default claude')
      : out.includes('--default claude --raw') && !out.includes('--default codex');
  }));
});

test('property: codex stamping is idempotent on resolution lines (#1515)', () => {
  fc.assert(fc.property(fc.constantFrom('runtime', 'use_worktrees'), (which) => {
    const line = which === 'runtime'
      ? 'RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")\n'
      : 'USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")\n';
    const once = conversion._applyRuntimeRewrites(line, 'codex', '$HOME/.codex/', true, undefined);
    const twice = conversion._applyRuntimeRewrites(once, 'codex', '$HOME/.codex/', true, undefined);
    return once === twice;
  }));
});

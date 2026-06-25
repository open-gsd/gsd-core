'use strict';
/**
 * Regression guard — bug(#853): /gsd-manager and /gsd-autonomous --interactive
 * silently skipped worktree isolation + independent verification because they
 * dispatched Plan/Execute via Agent(run_in_background=true). On Claude Code a
 * backgrounded agent has no Agent/Task tool, so it cannot spawn the nested
 * subagents (worktree executors, plan-checker, verifier). The workflows must
 * now resolve dispatch capability from the registry (#1708) and run inline
 * everywhere except runtimes where dispatch.background && dispatch.backgroundDispatch
 * are both true (currently: codex, cursor).
 *
 * Phase B (#1708): the prose `RUNTIME === 'codex'` rule is graduated to a typed
 * `gsd_run query dispatch-should-flatten` query backed by shouldFlattenDispatch()
 * from host-integration.cjs and the documentation-sourced capability registry.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup: cleanupDir, runGsdTools } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
// allow-test-rule: source-text-is-the-product (see #1708)
const MANAGER = fs.readFileSync(path.join(WORKFLOWS_DIR, 'manager.md'), 'utf8');
// allow-test-rule: source-text-is-the-product (see #1708)
const AUTONOMOUS = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf8');

describe('bug-853 — manager/autonomous gate background dispatch by runtime', () => {
  test('manager.md resolves dispatch-should-flatten before dispatching plan/execute', () => {
    // Two dispatch sites (plan + execute), each must use dispatch-should-flatten.
    // allow-test-rule: source-text-is-the-product (see #1708)
    const matches = MANAGER.match(/dispatch-should-flatten/g) || [];
    assert.ok(matches.length >= 2, 'manager.md must use dispatch-should-flatten for both plan and execute dispatch');
  });

  test('manager.md documents why most runtimes cannot background-dispatch', () => {
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(MANAGER, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('manager.md gates background dispatch on FLATTEN=false and runs plan/execute inline otherwise', () => {
    // Background path uses FLATTEN is false
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(MANAGER, /If `FLATTEN` is `false`[\s\S]{0,400}?run_in_background=true/);
    // Inline is the default/else branch for plan — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      MANAGER,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the default/else branch for execute — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      MANAGER,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });

  test('manager.md compound action preamble uses FLATTEN language (not hardcoded runtime names)', () => {
    // allow-test-rule: source-text-is-the-product (see #1708)
    const compoundActionSection = MANAGER.match(
      /### Compound Action \(background \+ inline\)[\s\S]*?Inline verification:/,
    );
    assert.ok(compoundActionSection, 'manager.md must document compound action runtime dispatch');

    // Must gate on FLATTEN being false (not runtime name)
    assert.match(
      compoundActionSection[0],
      /If `FLATTEN` is `false`[\s\S]{0,400}?Spawn all background agents first[\s\S]{0,300}?plan\/execute/,
    );
    // Otherwise / inline branch must reference FLATTEN being true
    assert.match(
      compoundActionSection[0],
      /Otherwise[\s\S]{0,260}?`FLATTEN`[\s\S]{0,260}?`true`[\s\S]{0,260}?inline/,
    );
    // Must NOT still hardcode "On Codex:" in this section
    assert.doesNotMatch(
      compoundActionSection[0],
      /\*\*On Codex:\*\*/,
    );
    // Must NOT still hardcode "On Claude Code or any other non-Codex runtime:"
    assert.doesNotMatch(
      compoundActionSection[0],
      /On Claude Code or any other non-Codex runtime:/,
    );
  });

  test('autonomous.md gates interactive background dispatch using dispatch-should-flatten', () => {
    // Two dispatch sites (3b plan + 3c execute), each must use dispatch-should-flatten.
    // allow-test-rule: source-text-is-the-product (see #1708)
    const autoFlattenMatches = AUTONOMOUS.match(/dispatch-should-flatten/g) || [];
    assert.ok(autoFlattenMatches.length >= 2, 'autonomous.md must use dispatch-should-flatten in both 3b (plan) and 3c (execute) interactive branches');
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    assert.match(AUTONOMOUS, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('autonomous.md gates interactive background dispatch on FLATTEN=false; runs plan/execute inline otherwise', () => {
    // Background block: run_in_background=true appears within the FLATTEN=false branch and gsd-plan-phase is nearby
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(AUTONOMOUS, /If `FLATTEN` is `false`[\s\S]{0,1200}?run_in_background=true[\s\S]{0,600}?gsd-plan-phase/);
    // Background block: run_in_background=true appears within the FLATTEN=false branch and gsd-execute-phase is nearby
    assert.match(AUTONOMOUS, /If `FLATTEN` is `false`[\s\S]{0,3000}?run_in_background=true[\s\S]{0,200}?gsd-execute-phase/);
    // Inline is the otherwise/else branch for plan — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      AUTONOMOUS,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the otherwise/else branch for execute — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      AUTONOMOUS,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });
});

describe('dispatch-should-flatten query — behavioral', () => {
  // #853 / #1708: The typed query replaces prose-level RUNTIME===codex checks.
  // shouldFlattenDispatch returns false only when both dispatch.background AND
  // dispatch.backgroundDispatch are true in the capability registry.
  //
  // Registry values (from host-integration-capability-matrix.md):
  //   codex:   background=true, backgroundDispatch=true  → shouldFlatten=false (may background)
  //   claude:  background=true, backgroundDispatch=false → shouldFlatten=true  (must inline)
  //   cursor:  background=true, backgroundDispatch=true  → shouldFlatten=false (may background)
  //   unknown: no entry → fail-closed                   → shouldFlatten=true  (must inline)

  test('runtime=codex → shouldFlatten=false (background dispatch safe)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'codex',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'false', `codex should return false (may background), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('runtime=claude → shouldFlatten=true (must inline)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'claude',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `claude should return true (must inline), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('runtime=cursor → shouldFlatten=false (background dispatch safe)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'cursor',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'false', `cursor should return false (may background), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('unknown runtime → shouldFlatten=true (fail-closed → must inline)', () => {
    // An unknown runtime has no registry entry → dispatch is null → fail-closed to true.
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'unknown-runtime-xyz',
      });
      // The query must succeed (exit 0) even for unknown runtimes — fail-closed not crash-closed.
      assert.ok(result.success, `Expected success (fail-closed), got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `unknown runtime should return true (fail-closed), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('--json flag returns structured { runtime, shouldFlatten, dispatch }', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--json'], tmpDir, {
        GSD_RUNTIME: 'codex',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      let parsed;
      try {
        parsed = JSON.parse(result.output);
      } catch {
        assert.fail(`Expected valid JSON output, got: ${result.output}`);
      }
      assert.strictEqual(parsed.runtime, 'codex');
      assert.strictEqual(parsed.shouldFlatten, false);
      assert.ok(parsed.dispatch !== null && typeof parsed.dispatch === 'object', 'dispatch should be an object');
      assert.strictEqual(parsed.dispatch.backgroundDispatch, true);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('config.runtime takes precedence when GSD_RUNTIME not set', () => {
    // GSD_RUNTIME > config.runtime > 'claude'
    // Write config.json with runtime=codex; no GSD_RUNTIME override.
    const tmpDir = createTempProject();
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ runtime: 'codex' }),
        'utf-8',
      );
      // Override GSD_RUNTIME to '' (empty string) so any ambient value is cleared.
      // resolveRuntimeNameFromCandidates treats empty string as absent (normalizes
      // to '' which is falsy → skipped → falls through to config.runtime=codex).
      // This is the only way to suppress an ambient GSD_RUNTIME since runGsdTools
      // merges { ...process.env, ...TEST_ENV_BASE, ...env } — passing '' as the
      // override overwrites the ambient value at the correct merge position.
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: '',
      });
      // config.runtime=codex with GSD_RUNTIME cleared → codex backgrounds → shouldFlatten=false
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'false', `config.runtime=codex (GSD_RUNTIME cleared) should return false (may background), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

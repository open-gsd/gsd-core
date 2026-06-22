'use strict';
/**
 * Regression guard — bug(#853): /gsd-manager and /gsd-autonomous --interactive
 * silently skipped worktree isolation + independent verification because they
 * dispatched Plan/Execute via Agent(run_in_background=true). On Claude Code a
 * backgrounded agent has no Agent/Task tool, so it cannot spawn the nested
 * subagents (worktree executors, plan-checker, verifier). The workflows must
 * now resolve the runtime and run inline everywhere except Codex, which is the
 * only supported runtime where a backgrounded agent can still nest subagents.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const MANAGER = fs.readFileSync(path.join(WORKFLOWS_DIR, 'manager.md'), 'utf8');
const AUTONOMOUS = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf8');

describe('bug-853 — manager/autonomous gate background dispatch by runtime', () => {
  test('manager.md resolves the runtime before dispatching plan/execute', () => {
    // Two dispatch sites (plan + execute), each must resolve the runtime.
    const matches = MANAGER.match(/config-get runtime/g) || [];
    assert.ok(matches.length >= 2, 'manager.md must resolve runtime for both plan and execute dispatch');
  });

  test('manager.md documents why most runtimes cannot background-dispatch', () => {
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    assert.match(MANAGER, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('manager.md gates background dispatch on codex and runs plan/execute inline otherwise', () => {
    // Codex takes the background path
    assert.match(MANAGER, /If `RUNTIME` is `codex`[\s\S]{0,400}?run_in_background=true/);
    // Inline is the default/else branch for plan — anchored on the explicit non-Codex label
    assert.match(
      MANAGER,
      /Otherwise \(Claude Code or any other non-Codex runtime\)[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the default/else branch for execute — anchored on the explicit non-Codex label
    assert.match(
      MANAGER,
      /Otherwise \(Claude Code or any other non-Codex runtime\)[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });

  test('autonomous.md gates interactive background dispatch by runtime', () => {
    const autoRuntimeMatches = AUTONOMOUS.match(/config-get runtime/g) || [];
    assert.ok(autoRuntimeMatches.length >= 2, 'autonomous.md must resolve runtime in both 3b (plan) and 3c (execute) interactive branches');
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    assert.match(AUTONOMOUS, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('autonomous.md gates interactive background dispatch on codex; runs plan/execute inline otherwise', () => {
    // Codex block: run_in_background=true appears within the codex branch and gsd-plan-phase is nearby
    assert.match(AUTONOMOUS, /If `RUNTIME` is `codex`[\s\S]{0,1200}?run_in_background=true[\s\S]{0,600}?gsd-plan-phase/);
    // Codex block: run_in_background=true appears within the codex branch and gsd-execute-phase is nearby
    assert.match(AUTONOMOUS, /If `RUNTIME` is `codex`[\s\S]{0,3000}?run_in_background=true[\s\S]{0,200}?gsd-execute-phase/);
    // Inline is the otherwise/else branch for plan — anchored on the explicit non-Codex label
    assert.match(
      AUTONOMOUS,
      /Otherwise \(Claude Code or any other non-Codex runtime\)[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the otherwise/else branch for execute — anchored on the explicit non-Codex label
    assert.match(
      AUTONOMOUS,
      /Otherwise \(Claude Code or any other non-Codex runtime\)[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });
});

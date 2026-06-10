'use strict';
/**
 * Regression guard — bug(#853): /gsd-manager and /gsd-autonomous --interactive
 * silently skipped worktree isolation + independent verification because they
 * dispatched Plan/Execute via Agent(run_in_background=true). On Claude Code a
 * backgrounded agent has no Agent/Task tool, so it cannot spawn the nested
 * subagents (worktree executors, plan-checker, verifier). The workflows must
 * now resolve the runtime and run inline on Claude Code.
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

  test('manager.md documents why Claude Code cannot background-dispatch', () => {
    assert.match(MANAGER, /backgrounded agent has no `Agent`\/`Task` tool/);
  });

  test('manager.md runs plan/execute inline on Claude Code', () => {
    assert.match(MANAGER, /If `RUNTIME` is `claude`[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/);
    assert.match(MANAGER, /If `RUNTIME` is `claude`[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/);
  });

  test('autonomous.md gates interactive background dispatch by runtime', () => {
    const autoRuntimeMatches = AUTONOMOUS.match(/config-get runtime/g) || [];
    assert.ok(autoRuntimeMatches.length >= 2, 'autonomous.md must resolve runtime in both 3b (plan) and 3c (execute) interactive branches');
    assert.match(AUTONOMOUS, /backgrounded agent has no `Agent`\/`Task` tool/);
  });

  test('autonomous.md runs plan/execute inline on Claude Code in interactive mode', () => {
    assert.match(AUTONOMOUS, /On Claude Code \(`RUNTIME` is `claude`\)[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/);
    assert.match(AUTONOMOUS, /On Claude Code \(`RUNTIME` is `claude`\)[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/);
  });
});

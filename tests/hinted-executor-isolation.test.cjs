'use strict';

/**
 * Executor dispatch identity: a plan's `agent_hint:` routes it to a hinted executor
 * (gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md), but both isolation
 * guards recognised only `gsd-executor`, so the hinted executor was waved through as a
 * "confirmed non-executor" even when the recorded dispatch decision required a harness
 * worktree. The dispatch record now names the plan's executor (`executor_type`, ADR-4630
 * record), and the guards check whichever executor it names.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { SENTINEL_RELATIVE_PATH } = require('../hooks/lib/isolation-sentinel.js');
const guard = require('../hooks/gsd-agent-isolation-guard.js');
const cursor = require('../hooks/gsd-cursor-subagent-start.js');

const WRITTEN_AT = 1_000_000;
const fresh = { now: () => WRITTEN_AT + 1000 };
const HINTED = 'acme-rails-executor';
const FLAG = 'isolation="worktree"';

function writeSentinel(dir, over = {}) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: '02-01-api', written_at: WRITTEN_AT, ...over,
  }));
}

const marker = '[gsd:dispatch phase="02" plan="02-01-api"] Execute plan 01 of phase 02.';

function claudeVerdict(project, subagentType, toolInputExtra = {}) {
  return guard.evaluateDispatch({
    tool_name: 'Agent',
    cwd: project,
    tool_input: { subagent_type: subagentType, prompt: marker, ...toolInputExtra },
  }, { clock: fresh }).action;
}

function cursorVerdict(project, subagentType) {
  return cursor.resolveIsolationDecision({
    subagent_type: subagentType,
    task: marker,
    workspace_roots: [project],
  }, { clock: fresh }).action;
}

describe('isolation guards check the executor the dispatch record names', () => {
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  test('a hinted executor without the worktree flag is blocked when the record names it', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, HINTED), 'block', 'claude guard');
    assert.notStrictEqual(cursorVerdict(project, HINTED), 'allow', 'cursor hook');
  });

  test('the same hinted executor carrying the flag is allowed', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, HINTED, { isolation: 'worktree' }), 'allow');
  });

  test('when the record names a hinted executor, gsd-executor itself is still guarded', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block');
  });

  test('a non-executor agent is not guarded', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier'), 'allow', 'claude guard');
    assert.strictEqual(cursorVerdict(project, 'gsd-verifier'), 'allow', 'cursor hook');
  });

  test('a record without executor_type keeps the gsd-executor-only rule', () => {
    writeSentinel(project);
    assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block');
    assert.strictEqual(claudeVerdict(project, HINTED), 'allow');
  });
});

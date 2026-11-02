'use strict';
// #5328 Nit 5: hooks.agent_model_guard has one vocabulary, warn | deny | false, across the config-set
// validator, both doc rows and the hook. Registered in scripts/docs-guard-registry.cjs (reads docs/CONFIGURATION.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const VOCAB = ['`"warn"`', '`"deny"`', '`false`'];
const row = (file) => splitLines(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).find((l) => l.startsWith('| `hooks.agent_model_guard` |'));

test('hooks.agent_model_guard vocabulary: config-set, both doc rows and the hook agree on warn, deny and false', (t) => {
  const project = createFixture({ prefix: 'gsd-amg-vocab-', planning: true, git: true, projectDoc: false });
  t.after(() => cleanup(project));
  const config = (mode) => fs.writeFileSync(path.join(project, '.planning', 'config.json'),
    JSON.stringify({ runtime: 'claude', model_overrides: { 'gsd-planner': 'opus' }, hooks: { agent_model_guard: mode } }));
  config('warn');
  for (const v of ['warn', 'deny', 'false']) assert.ok(runGsdTools(['config-set', 'hooks.agent_model_guard', v], project).success, v);
  assert.equal(runGsdTools(['config-set', 'hooks.agent_model_guard', 'block'], project).success, false);
  assert.deepEqual(row('gsd-core/references/planning-config.md').split(/(?<!\\)\|/)[4].match(/`[^`]+`/g), VOCAB);
  const conf = row('docs/CONFIGURATION.md');
  for (const v of VOCAB) assert.ok(conf.includes(v), v);
  const saved = process.env.GSD_RUNTIME;
  delete process.env.GSD_RUNTIME;
  t.after(() => { if (saved === undefined) delete process.env.GSD_RUNTIME; else process.env.GSD_RUNTIME = saved; });
  const { evaluateDispatch } = require('../hooks/gsd-agent-isolation-guard.js');
  const wrong = { hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: { subagent_type: 'gsd-planner', model: 'claude-haiku-4-5' } };
  for (const [mode, action] of [['warn', 'warn'], ['deny', 'block'], [false, 'allow'], [true, 'warn'], ['off', 'warn']]) {
    config(mode);
    assert.equal(evaluateDispatch(wrong).action, action, String(mode));
  }
});

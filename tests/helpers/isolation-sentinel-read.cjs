'use strict';

/**
 * Shared fixtures for the #5758 bounded dispatch-isolation sentinel read tests
 * (tests/isolation-sentinel-read.test.cjs, tests/isolation-sentinel-read.platform.test.cjs).
 *
 * Every hook run is a child process with a hard kill timer. A reader that blocks (FIFO with no
 * writer, an endless device) is killed by the timer and reports `signal: 'SIGKILL'`; a reader that
 * returns exits by itself with `signal: null`. That distinction is the regression signal.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createFixture } = require('../fixtures/index.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SENTINEL_MODULE = path.join(REPO_ROOT, 'hooks', 'lib', 'isolation-sentinel.js');
const GUARD_HOOK = path.join(REPO_ROOT, 'hooks', 'gsd-agent-isolation-guard.js');
const CURSOR_HOOK = path.join(REPO_ROOT, 'hooks', 'gsd-cursor-subagent-start.js');

const PHASE = '03';
const PLAN = '03-02-hardening';
const MARKER = `[gsd:dispatch phase="${PHASE}" plan="${PLAN}"] Execute the plan.`;

const LEGACY_REL = path.join('.gsd', 'dispatch-isolation-sentinel.json');
const KEYED_DIR_REL = path.join('.gsd', 'dispatch-isolation');
const KEYED_REL = path.join(KEYED_DIR_REL, `${PHASE}--${PLAN}.json`);

function validBody(overrides = {}) {
  return { isolation: 'none', harness_flag: null, phase: PHASE, plan: PLAN, written_at: Date.now(), ...overrides };
}

/** Valid-JSON sentinel text of exactly `bytes` bytes (padded with trailing spaces). */
function paddedBody(bytes, overrides = {}) {
  const json = JSON.stringify(validBody(overrides));
  if (json.length > bytes) throw new Error(`body is ${json.length} bytes, cannot pad down to ${bytes}`);
  return json + ' '.repeat(bytes - json.length);
}

function writeFileAt(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function childEnv() {
  const env = { ...process.env, GSD_TEST_MODE: '1' };
  delete env.GSD_RUNTIME;
  delete env.CURSOR_CONFIG_DIR;
  return env;
}

function spawnBounded(args, { input, cwd }) {
  const r = spawnSync(process.execPath, args, {
    input,
    cwd,
    env: childEnv(),
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** readSentinel(root, {dispatchIds}) in a bounded child. `result` is the parsed return value. */
function readSentinelBounded(root, dispatchIds = null) {
  const script = [
    `const { readSentinel } = require(${JSON.stringify(SENTINEL_MODULE)});`,
    `const ids = JSON.parse(process.argv[2]);`,
    `process.stdout.write(JSON.stringify(readSentinel(process.argv[1], { dispatchIds: ids })));`,
  ].join('\n');
  const r = spawnBounded(['-e', script, root, JSON.stringify(dispatchIds)], { input: '', cwd: os.tmpdir() });
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { /* a killed child leaves no output */ }
  return { ...r, result };
}

function runGuard(root) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'gsd-executor', prompt: MARKER },
  };
  return spawnBounded([GUARD_HOOK], { input: JSON.stringify(payload), cwd: root });
}

function runCursor(root) {
  const payload = {
    hook_event_name: 'subagentStart',
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    workspace_roots: [root],
    subagent_id: 'sub-1',
    subagent_type: 'gsd-executor',
    task: MARKER,
    parent_conversation_id: 'conv-0',
    tool_call_id: 'call-1',
    subagent_model: 'auto',
    is_parallel_worker: false,
  };
  return spawnBounded([CURSOR_HOOK], { input: JSON.stringify(payload), cwd: os.tmpdir() });
}

/** Project whose config resolves the agent guard to harness-worktree (a flag-less dispatch is denied); the #5328 model guard is off, so the isolation verdict is the only one. */
function makeGuardProject() {
  const root = createFixture({ prefix: 'gsd-5758-guard-', planning: true, git: true, projectDoc: false });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude', hooks: { agent_model_guard: false } }));
  return root;
}

/** Project whose config resolves the cursor hook to harness-worktree (main checkout -> deny). */
function makeCursorProject() {
  const root = createFixture({ prefix: 'gsd-5758-cursor-', planning: true, git: true, projectDoc: false });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
  return root;
}

module.exports = {
  PHASE,
  PLAN,
  LEGACY_REL,
  KEYED_DIR_REL,
  KEYED_REL,
  validBody,
  paddedBody,
  writeFileAt,
  readSentinelBounded,
  runGuard,
  runCursor,
  makeGuardProject,
  makeCursorProject,
};

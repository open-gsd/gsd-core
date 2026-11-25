'use strict';

/**
 * #5822: `workflow.post_merge_gate` (`always` | `on_merge`, default `always`).
 *
 * The gate rows extract Step A and Step B from the shipped
 * `execute-phase/steps/post-merge-gate.md` verbatim (never reimplemented) and
 * run each against a real git fixture with this checkout's CLI. The configured
 * build and test commands touch marker files, so a row sees whether the gate
 * really ran them. The config rows drive `config-get` / `config-set`.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const POST_MERGE_GATE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'post-merge-gate.md');

const STEP_A = '**Step A — Build gate:**';
const STEP_B = '**Step B — Test gate:**';
const BUILD_SKIP = 'Post-merge build gate skipped (workflow.post_merge_gate=on_merge): serial mode (workflow.use_worktrees=false)';
const TEST_SKIP = 'Post-merge test gate skipped (workflow.post_merge_gate=on_merge): serial mode (workflow.use_worktrees=false)';

function bashFenceAfter(content, startAnchor, stopAnchor) {
  const start = content.indexOf(startAnchor);
  assert.ok(start !== -1, `post-merge-gate.md must contain "${startAnchor}"`);
  const stop = stopAnchor ? content.indexOf(stopAnchor, start + startAnchor.length) : content.length;
  assert.ok(stop !== -1, `post-merge-gate.md must contain "${stopAnchor}" after "${startAnchor}"`);
  const region = content.slice(start, stop);
  const open = region.indexOf('```bash');
  assert.ok(open !== -1, `no bash fence after "${startAnchor}"`);
  const close = region.indexOf('```', open + '```bash'.length);
  assert.ok(close !== -1, `unterminated bash fence after "${startAnchor}"`);
  return region.slice(open + '```bash'.length, close);
}

function configPath(dir) {
  return path.join(dir, '.planning', 'config.json');
}

function writeWorkflowConfig(dir, workflow) {
  const config = { workflow: { build_command: 'touch build.ran', test_command: 'touch test.ran', ...workflow } };
  fs.writeFileSync(configPath(dir), JSON.stringify(config, null, 2));
}

function gateEnv(dir) {
  const env = { ...process.env, ...homeSandboxEnv(dir), RUNTIME_DIR: ROOT, GSD_TEST_TOOLS: TOOLS_PATH };
  delete env.CLAUDE_ENV_FILE;
  return env;
}

// Runs one fenced block in its own bash process, as the orchestrator does, and reports its exit variable.
function runBlock(dir, name, body, exitVar) {
  const scriptPath = path.join(dir, `.${name}.sh`);
  fs.writeFileSync(scriptPath, `${body}\nprintf '\\nGATE-RESULT ${exitVar}=%s\\n' "$${exitVar}"\n`);
  const r = runHook(scriptPath, [], { interpreter: 'bash', cwd: dir, env: gateEnv(dir), timeoutMs: HOOK_FANOUT_TIMEOUT_MS });
  assert.equal(r.exitCode, 0, `${name} exited ${r.exitCode}\n${r.summary}`);
  return r.stdout;
}

function runGate(dir) {
  const content = fs.readFileSync(POST_MERGE_GATE, 'utf-8');
  const stepA = bashFenceAfter(content, STEP_A, STEP_B);
  // Step B runs after Step A in the orchestrator's session and uses its gsd_run; a fresh shell needs one.
  const stepB = `gsd_run() { node "$GSD_TEST_TOOLS" "$@"; }\n${bashFenceAfter(content, STEP_B, null)}`;
  const build = runBlock(dir, 'step-a', stepA, 'BUILD_EXIT');
  const testOut = runBlock(dir, 'step-b', stepB, 'TEST_EXIT');
  return {
    build,
    test: testOut,
    built: fs.existsSync(path.join(dir, 'build.ran')),
    tested: fs.existsSync(path.join(dir, 'test.ran')),
  };
}

describe('#5822: post-merge gate cadence, run from the shipped step file', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempGitProject('gsd-pmg-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('on_merge with use_worktrees false skips both gates and names the reason', () => {
    writeWorkflowConfig(tmpDir, { post_merge_gate: 'on_merge', use_worktrees: false });
    const r = runGate(tmpDir);
    assert.equal(r.built, false, 'the build command must not run');
    assert.equal(r.tested, false, 'the test command must not run');
    assert.ok(r.build.includes(BUILD_SKIP), `Step A must print its skip line:\n${r.build}`);
    assert.ok(r.test.includes(TEST_SKIP), `Step B must print its skip line:\n${r.test}`);
    assert.ok(r.build.includes('GATE-RESULT BUILD_EXIT=0'), r.build);
    assert.ok(r.test.includes('GATE-RESULT TEST_EXIT=0'), r.test);
    assert.equal(fs.existsSync(path.join(tmpDir, '.git', 'gsd-handoff', 'wave-failures')), false, 'a skip records no wave failure');
  });

  for (const [label, workflow] of [
    ['the key unset (default always) with use_worktrees false', { use_worktrees: false }],
    ['always with use_worktrees false', { post_merge_gate: 'always', use_worktrees: false }],
    ['on_merge with use_worktrees true', { post_merge_gate: 'on_merge', use_worktrees: true }],
    ['on_merge with use_worktrees unset', { post_merge_gate: 'on_merge' }],
    ['a hand-edited value other than on_merge with use_worktrees false', { post_merge_gate: 'ON_MERGE', use_worktrees: false }],
  ]) {
    test(`${label} runs both gates`, () => {
      writeWorkflowConfig(tmpDir, workflow);
      const r = runGate(tmpDir);
      assert.equal(r.built, true, `the build command must run:\n${r.build}`);
      assert.equal(r.tested, true, `the test command must run:\n${r.test}`);
      assert.ok(!r.build.includes('gate skipped'), r.build);
      assert.ok(!r.test.includes('gate skipped'), r.test);
      assert.ok(r.build.includes('GATE-RESULT BUILD_EXIT=0'), r.build);
      assert.ok(r.test.includes('GATE-RESULT TEST_EXIT=0'), r.test);
    });
  }
});

describe('#5822: workflow.post_merge_gate config key', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempGitProject('gsd-pmg-cfg-'); });
  afterEach(() => { cleanup(tmpDir); });

  const run = (args) => runGsdTools(args, tmpDir, homeSandboxEnv(tmpDir));

  test('an absent key reads as always', () => {
    fs.writeFileSync(configPath(tmpDir), '{}');
    const got = run(['config-get', 'workflow.post_merge_gate']);
    assert.ok(got.success, got.error);
    assert.equal(JSON.parse(got.output), 'always');
  });

  test('config-set accepts on_merge and always', () => {
    fs.writeFileSync(configPath(tmpDir), '{}');
    for (const value of ['on_merge', 'always']) {
      const set = run(['config-set', 'workflow.post_merge_gate', value]);
      assert.ok(set.success, set.error);
      assert.equal(JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8')).workflow.post_merge_gate, value);
    }
  });

  test('config-set rejects other values and leaves the file untouched', () => {
    fs.writeFileSync(configPath(tmpDir), JSON.stringify({ workflow: { post_merge_gate: 'always' } }));
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    for (const bad of ['on-merge', 'ON_MERGE', 'never', '', 'true']) {
      const result = run(['config-set', 'workflow.post_merge_gate', bad]);
      assert.equal(result.success, false, `'${bad}' must be rejected`);
      assert.match(result.error, /always/, `'${bad}' error names the allowed values`);
      assert.match(result.error, /on_merge/, `'${bad}' error names the allowed values`);
      assert.equal(fs.readFileSync(configPath(tmpDir), 'utf8'), before, `'${bad}' must not be written`);
    }
  });
});

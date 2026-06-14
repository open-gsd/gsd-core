// Tests for gsd-tools effort sync command (#488)
// Verifies that effort frontmatter in installed agent files can be re-synced
// when effort config changes after initial install.
// allow-test-rule: structural-regression-guard — readFileSync asserts on installed agent .md files (the product under mutation) to verify dry-run safety and apply correctness; stderr.includes guards the CLI argument-rejection contract.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.resolve(__dirname, '../gsd-core/bin/gsd-tools.cjs');

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GSD_TEST_MODE: '1', ...env },
  });
  return result;
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// output() in core.cjs uses fs.writeSync(1, data) — intercept fd=1 writes.
// Pass raw=false so output() emits JSON (raw=true emits the plain rawValue string).
function captureOutput(fn) {
  const origWriteSync = fs.writeSync;
  let captured = '';
  fs.writeSync = (fd, data) => {
    if (fd === 1) captured += data;
    else origWriteSync(fd, data);
  };
  try {
    fn();
  } finally {
    fs.writeSync = origWriteSync;
  }
  return JSON.parse(captured);
}

function makeAgentsDir(tmpDir) {
  const agentsDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  return agentsDir;
}

function writePlanningConfig(tmpDir, effortConfig) {
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ effort: effortConfig }));
}

const AGENT_WITH_EFFORT = `---
name: gsd-planner
description: Plans phases for GSD milestones
effort: medium
---
Body of the agent.
`;

const AGENT_WITHOUT_EFFORT = `---
name: gsd-executor
description: Executes GSD phase plans
---
Body of the agent.
`;

describe('feat-488: effort sync command', () => {
  test('dry-run mode reports pending changes without writing files', () => {
    const tmpDir = makeTmpDir('effort-sync-dry-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { default: 'high', agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: true, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.dry_run, true);
    assert.equal(result.synced, 1, 'should report 1 pending change');
    assert.equal(result.changes[0].agent, 'gsd-planner');
    assert.equal(result.changes[0].from, 'medium');
    assert.equal(result.changes[0].to, 'xhigh');

    // dry-run must not modify the file
    assert.ok(fs.readFileSync(agentPath, 'utf8').includes('effort: medium'), 'dry-run must not write file');

    cleanup(tmpDir);
  });

  test('--apply mode rewrites effort: frontmatter to new config value', () => {
    const tmpDir = makeTmpDir('effort-sync-apply-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { default: 'low', agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.dry_run, false);
    assert.equal(result.synced, 1);

    const updated = fs.readFileSync(agentPath, 'utf8');
    assert.ok(updated.includes('effort: xhigh'), 'file must be updated to xhigh');
    assert.ok(!updated.includes('effort: medium'), 'old effort value must be gone');

    cleanup(tmpDir);
  });

  test('skips agents where effort: already matches config', () => {
    const tmpDir = makeTmpDir('effort-sync-noop-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    // Already has the correct value
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT.replace('effort: medium', 'effort: xhigh'));
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 0, 'nothing to sync when already matching');
    assert.equal(result.skipped, 1);

    cleanup(tmpDir);
  });

  test('injects effort: into agent files that lack the frontmatter key', () => {
    const tmpDir = makeTmpDir('effort-sync-inject-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-executor.md');
    fs.writeFileSync(agentPath, AGENT_WITHOUT_EFFORT);
    writePlanningConfig(tmpDir, { default: 'max' });

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 1, 'should inject effort into agent missing the key');
    assert.equal(result.changes[0].from, null);
    assert.equal(result.changes[0].to, 'max');
    assert.ok(fs.readFileSync(agentPath, 'utf8').includes('effort: max'), 'effort must be injected');

    cleanup(tmpDir);
  });

  test('non-claude runtime exits cleanly with informative reason field', () => {
    const tmpDir = makeTmpDir('effort-sync-gemini-');

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: true, runtime: 'gemini' })
    );

    assert.ok(result.reason, 'should include a reason message for unsupported runtime');
    assert.equal(result.synced, 0);

    cleanup(tmpDir);
  });

  test('home-default effort config gap: applies home-level effort when project config has no effort section', () => {
    // The key #488 scenario: user changed ~/.gsd/defaults.json effort settings
    // after install, but the project .planning/config.json has no effort section.
    // cmdEffortSync must pick up the home config (via readGsdEffectiveEffortConfig),
    // not fall back to 'high' (which loadConfig would return).
    //
    // readGsdEffectiveEffortConfig calls os.homedir() directly, and os.homedir()
    // is live (respects process.env.HOME).  We redirect HOME to an isolated
    // tmpHome so the test is hermetic and can assert the real outcome.
    const tmpHome = makeTmpDir('effort-sync-homecfg-');
    const tmpDir = makeTmpDir('effort-sync-project-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT); // current: effort: medium

    // Project has .planning/config.json with NO effort section
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ model_profile: 'balanced' }));

    // Home defaults set effort.default = low
    const gsdDir = path.join(tmpHome, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ effort: { default: 'low' } }));

    // Isolate HOME so readGsdEffectiveEffortConfig reads our fixture, not the
    // developer's real ~/.gsd/defaults.json.
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
    let result;
    try {
      result = captureOutput(() =>
        cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
      );
    } finally {
      process.env.HOME = origHome;
    }

    // With home effort.default = 'low' and the agent currently at 'medium',
    // cmdEffortSync must sync exactly 1 agent and set it to 'low'.
    assert.equal(result.synced, 1, 'should sync 1 agent whose effort differs from home default');
    assert.equal(result.changes[0].agent, 'gsd-planner');
    assert.equal(result.changes[0].from, 'medium');
    assert.equal(result.changes[0].to, 'low', 'effort must be updated to the home-default value');
    assert.ok(
      fs.readFileSync(agentPath, 'utf8').includes('effort: low'),
      'agent file must be rewritten with the home-default effort value'
    );

    cleanup(tmpHome);
    cleanup(tmpDir);
  });

  test('CLI dispatcher: positional args after effort sync are rejected', () => {
    const result = runCli(['effort', 'sync', 'unexpected-arg']);
    assert.notEqual(result.status, 0, 'should exit non-zero on unexpected positional arg');
    assert.ok(
      result.stderr.includes('positional') || result.stderr.includes('unexpected-arg'),
      `stderr should mention the bad arg; got: ${result.stderr}`
    );
  });

  test('CLI dispatcher: effort sync --apply routes through gsd-tools correctly', () => {
    const tmpDir = makeTmpDir('effort-sync-cli-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-planner': 'xhigh' } });

    const result = runCli(
      ['--cwd', tmpDir, 'effort', 'sync', '--apply', '--config-dir', tmpDir],
    );

    assert.equal(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
    // gsd-tools may print a startup banner before the JSON payload — parse from the first `{`.
    const jsonStart = result.stdout.indexOf('{');
    const output = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(output.synced, 1);
    assert.ok(
      fs.readFileSync(agentPath, 'utf8').includes('effort: xhigh'),
      'CLI --apply must write the updated effort value'
    );

    cleanup(tmpDir);
  });
});

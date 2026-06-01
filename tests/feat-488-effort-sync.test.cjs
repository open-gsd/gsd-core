// Tests for gsd-tools effort sync command (#488)
// Verifies that effort frontmatter in installed agent files can be re-synced
// when effort config changes after initial install.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

    const { cmdEffortSync } = require('../get-shit-done/bin/lib/commands.cjs');
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

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--apply mode rewrites effort: frontmatter to new config value', () => {
    const tmpDir = makeTmpDir('effort-sync-apply-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT);
    writePlanningConfig(tmpDir, { default: 'low', agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../get-shit-done/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.dry_run, false);
    assert.equal(result.synced, 1);

    const updated = fs.readFileSync(agentPath, 'utf8');
    assert.ok(updated.includes('effort: xhigh'), 'file must be updated to xhigh');
    assert.ok(!updated.includes('effort: medium'), 'old effort value must be gone');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skips agents where effort: already matches config', () => {
    const tmpDir = makeTmpDir('effort-sync-noop-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-planner.md');
    // Already has the correct value
    fs.writeFileSync(agentPath, AGENT_WITH_EFFORT.replace('effort: medium', 'effort: xhigh'));
    writePlanningConfig(tmpDir, { agent_overrides: { 'gsd-planner': 'xhigh' } });

    const { cmdEffortSync } = require('../get-shit-done/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 0, 'nothing to sync when already matching');
    assert.equal(result.skipped, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('injects effort: into agent files that lack the frontmatter key', () => {
    const tmpDir = makeTmpDir('effort-sync-inject-');
    const agentsDir = makeAgentsDir(tmpDir);
    const agentPath = path.join(agentsDir, 'gsd-executor.md');
    fs.writeFileSync(agentPath, AGENT_WITHOUT_EFFORT);
    writePlanningConfig(tmpDir, { default: 'max' });

    const { cmdEffortSync } = require('../get-shit-done/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
    );

    assert.equal(result.synced, 1, 'should inject effort into agent missing the key');
    assert.equal(result.changes[0].from, null);
    assert.equal(result.changes[0].to, 'max');
    assert.ok(fs.readFileSync(agentPath, 'utf8').includes('effort: max'), 'effort must be injected');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-claude runtime exits cleanly with informative reason field', () => {
    const tmpDir = makeTmpDir('effort-sync-gemini-');

    const { cmdEffortSync } = require('../get-shit-done/bin/lib/commands.cjs');
    const result = captureOutput(() =>
      cmdEffortSync(tmpDir, false, { dryRun: true, runtime: 'gemini' })
    );

    assert.ok(result.reason, 'should include a reason message for unsupported runtime');
    assert.equal(result.synced, 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

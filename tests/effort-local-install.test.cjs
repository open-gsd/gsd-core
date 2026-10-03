'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

test('#4988: installed local CLI syncs and reads its own Claude agents', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
  try {
    const globalDir = path.join(root, 'global-claude');
    fs.mkdirSync(path.join(globalDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
      runtime: 'claude',
      effort: { agent_overrides: { 'gsd-planner': 'low' } },
    }));

    const agentPath = path.join(configDir, 'agents', 'gsd-planner.md');
    const before = fs.readFileSync(agentPath, 'utf8');
    assert.match(before, /^effort: (?!low$)\S+/m, 'the installed agent starts with a different effort');

    const cli = path.join(configDir, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: globalDir };
    function run(args) {
      const result = runNode([cli, ...args], { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(result.exitCode, 0, `${args.join(' ')} failed:\n${result.stderr}`);
      return JSON.parse(result.stdout);
    }

    const preview = run(['effort', 'sync', '--dry-run']);
    assert.equal(preview.agents_dir, path.join(configDir, 'agents'));
    assert.ok(preview.changes.some(change => change.agent === 'gsd-planner' && change.to === 'low'));

    const effective = run(['resolve-execution', 'gsd-planner']);
    assert.equal(effective.effort, 'low');
    assert.equal(effective.effort_effective_source, 'frontmatter');
    assert.notEqual(effective.effort_effective, 'low');

    const applied = run(['effort', 'sync', '--apply']);
    assert.equal(applied.agents_dir, path.join(configDir, 'agents'));
    assert.match(fs.readFileSync(agentPath, 'utf8'), /^effort: low$/m);
    assert.equal(run(['resolve-execution', 'gsd-planner']).effort_effective, 'low');

    const emptyExplicit = run(['effort', 'sync', '--dry-run', '--config-dir', globalDir]);
    assert.equal(emptyExplicit.agents_dir, path.join(globalDir, 'agents'));
    assert.equal(emptyExplicit.reason, 'no GSD agent files found');

    const globalAgentPath = path.join(globalDir, 'agents', 'gsd-planner.md');
    fs.writeFileSync(globalAgentPath, before);
    const populatedExplicit = run(['effort', 'sync', '--dry-run', '--config-dir', globalDir]);
    assert.equal(populatedExplicit.agents_dir, path.join(globalDir, 'agents'));
    assert.ok(populatedExplicit.changes.some(change => change.agent === 'gsd-planner' && change.to === 'low'));

    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, scope: 'global' }));
    const globalScope = run(['effort', 'sync', '--dry-run']);
    assert.equal(globalScope.agents_dir, path.join(globalDir, 'agents'));
    assert.ok(globalScope.changes.some(change => change.agent === 'gsd-planner' && change.to === 'low'));

    const legacyManifest = { ...manifest };
    delete legacyManifest.scope;
    fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest));
    const absentScope = run(['effort', 'sync', '--dry-run']);
    assert.equal(absentScope.agents_dir, path.join(globalDir, 'agents'));
    assert.ok(absentScope.changes.some(change => change.agent === 'gsd-planner' && change.to === 'low'));
  } finally {
    cleanup(root);
  }
});

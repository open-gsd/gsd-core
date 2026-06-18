'use strict';

/**
 * claude-orchestration.test.cjs - issue #1143 behavioral coverage.
 *
 * The feature is default-off and runtime-gated. These tests pin the policy
 * boundary before implementation: no ambient process.env/config reads in pure
 * logic, gate output includes a uniform block boolean, and the execute loop
 * dispatches execute:wave:pre before manual background-agent orchestration.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const {
  resolveClaudeOrchestrationStatus,
} = require('../gsd-core/bin/lib/claude-orchestration.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const gsdToolsPath = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const executePhasePath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const loopHookDispatchPath = path.resolve(__dirname, '..', 'gsd-core', 'references', 'loop-hook-dispatch.md');

function makeProject(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-orch-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  }
  return dir;
}

function makeProjectWithRawConfig(rawConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-orch-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), rawConfig);
  return dir;
}

function makeEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    ...overrides,
  };
}

describe('resolveClaudeOrchestrationStatus - pure policy', () => {
  test('default-off feature selects inline backend and never blocks', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      config: {},
    });
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.active, false);
    assert.strictEqual(status.selected_backend, 'inline');
    assert.strictEqual(status.block, false);
    assert.strictEqual(status.reason, 'disabled');
  });

  test('enabled auto backend uses current inline executor slice when no teams are active', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: {},
      config: {
        'workflow.claude_orchestration': true,
        'workflow.claude_orchestration_backend': 'auto',
      },
    });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.workflow_available, true);
    assert.strictEqual(status.selected_backend, 'inline');
    assert.strictEqual(status.block, false);
    assert.strictEqual(status.reason, 'inline-ready');
  });

  test('enabled auto backend blocks current inline executor slice when Claude agent teams are active', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      config: {
        'workflow.claude_orchestration': true,
        'workflow.claude_orchestration_backend': 'auto',
      },
    });
    assert.strictEqual(status.workflow_available, true);
    assert.strictEqual(status.teams_active, true);
    assert.strictEqual(status.selected_backend, 'inline');
    assert.strictEqual(status.block, true);
    assert.strictEqual(status.reason, 'manual-dispatch-unsafe-with-agent-teams');
  });

  test('enabled inline/manual backend blocks when Claude agent teams are active', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'true' },
      config: {
        'workflow.claude_orchestration': true,
        'workflow.claude_orchestration_backend': 'inline',
      },
    });
    assert.strictEqual(status.teams_active, true);
    assert.strictEqual(status.manual_dispatch_safe, false);
    assert.strictEqual(status.selected_backend, 'inline');
    assert.strictEqual(status.block, true);
    assert.strictEqual(status.reason, 'manual-dispatch-unsafe-with-agent-teams');
    assert.match(status.message, /agent teams/i);
  });

  test('explicit workflow backend blocks until generated Workflow executor is implemented', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: {},
      config: {
        'workflow.claude_orchestration': true,
        'workflow.claude_orchestration_backend': 'workflow',
      },
    });
    assert.strictEqual(status.workflow_available, true);
    assert.strictEqual(status.block, true);
    assert.strictEqual(status.reason, 'workflow-backend-unavailable');
  });

  test('invalid backend blocks instead of silently degrading to auto', () => {
    const status = resolveClaudeOrchestrationStatus({
      runtime: 'claude',
      env: {},
      config: {
        'workflow.claude_orchestration': true,
        'workflow.claude_orchestration_backend': 'workflwo',
      },
    });
    assert.strictEqual(status.requested_backend, 'auto');
    assert.strictEqual(status.config_error, 'Invalid workflow.claude_orchestration_backend: "workflwo"');
    assert.strictEqual(status.block, true);
    assert.strictEqual(status.reason, 'invalid-backend');
  });
});

describe('claude-orchestration capability gate', () => {
  test('capability registers default-off config and an execute:wave:pre blocking gate', () => {
    const cap = registry.capabilities['claude-orchestration'];
    assert.ok(cap, 'claude-orchestration capability must be registered');
    assert.strictEqual(registry.configSchema['workflow.claude_orchestration'].default, false);
    assert.strictEqual(registry.configSchema['workflow.claude_orchestration_backend'].default, 'auto');

    const gate = (registry.byLoopPoint['execute:wave:pre'].gates || [])
      .find((entry) => entry.capId === 'claude-orchestration');
    assert.ok(gate, 'capability must own an execute:wave:pre gate');
    assert.strictEqual(gate.check.query, 'claude-orchestration.preflight');
    assert.strictEqual(gate.when, 'workflow.claude_orchestration');
    assert.strictEqual(gate.blocking, true);
    assert.strictEqual(gate.onError, 'halt');
  });

  test('preflight check returns uniform block=false when capability is disabled', () => {
    const dir = makeProject({ runtime: 'claude', workflow: { claude_orchestration: false } });
    try {
      const result = spawnSync(
        process.execPath,
        [gsdToolsPath, 'check', 'claude-orchestration.preflight', '1', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }),
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.block, false);
      assert.strictEqual(parsed.enabled, false);
      assert.strictEqual(parsed.reason, 'disabled');
    } finally {
      cleanup(dir);
    }
  });

  test('preflight check blocks enabled inline dispatch under active Claude agent teams', () => {
    const dir = makeProject({
      runtime: 'claude',
      workflow: {
        claude_orchestration: true,
        claude_orchestration_backend: 'inline',
      },
    });
    try {
      const result = spawnSync(
        process.execPath,
        [gsdToolsPath, 'check', 'claude-orchestration.preflight', '1', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }),
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.block, true);
      assert.strictEqual(parsed.selected_backend, 'inline');
      assert.strictEqual(parsed.reason, 'manual-dispatch-unsafe-with-agent-teams');
    } finally {
      cleanup(dir);
    }
  });

  test('preflight check fails closed for malformed project config', () => {
    const dir = makeProjectWithRawConfig('{"workflow":');
    try {
      const result = spawnSync(
        process.execPath,
        [gsdToolsPath, 'check', 'claude-orchestration.preflight', '1', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.block, true);
      assert.strictEqual(parsed.reason, 'config-read-failed');
      assert.match(parsed.message, /\.planning\/config\.json/);
    } finally {
      cleanup(dir);
    }
  });

  test('execute:wave:pre hook rendering fails closed for malformed project config', () => {
    const dir = makeProjectWithRawConfig('{"workflow":');
    try {
      const result = spawnSync(
        process.execPath,
        [gsdToolsPath, 'loop', 'render-hooks', 'execute:wave:pre', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.notStrictEqual(result.status, 0, 'execute:wave:pre must fail closed on malformed config');
      assert.match(result.stderr + result.stdout, /cannot safely resolve blocking preflight gates/);
    } finally {
      cleanup(dir);
    }
  });

  test('preflight check fails closed for invalid backend in project config', () => {
    const dir = makeProjectWithRawConfig(JSON.stringify({
      workflow: {
        claude_orchestration: true,
        claude_orchestration_backend: 'workflwo',
      },
    }));
    try {
      const result = spawnSync(
        process.execPath,
        [gsdToolsPath, 'check', 'claude-orchestration.preflight', '1', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.block, true);
      assert.strictEqual(parsed.reason, 'invalid-backend');
      assert.match(parsed.message, /auto, inline, or workflow/);
    } finally {
      cleanup(dir);
    }
  });

  test('config-set accepts capability-owned Claude orchestration keys', () => {
    const dir = makeProject({});
    try {
      const enabled = spawnSync(
        process.execPath,
        [gsdToolsPath, 'query', 'config-set', 'workflow.claude_orchestration', 'true', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.strictEqual(enabled.status, 0, enabled.stderr);

      const backend = spawnSync(
        process.execPath,
        [gsdToolsPath, 'query', 'config-set', 'workflow.claude_orchestration_backend', 'workflow', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.strictEqual(backend.status, 0, backend.stderr);

      const status = spawnSync(
        process.execPath,
        [gsdToolsPath, 'query', 'claude-orchestration.status', '--raw', '--cwd', dir],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: makeEnv({ GSD_RUNTIME: 'claude' }),
        },
      );
      assert.strictEqual(status.status, 0, status.stderr);
      const parsed = JSON.parse(status.stdout);
      assert.strictEqual(parsed.enabled, true);
      assert.strictEqual(parsed.requested_backend, 'workflow');
    } finally {
      cleanup(dir);
    }
  });
});

describe('execute-phase Claude orchestration integration', () => {
  test('dispatches execute:wave:pre hooks before manual executor-agent dispatch', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    const preHook = content.indexOf('loop render-hooks execute:wave:pre');
    const dispatch = content.indexOf('Dispatch each `Agent()` call **one at a time with `run_in_background: true`**');
    assert.ok(preHook !== -1, 'execute-phase must render execute:wave:pre hooks');
    assert.ok(dispatch !== -1, 'sanity: manual background-agent dispatch text should exist');
    assert.ok(preHook < dispatch, 'pre-wave gates must run before manual background-agent dispatch');
    assert.match(content, /claude-orchestration\.preflight/);
  });

  test('loop hook dispatch reference preserves halt and codebase-drift auto-remap semantics', () => {
    const content = fs.readFileSync(loopHookDispatchPath, 'utf8');
    assert.match(content, /onError[\s\S]*`halt`/);
    assert.doesNotMatch(content, /`fail` means surface the error and stop/);
    assert.match(content, /verify\.codebase-drift/);
    assert.match(content, /spawn_mapper/);
    assert.match(content, /auto-remap/);
  });
});

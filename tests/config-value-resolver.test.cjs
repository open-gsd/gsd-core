'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { resolveConfigValue } = require('../gsd-core/bin/lib/config-value-resolver.cjs');

function withLayers(run) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-value-'));
  const old = Object.fromEntries(['HOME', 'USERPROFILE', 'GSD_HOME', 'GSD_WORKSTREAM', 'GSD_PROJECT', 'CLAUDE_CONFIG_DIR']
    .map((key) => [key, process.env[key]]));
  process.env.HOME = path.join(cwd, 'home');
  process.env.USERPROFILE = process.env.HOME;
  delete process.env.GSD_HOME;
  process.env.GSD_WORKSTREAM = 'test';
  delete process.env.GSD_PROJECT;
  process.env.CLAUDE_CONFIG_DIR = path.join(cwd, 'home', '.claude');
  try {
    run(cwd);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(cwd);
  }
}

function writeLayer(cwd, layer, value) {
  const paths = {
    workstream: path.join(cwd, '.planning', 'workstreams', 'test', 'config.json'),
    root: path.join(cwd, '.planning', 'config.json'),
    'global-defaults': path.join(process.env.HOME, '.gsd', 'defaults.json'),
    'runtime-local': path.join(cwd, '.claude', 'settings.local.json'),
    'runtime-shared': path.join(cwd, '.claude', 'settings.json'),
    'runtime-user': path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
  };
  const file = paths[layer];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function setPath(key, value) {
  return key.split('.').reverse().reduce((nested, segment) => ({ [segment]: nested }), value);
}

describe('Config Value Resolution Module (#5096)', () => {
  test('fast-check layer × type matrix preserves value and producing layer in both families', () => {
    const samples = [false, 0, '', [], {}, null, true, 7, 'head', [1], { note: 'value' }];
    const families = [
      { key: 'project_code', layers: ['workstream', 'root', 'global-defaults'] },
      { key: 'worktree.baseRef', layers: ['runtime-local', 'runtime-shared', 'runtime-user'] },
    ];
    fc.assert(fc.property(
      fc.constantFrom(...families),
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom(...samples),
      fc.boolean(),
      fc.boolean(),
      (family, index, value, present, higherPresent) => {
        withLayers((cwd) => {
          const chosen = family.layers[index];
          if (present) writeLayer(cwd, chosen, setPath(family.key, value));
          if (index < 2) writeLayer(cwd, family.layers[index + 1], setPath(family.key, 'lower'));
          if (higherPresent && index > 0) writeLayer(cwd, family.layers[index - 1], {});
          const resolution = resolveConfigValue(family.key, { cwd });
          const expectedLayer = present ? chosen : family.layers[index + 1] ??
            (family.key === 'project_code' ? 'builtin-default' : null);
          assert.equal(resolution.found, expectedLayer !== null);
          assert.deepEqual(resolution.value, present ? value : index < 2 ? 'lower' :
            family.key === 'project_code' ? null : undefined);
          assert.equal(resolution.layer, expectedLayer);
        });
      },
    ));
  });

  test('every file layer resolves each JSON type and an absent higher layer', () => {
    const cases = [
      ['project_code', ['workstream', 'root', 'global-defaults']],
      ['worktree.baseRef', ['runtime-local', 'runtime-shared', 'runtime-user']],
    ];
    for (const [key, layers] of cases) {
      for (const layer of layers) {
        for (const value of [false, 0, '', [], {}, null]) {
          withLayers((cwd) => {
            writeLayer(cwd, layer, setPath(key, value));
            const actual = resolveConfigValue(key, { cwd });
            assert.equal(actual.found, true);
            assert.deepEqual(actual.value, value);
            assert.equal(actual.layer, layer);
          });
        }
      }
    }
  });

  test('schema and builtin defaults retain their own origin, never a file origin', () => {
    withLayers((cwd) => {
      assert.deepEqual(resolveConfigValue('git.create_tag', { cwd }), {
        found: true, value: true, layer: 'schema-default', reason: 'resolved',
      });
      assert.deepEqual(resolveConfigValue('project_code', { cwd }), {
        found: true, value: null, layer: 'builtin-default', reason: 'resolved',
      });
    });
  });

  test('empty configured files and genuinely absent keys have distinct reasons', () => {
    withLayers((cwd) => {
      const key = 'model_overrides.sample';
      assert.deepEqual(resolveConfigValue(key, { cwd }), {
        found: false, value: undefined, layer: null, reason: 'not_configured',
      });
      writeLayer(cwd, 'root', {});
      assert.deepEqual(resolveConfigValue(key, { cwd }), {
        found: false, value: undefined, layer: null, reason: 'configured_empty',
      });
      assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
        found: false, value: undefined, layer: null, reason: 'not_configured',
      });
      writeLayer(cwd, 'runtime-local', {});
      assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
        found: false, value: undefined, layer: null, reason: 'configured_empty',
      });
    });
  });

  test('malformed and unreadable inputs remain distinguishable from absence', () => {
    withLayers((cwd) => {
      const file = writeLayer(cwd, 'root', {});
      fs.writeFileSync(file, '{invalid', 'utf8');
      assert.equal(resolveConfigValue('model_overrides.sample', { cwd }).reason, 'config_unparseable');
      cleanup(file);
      fs.mkdirSync(file);
      assert.equal(resolveConfigValue('model_overrides.sample', { cwd }).reason, 'config_unreadable');
    });
  });

  test('a corrupt higher layer does not hide the lower value or its origin', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { project_code: 'working' });
      const file = writeLayer(cwd, 'workstream', {});
      fs.writeFileSync(file, '{invalid', 'utf8');
      const originalWrite = process.stderr.write;
      const diagnostics = [];
      process.stderr.write = (chunk) => { diagnostics.push(chunk); return true; };
      try {
        for (let i = 0; i < 2; i++) {
          const result = resolveConfigValue('project_code', { cwd });
          assert.equal(result.value, 'working');
          assert.equal(result.layer, 'root');
          assert.equal(result.reason, 'config_unparseable');
        }
        assert.equal(diagnostics.length, 1);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  test('JSONC settings and an explicit null preserve runtime provenance', () => {
    withLayers((cwd) => {
      const file = writeLayer(cwd, 'runtime-shared', {});
      fs.writeFileSync(file, '{ // runtime setting\n "worktree": { "baseRef": null, },\n}', 'utf8');
      writeLayer(cwd, 'runtime-user', { worktree: { baseRef: 'head' } });
      assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
        found: true, value: null, layer: 'runtime-shared', reason: 'resolved',
      });
    });
  });

  test('declared merge keys retain per-leaf provenance and deep effort overrides', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', {
        effort: { agent_overrides: { planner: 'low', executor: 'high' } },
      });
      writeLayer(cwd, 'root', {
        effort: { agent_overrides: { planner: 'xhigh' } },
      });
      const result = resolveConfigValue('effort', { cwd });
      assert.equal(result.found, true);
      assert.equal(result.layer, 'root');
      assert.equal(result.value.agent_overrides.planner, 'xhigh');
      assert.equal(result.value.agent_overrides.executor, 'high');
      assert.equal(result.composite['agent_overrides.planner'], 'root');
      assert.equal(result.composite['agent_overrides.executor'], 'global-defaults');
    });
  });

  test('all declared object merges preserve sibling leaves and their origins', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', {
        model_overrides: { planner: 'global', executor: 'global' },
        agent_tools: { planner: ['Read'], executor: ['Bash'] },
        agent_skills: { planner: ['global'], executor: ['global'] },
      });
      writeLayer(cwd, 'root', {
        model_overrides: { planner: 'project' },
        agent_tools: { planner: [] },
        agent_skills: { planner: ['project'] },
      });
      for (const [key, expected] of [
        ['model_overrides', { planner: 'project', executor: 'global' }],
        ['agent_tools', { planner: [], executor: ['Bash'] }],
        ['agent_skills', { planner: ['project'], executor: ['global'] }],
      ]) {
        const result = resolveConfigValue(key, { cwd });
        assert.equal(result.layer, 'root');
        assert.deepEqual(result.value, expected);
        assert.equal(result.composite.planner, 'root');
        assert.equal(result.composite.executor, 'global-defaults');
      }
    });
  });

  test('a declared merge key with null replaces lower layers without object spreading', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', { agent_tools: { planner: ['Read'] } });
      writeLayer(cwd, 'root', { agent_tools: null });
      const result = resolveConfigValue('agent_tools', { cwd });
      assert.equal(result.found, true);
      assert.equal(result.value, null);
      assert.equal(result.layer, 'root');
      assert.equal(result.composite, undefined);
    });
  });

  test('empty nested merge adds no leaf and cannot claim a higher producing layer', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', { effort: { agent_overrides: { planner: 'low' } } });
      writeLayer(cwd, 'root', { effort: { agent_overrides: {} } });
      const result = resolveConfigValue('effort', { cwd });
      assert.equal(result.layer, 'global-defaults');
      assert.equal(result.composite['agent_overrides.planner'], 'global-defaults');
    });
  });

  test('an empty object replacing a lower null owns the composite container', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', { model_overrides: null });
      writeLayer(cwd, 'root', { model_overrides: {} });
      const result = resolveConfigValue('model_overrides', { cwd });
      assert.deepEqual(result.value, {});
      assert.equal(result.layer, 'root');
      assert.deepEqual(result.composite, {});
    });
  });

  test('an explicitly empty composite container owns its layer even above empty defaults', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { agent_skills: {} });
      const result = resolveConfigValue('agent_skills', { cwd });
      assert.deepEqual(result.value, {});
      assert.equal(result.layer, 'root');
      assert.deepEqual(result.composite, {});
    });
  });

  test('a configured null container blocks inherited descendant values', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'global-defaults', { agent_skills: { planner: true } });
      writeLayer(cwd, 'root', { agent_skills: null });
      const result = resolveConfigValue('agent_skills.planner', { cwd });
      assert.equal(result.found, false);
      assert.equal(result.value, undefined);
      assert.equal(result.layer, null);
    });
  });

  test('a null parent blocks lower files but not schema or builtin defaults', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { workflow: null, git: null });
      writeLayer(cwd, 'global-defaults', {
        workflow: { research: false },
        git: { branching_strategy: 'global' },
      });
      const schema = resolveConfigValue('workflow.research', { cwd });
      assert.equal(schema.found, true);
      assert.equal(schema.value, true);
      assert.equal(schema.layer, 'schema-default');
      const builtin = resolveConfigValue('git.branching_strategy', { cwd });
      assert.equal(builtin.found, true);
      assert.equal(builtin.value, 'none');
      assert.equal(builtin.layer, 'builtin-default');
    });
  });

  test('family B null parents block values from lower runtime layers', () => {
    for (const [higher, lower] of [
      ['runtime-local', 'runtime-shared'],
      ['runtime-local', 'runtime-user'],
      ['runtime-shared', 'runtime-user'],
    ]) {
      withLayers((cwd) => {
        writeLayer(cwd, lower, { worktree: { baseRef: 'lower' } });
        assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
          found: true, value: 'lower', layer: lower, reason: 'resolved',
        });
        writeLayer(cwd, higher, { worktree: null });
        assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
          found: false, value: undefined, layer: null, reason: 'not_configured',
        });
      });
    }
  });

  test('a composite inherited from root records workstream fallback reason', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { agent_tools: { planner: [] } });
      const result = resolveConfigValue('agent_tools', { cwd });
      assert.equal(result.layer, 'root');
      assert.equal(result.reason, 'workstream_fallback');
    });
  });

  test('unknown and inherited dotted keys cannot become configured', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { project_code: 'owned' });
      assert.equal(resolveConfigValue('arbitrary.key', { cwd }).found, false);
      assert.equal(resolveConfigValue('agent_skills.__proto__', { cwd }).found, false);
      assert.throws(() => resolveConfigValue('worktree.baseRef', { cwd, family: 'A' }), RangeError);
      assert.throws(() => resolveConfigValue('project_code', { cwd, family: 'B' }), RangeError);
    });
  });

  test('GSD_PROJECT-only scope reads its active config, not an unrelated project root', () => {
    withLayers((cwd) => {
      process.env.GSD_PROJECT = 'client';
      delete process.env.GSD_WORKSTREAM;
      writeLayer(cwd, 'root', { project_code: 'unrelated' });
      const scoped = path.join(cwd, '.planning', 'client', 'config.json');
      fs.mkdirSync(path.dirname(scoped), { recursive: true });
      fs.writeFileSync(scoped, JSON.stringify({ project_code: 'client' }));
      const result = resolveConfigValue('project_code', { cwd });
      assert.equal(result.value, 'client');
      assert.equal(result.layer, 'root');
    });
  });

  test('federated values with wrong type or invalid enum fall through to schema defaults', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'root', { workflow: { ai_integration_phase: 'false', code_review_depth: 'invalid' } });
      for (const [key, expected] of [
        ['workflow.ai_integration_phase', true],
        ['workflow.code_review_depth', 'standard'],
      ]) {
        const result = resolveConfigValue(key, { cwd });
        assert.equal(result.value, expected);
        assert.equal(result.layer, 'schema-default');
      }
    });
  });

  test('legacy multiRepo detection is completed in memory without a config rewrite', () => {
    withLayers((cwd) => {
      const subrepo = path.join(cwd, 'api', '.git');
      fs.mkdirSync(subrepo, { recursive: true });
      const file = writeLayer(cwd, 'root', { multiRepo: true });
      const before = fs.readFileSync(file, 'utf8');
      const result = resolveConfigValue('planning.sub_repos', { cwd });
      assert.deepEqual(result.value, ['api']);
      assert.equal(result.layer, 'root');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
  });

  test('normalizes legacy keys per layer without writing to either file', () => {
    withLayers((cwd) => {
      const global = writeLayer(cwd, 'global-defaults', { base_branch: 'global' });
      const root = writeLayer(cwd, 'root', { base_branch: 'project' });
      const before = [fs.readFileSync(root, 'utf8'), fs.readFileSync(global, 'utf8')];
      const result = resolveConfigValue('git.base_branch', { cwd });
      assert.equal(result.value, 'project');
      assert.equal(result.layer, 'root');
      assert.deepEqual([fs.readFileSync(root, 'utf8'), fs.readFileSync(global, 'utf8')], before);
    });
  });
});

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { resolveConfigValue, CONFIG_LAYER_MAX_BYTES } = require('../gsd-core/bin/lib/config-value-resolver.cjs');
const { loadConfigResolved } = require('../gsd-core/bin/lib/config-loader.cjs');

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
    return run(cwd);
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function corruptLayer(cwd, layer) {
  const file = writeLayer(cwd, layer, {});
  fs.writeFileSync(file, '{not json', 'utf8');
  return file;
}

/** Run `fn` with stderr captured; returns only the unusable-config diagnostics. */
function captureConfigDiagnostics(fn) {
  const originalWrite = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.filter((chunk) => chunk.includes('its settings were NOT applied'));
}

/** A symlink this host may refuse (unprivileged Windows); false means skip, never pass. */
function trySymlink(target, linkPath, type) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return false;
    throw err;
  }
}

/** JSON text of exactly `size` bytes carrying `value`, padded through an extra field. */
function jsonOfSize(value, size) {
  const base = Buffer.byteLength(JSON.stringify({ ...value, pad: '' }));
  return JSON.stringify({ ...value, pad: 'x'.repeat(size - base) });
}

const LADDERS = {
  A: ['workstream', 'root', 'global-defaults'],
  B: ['runtime-local', 'runtime-shared', 'runtime-user'],
};
const SAMPLES = [false, 0, '', [], {}, null, true, 7, 'head', [1], { note: 'value' }];

function writeState(cwd, layer, key, state) {
  if (state.kind === 'absent') return;
  if (state.kind === 'corrupt') corruptLayer(cwd, layer);
  else if (state.kind === 'empty') writeLayer(cwd, layer, {});
  else if (state.kind === 'nullParent') writeLayer(cwd, layer, { [key.split('.')[0]]: null });
  else writeLayer(cwd, layer, setPath(key, state.value));
}

/**
 * The ADR-1411 ladder walk for a replacing key, written apart from the module: the
 * first layer holding the key wins; a non-object parent stops the files but not the
 * declared `fallback` (what an empty project resolves); an unusable layer counts only
 * above the winner.
 */
function expectedLadder(family, states, fallback) {
  let fault = null;
  let faults = 0;
  let empty = false;
  let workstreamMissing = false;
  for (const [index, state] of states.entries()) {
    const layer = LADDERS[family][index];
    if (state.kind === 'absent' || state.kind === 'corrupt') {
      if (layer === 'workstream') workstreamMissing = true;
      if (state.kind === 'corrupt') {
        fault ??= 'config_unparseable';
        faults += 1;
      }
      continue;
    }
    if (state.kind === 'empty') {
      empty = true;
      continue;
    }
    if (state.kind === 'nullParent') break;
    return {
      resolution: { found: true, value: state.value, layer,
        reason: fault ?? (layer === 'root' && workstreamMissing ? 'workstream_fallback' : 'resolved') },
      faults,
    };
  }
  if (fallback.found) return { resolution: { ...fallback, reason: fault ?? 'resolved' }, faults };
  return {
    resolution: { found: false, value: undefined, layer: null,
      reason: fault ?? (empty ? 'configured_empty' : 'not_configured') },
    faults,
  };
}

describe('Config Value Resolution Module (#5096)', () => {
  test('fast-check ladder property: value, layer, reason and diagnostics across both families', () => {
    const specs = [
      { key: 'project_code', family: 'A', dotted: false },
      { key: 'git.create_tag', family: 'A', dotted: true },
      { key: 'worktree.baseRef', family: 'B', dotted: true },
    ];
    // Central keys, so every JSON type is eligible (a federated key's type check has its own test).
    // Below every file: the builtin default, the schema default, and none at all.
    const fallbacks = new Map(specs.map((spec) =>
      [spec.key, withLayers((cwd) => resolveConfigValue(spec.key, { cwd }))]));
    assert.deepEqual([...fallbacks.values()].map((fallback) => fallback.layer),
      ['builtin-default', 'schema-default', null]);
    const layerState = (dotted) => fc.oneof(
      fc.constant({ kind: 'absent' }),
      fc.constant({ kind: 'empty' }),
      fc.constant({ kind: 'corrupt' }),
      fc.constantFrom(...SAMPLES).map((value) => ({ kind: 'value', value })),
      ...(dotted ? [fc.constant({ kind: 'nullParent' })] : []),
    );
    fc.assert(fc.property(
      fc.constantFrom(...specs).chain((spec) => fc.tuple(
        fc.constant(spec),
        fc.tuple(layerState(spec.dotted), layerState(spec.dotted), layerState(spec.dotted)),
      )),
      ([spec, states]) => {
        withLayers((cwd) => {
          LADDERS[spec.family].forEach((layer, index) => writeState(cwd, layer, spec.key, states[index]));
          let actual;
          const diagnostics = captureConfigDiagnostics(() => {
            actual = resolveConfigValue(spec.key, { cwd });
          });
          const expected = expectedLadder(spec.family, states, fallbacks.get(spec.key));
          assert.deepEqual(actual, expected.resolution);
          assert.equal(diagnostics.length, expected.faults);
        });
      },
    ));
  });

  test('fast-check merge property: per-leaf winners, producing layer and any-layer faults', () => {
    const layerState = fc.oneof(
      fc.constant({ kind: 'absent' }),
      fc.constant({ kind: 'corrupt' }),
      fc.subarray(['planner', 'executor', 'verifier'], { minLength: 1 }).map((leaves) => ({ kind: 'leaves', leaves })),
    );
    fc.assert(fc.property(fc.tuple(layerState, layerState, layerState), (states) => {
      withLayers((cwd) => {
        const value = {};
        const composite = {};
        let layer = null;
        let fault = null;
        let faults = 0;
        for (let index = LADDERS.A.length - 1; index >= 0; index--) {
          const name = LADDERS.A[index];
          const state = states[index];
          if (state.kind === 'corrupt') corruptLayer(cwd, name);
          if (state.kind !== 'leaves') continue;
          writeLayer(cwd, name, { model_overrides: Object.fromEntries(state.leaves.map((leaf) => [leaf, name])) });
          for (const leaf of state.leaves) {
            value[leaf] = name;
            composite[leaf] = name;
          }
          layer = name;
        }
        for (const state of states) {
          if (state.kind === 'corrupt') {
            fault ??= 'config_unparseable';
            faults += 1;
          }
        }
        let actual;
        const diagnostics = captureConfigDiagnostics(() => {
          actual = resolveConfigValue('model_overrides', { cwd });
        });
        // A merge key has no default, so a lower leaf joins the answer and its fault always counts.
        const expected = layer === null
          ? { found: false, value: undefined, layer: null, reason: fault ?? 'not_configured' }
          : { found: true, value, layer, composite,
            reason: fault ?? (layer === 'root' && states[0].kind !== 'leaves' ? 'workstream_fallback' : 'resolved') };
        assert.deepEqual(actual, expected);
        assert.equal(diagnostics.length, faults);
      });
    }));
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
      corruptLayer(cwd, 'workstream');
      const diagnostics = captureConfigDiagnostics(() => {
        for (let i = 0; i < 2; i++) {
          const result = resolveConfigValue('project_code', { cwd });
          assert.equal(result.value, 'working');
          assert.equal(result.layer, 'root');
          assert.equal(result.reason, 'config_unparseable');
        }
      });
      assert.equal(diagnostics.length, 1);
    });
  });

  test('an unusable layer below a healthy winner neither degrades the key nor warns', () => {
    withLayers((cwd) => {
      delete process.env.GSD_WORKSTREAM;
      writeLayer(cwd, 'root', { project_code: 'ABC' });
      corruptLayer(cwd, 'global-defaults');
      writeLayer(cwd, 'runtime-local', { worktree: { baseRef: 'local' } });
      corruptLayer(cwd, 'runtime-user');
      const diagnostics = captureConfigDiagnostics(() => {
        assert.deepEqual(resolveConfigValue('project_code', { cwd }), {
          found: true, value: 'ABC', layer: 'root', reason: 'resolved',
        });
        assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
          found: true, value: 'local', layer: 'runtime-local', reason: 'resolved',
        });
      });
      assert.deepEqual(diagnostics, []);
    });
  });

  test('an unusable layer above the winner degrades the key without promising defaults', () => {
    withLayers((cwd) => {
      const file = corruptLayer(cwd, 'runtime-shared');
      writeLayer(cwd, 'runtime-user', { worktree: { baseRef: 'user' } });
      const diagnostics = captureConfigDiagnostics(() => {
        assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
          found: true, value: 'user', layer: 'runtime-user', reason: 'config_unparseable',
        });
      });
      assert.equal(diagnostics.length, 1);
      assert.ok(diagnostics[0].includes(file));
      assert.ok(diagnostics[0].includes('this key resolves from the remaining layers instead'));
      assert.ok(!diagnostics[0].includes('using defaults'));
    });
  });

  test('a declared merge key is degraded by an unusable layer below its producing layer', () => {
    withLayers((cwd) => {
      writeLayer(cwd, 'workstream', { model_overrides: { planner: 'workstream' } });
      corruptLayer(cwd, 'global-defaults');
      let result;
      const diagnostics = captureConfigDiagnostics(() => {
        result = resolveConfigValue('model_overrides', { cwd });
      });
      assert.deepEqual(result, {
        found: true, value: { planner: 'workstream' }, layer: 'workstream',
        reason: 'config_unparseable', composite: { planner: 'workstream' },
      });
      assert.equal(diagnostics.length, 1);
    });
  });

  test('layer reads are bounded at limit-1, limit and limit+1 bytes', () => {
    for (const [size, readable] of [
      [CONFIG_LAYER_MAX_BYTES - 1, true],
      [CONFIG_LAYER_MAX_BYTES, true],
      [CONFIG_LAYER_MAX_BYTES + 1, false],
    ]) {
      withLayers((cwd) => {
        const file = writeLayer(cwd, 'runtime-shared', {});
        fs.writeFileSync(file, jsonOfSize({ worktree: { baseRef: 'sized' } }, size), 'utf8');
        assert.equal(fs.statSync(file).size, size);
        let result;
        const diagnostics = captureConfigDiagnostics(() => {
          result = resolveConfigValue('worktree.baseRef', { cwd });
        });
        if (readable) {
          assert.deepEqual(result, { found: true, value: 'sized', layer: 'runtime-shared', reason: 'resolved' });
          assert.deepEqual(diagnostics, []);
        } else {
          assert.deepEqual(result, { found: false, value: undefined, layer: null, reason: 'config_unreadable' });
          assert.equal(diagnostics.length, 1);
          assert.match(diagnostics[0], /could not be read \(EFBIG\)/);
        }
      });
    }
  });

  test('a repository layer symlinked outside its own directory is unreadable, not followed', (t) => {
    withLayers((cwd) => {
      delete process.env.GSD_WORKSTREAM;
      const outside = path.join(cwd, 'outside.json');
      fs.writeFileSync(outside, JSON.stringify({ project_code: 'FROM-OUTSIDE', worktree: { baseRef: 'FROM-OUTSIDE' } }));
      const rootFile = path.join(cwd, '.planning', 'config.json');
      const settingsFile = path.join(cwd, '.claude', 'settings.json');
      if (!trySymlink(outside, rootFile, 'file') || !trySymlink(outside, settingsFile, 'file')) {
        t.skip('this host refuses file symlinks');
        return;
      }
      const diagnostics = captureConfigDiagnostics(() => {
        assert.deepEqual(resolveConfigValue('project_code', { cwd }), {
          found: true, value: null, layer: 'builtin-default', reason: 'config_unreadable',
        });
        assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
          found: false, value: undefined, layer: null, reason: 'config_unreadable',
        });
      });
      assert.equal(diagnostics.length, 2);
      for (const diagnostic of diagnostics) assert.match(diagnostic, /could not be read \(EOUTSIDEROOT\)/);
    });
  });

  test('a symlinked planning or settings directory and a symlinked user file still resolve', (t) => {
    withLayers((cwd) => {
      delete process.env.GSD_WORKSTREAM;
      const store = path.join(cwd, 'store');
      writeJson(path.join(store, 'planning', 'config.json'), { project_code: 'stored' });
      writeJson(path.join(store, 'claude', 'settings.json'), { worktree: { baseRef: 'stored' } });
      writeJson(path.join(store, 'dotfiles', 'settings.json'), { worktree: { baseRef: 'dotfiles' } });
      if (!trySymlink(path.join(store, 'planning'), path.join(cwd, '.planning'), 'junction')
          || !trySymlink(path.join(store, 'claude'), path.join(cwd, '.claude'), 'junction')) {
        t.skip('this host refuses directory symlinks');
        return;
      }
      assert.deepEqual(resolveConfigValue('project_code', { cwd }), {
        found: true, value: 'stored', layer: 'root', reason: 'resolved',
      });
      assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
        found: true, value: 'stored', layer: 'runtime-shared', reason: 'resolved',
      });
      cleanup(path.join(cwd, '.claude'));
      if (!trySymlink(path.join(store, 'dotfiles', 'settings.json'),
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'file')) {
        t.skip('this host refuses file symlinks');
        return;
      }
      assert.deepEqual(resolveConfigValue('worktree.baseRef', { cwd }), {
        found: true, value: 'dotfiles', layer: 'runtime-user', reason: 'resolved',
      });
    });
  });

  test('a layer that is not a regular file is unreadable without being read', (t) => {
    if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) {
      t.skip('no character device to link on this host');
      return;
    }
    withLayers((cwd) => {
      if (!trySymlink('/dev/zero', path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'file')) {
        t.skip('this host refuses file symlinks');
        return;
      }
      let result;
      const diagnostics = captureConfigDiagnostics(() => {
        result = resolveConfigValue('worktree.baseRef', { cwd });
      });
      assert.deepEqual(result, { found: false, value: undefined, layer: null, reason: 'config_unreadable' });
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /could not be read \(ENXIO\)/);
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
      // The declared default is what loadConfig assembles for these same files.
      let assembled;
      captureConfigDiagnostics(() => {
        assembled = loadConfigResolved(cwd, { persist: false }).config;
      });
      assert.equal(assembled.workflow.research, schema.value);
      assert.equal(assembled.branching_strategy, builtin.value); // the loader flattens git.*
    });
  });

  test('any present non-object parent resolves what loadConfig assembles for the same files', () => {
    for (const parent of [null, 'text', [], 7, {}]) {
      withLayers((cwd) => {
        writeLayer(cwd, 'workstream', { workflow: parent });
        writeLayer(cwd, 'root', { workflow: { research: false } });
        let assembled;
        let resolution;
        captureConfigDiagnostics(() => {
          assembled = loadConfigResolved(cwd, { persist: false }).config.workflow.research;
          resolution = resolveConfigValue('workflow.research', { cwd });
        });
        // Only an object parent lets the root file's leaf through; every other parent stops it.
        const inherited = typeof parent === 'object' && parent !== null && !Array.isArray(parent);
        assert.equal(assembled, !inherited);
        assert.deepEqual(resolution, {
          found: true, value: assembled, layer: inherited ? 'root' : 'schema-default', reason: 'resolved',
        });
      });
    }
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
      // `root` names the active project's own config, as the loader's `source` does.
      assert.equal(result.layer, 'root');
      assert.equal(loadConfigResolved(cwd, { persist: false }).source, 'root');
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

  test('legacy multiRepo discovery is cached per resolution, including empty results', (t) => {
    withLayers((cwd) => {
      for (const layer of ['workstream', 'root', 'global-defaults']) {
        writeLayer(cwd, layer, { multiRepo: true });
      }
      const readdir = fs.readdirSync;
      let scans = 0;
      t.mock.method(fs, 'readdirSync', (dir, ...args) => {
        if (dir === cwd) scans += 1;
        return readdir.call(fs, dir, ...args);
      });
      resolveConfigValue('planning.sub_repos', { cwd });
      assert.equal(scans, 1, 'all legacy layers share one discovery, even when empty');
      fs.mkdirSync(path.join(cwd, 'api', '.git'), { recursive: true });
      const result = resolveConfigValue('planning.sub_repos', { cwd });
      assert.deepEqual(result.value, ['api']);
      assert.equal(result.layer, 'workstream');
      assert.equal(scans, 2, 'a new resolution must refresh filesystem discovery');
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

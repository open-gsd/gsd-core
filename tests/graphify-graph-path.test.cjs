'use strict';

// Tests for graphify `graph_path` config override (#1825) — a single umbrella
// graph serving multiple sibling projects.
//
// Boundary matrix (per the issue's acceptance criteria + triage outline):
//   (a) key unset → byte-identical default `.planning/graphs/graph.json`
//   (b) key set + file present → reads the CONFIGURED graph (not the default)
//   (c) key set + file missing → actionable error naming the path (no stack trace)
//   (d) relative path resolved against the project root (cwd)
//   + snapshot written alongside the configured graph
//   + build honors the key (graphs_dir = configured dir)
//   + VALID_CONFIG_KEYS contains graphify.graph_path

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const childProcess = require('child_process');
const { mock } = require('node:test');
const { createTempProject, cleanup } = require('./helpers.cjs');

const {
  graphifyQuery,
  graphifyStatus,
  graphifyDiff,
  graphifyBuild,
  writeSnapshot,
} = require('../gsd-core/bin/lib/graphify.cjs');

const { enableGraphify, SAMPLE_GRAPH } = require('./helpers/graphify.cjs');
const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

// ─── Fixtures (mirrors graphify-query.test.cjs surfaced-config-dir pattern) ────

function makeSurfacedConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-graph-path-cfg-'));
  fs.writeFileSync(
    path.join(dir, '.gsd-surface.json'),
    JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

function saveSurfacedEnv() {
  const saved = {
    GSD_RUNTIME: process.env.GSD_RUNTIME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
    GSD_PROJECT: process.env.GSD_PROJECT,
  };
  return {
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function setGraphPath(planningDir, relOrAbs) {
  const configPath = path.join(planningDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.graphify = config.graphify || {};
  config.graphify.graph_path = relOrAbs;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// A graph whose label is distinct from SAMPLE_GRAPH so we can prove which file was read.
const UMBRELLA_GRAPH = {
  nodes: [
    { id: 'u1', label: 'UmbrellaService', description: 'only present in the configured umbrella graph', type: 'service' },
    { id: 'u2', label: 'CrossRepoEdge', description: 'cross repo', type: 'model' },
  ],
  edges: [{ source: 'u1', target: 'u2', label: 'calls', confidence: 'EXTRACTED' }],
  hyperedges: [],
};

// ─── VALID_CONFIG_KEYS registration ───────────────────────────────────────────

describe('graphify.graph_path config key', () => {
  test('is registered in VALID_CONFIG_KEYS', () => {
    assert.ok(VALID_CONFIG_KEYS.has('graphify.graph_path'), 'graphify.graph_path must be a recognised config key');
  });
});

// ─── query ────────────────────────────────────────────────────────────────────

describe('graphify graph_path override — query', () => {
  let tmpDir, planningDir, cfgDir, env;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    cfgDir = makeSurfacedConfigDir();
    env = saveSurfacedEnv();
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    delete process.env.GSD_RUNTIME;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(cfgDir);
    env.restore();
  });

  test('(a) unset → reads default .planning/graphs/graph.json', () => {
    // Write the default graph and query it.
    fs.mkdirSync(path.join(planningDir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'graphs', 'graph.json'), JSON.stringify(SAMPLE_GRAPH), 'utf8');

    const result = graphifyQuery(tmpDir, 'AuthService');
    assert.ok(!('error' in result), 'default path must succeed');
    assert.ok(result.nodes.some((n) => n.label === 'AuthService'));
  });

  test('(b) set + present → reads the CONFIGURED graph, not the default', () => {
    // Place the default graph AND a distinct configured graph; prove the configured one wins.
    fs.mkdirSync(path.join(planningDir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'graphs', 'graph.json'), JSON.stringify(SAMPLE_GRAPH), 'utf8');

    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-q-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      fs.writeFileSync(abs, JSON.stringify(UMBRELLA_GRAPH), 'utf8');
      setGraphPath(planningDir, abs);

      const result = graphifyQuery(tmpDir, 'UmbrellaService');
      assert.ok(!('error' in result), 'configured path must succeed');
      assert.ok(result.nodes.some((n) => n.label === 'UmbrellaService'), 'must read the configured graph');
      assert.ok(!result.nodes.some((n) => n.label === 'AuthService'), 'must NOT read the default graph');
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('(c) set + missing → actionable error naming the configured path (no stack trace)', () => {
    const abs = path.join(tmpDir, 'does-not-exist.json');
    setGraphPath(planningDir, abs);

    const result = graphifyQuery(tmpDir, 'anything');
    assert.ok('error' in result, 'missing configured graph must return an error');
    assert.ok(result.error.includes(abs), 'error must name the configured absolute path');
    assert.ok(/graphify.graph_path|graphify build/i.test(result.error), 'error must be actionable');
  });

  test('(d) relative path resolved against the project root', () => {
    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-rel-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      fs.writeFileSync(abs, JSON.stringify(UMBRELLA_GRAPH), 'utf8');
      const rel = path.relative(tmpDir, abs); // e.g. '../gsd-umbrella-rel-XXX/graph.json'
      setGraphPath(planningDir, rel);

      const result = graphifyQuery(tmpDir, 'UmbrellaService');
      assert.ok(!('error' in result), 'relative configured path must resolve and succeed');
      assert.ok(result.nodes.some((n) => n.label === 'UmbrellaService'));
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('empty-string graph_path is treated as unset (falls back to default)', () => {
    setGraphPath(planningDir, '   ');
    fs.mkdirSync(path.join(planningDir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'graphs', 'graph.json'), JSON.stringify(SAMPLE_GRAPH), 'utf8');

    const result = graphifyQuery(tmpDir, 'AuthService');
    assert.ok(!('error' in result));
    assert.ok(result.nodes.some((n) => n.label === 'AuthService'), 'blank graph_path falls back to default');
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe('graphify graph_path override — status', () => {
  let tmpDir, planningDir, cfgDir, env;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    cfgDir = makeSurfacedConfigDir();
    env = saveSurfacedEnv();
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    delete process.env.GSD_RUNTIME;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(cfgDir);
    env.restore();
  });

  test('set + present → status reads the configured graph counts', () => {
    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-st-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      fs.writeFileSync(abs, JSON.stringify(UMBRELLA_GRAPH), 'utf8');
      setGraphPath(planningDir, abs);

      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.node_count, UMBRELLA_GRAPH.nodes.length);
      assert.strictEqual(result.edge_count, UMBRELLA_GRAPH.edges.length);
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('set + missing → exists:false with actionable message', () => {
    const abs = path.join(tmpDir, 'missing.json');
    setGraphPath(planningDir, abs);

    const result = graphifyStatus(tmpDir);
    assert.strictEqual(result.exists, false);
    assert.ok(result.message.includes(abs), 'status message must name the configured path');
  });
});

// ─── diff + writeSnapshot (snapshot travels with the configured graph) ────────

describe('graphify graph_path override — diff & snapshot', () => {
  let tmpDir, planningDir, cfgDir, env;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    cfgDir = makeSurfacedConfigDir();
    env = saveSurfacedEnv();
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    delete process.env.GSD_RUNTIME;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(cfgDir);
    env.restore();
  });

  test('writeSnapshot reads configured graph and writes the snapshot ALONGSIDE it', () => {
    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-snap-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      fs.writeFileSync(abs, JSON.stringify(UMBRELLA_GRAPH), 'utf8');
      setGraphPath(planningDir, abs);

      const result = writeSnapshot(tmpDir);
      assert.strictEqual(result.saved, true);
      // Snapshot lands next to the configured graph, NOT under the project default.
      const snapAlongside = path.join(umbrellaDir, '.last-build-snapshot.json');
      const snapDefault = path.join(planningDir, 'graphs', '.last-build-snapshot.json');
      assert.ok(fs.existsSync(snapAlongside), 'snapshot must be written alongside the configured graph');
      assert.ok(!fs.existsSync(snapDefault), 'snapshot must NOT be written under the project default when graph_path is set');
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('diff reads baseline + current from the configured directory', () => {
    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-diff-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      fs.writeFileSync(abs, JSON.stringify(UMBRELLA_GRAPH), 'utf8');
      setGraphPath(planningDir, abs);

      // First write a snapshot baseline (alongside configured graph).
      writeSnapshot(tmpDir);

      // Mutate the configured graph (add a node) so diff sees an addition.
      const evolved = JSON.parse(JSON.stringify(UMBRELLA_GRAPH));
      evolved.nodes.push({ id: 'u3', label: 'NewNode', description: 'added', type: 'service' });
      fs.writeFileSync(abs, JSON.stringify(evolved), 'utf8');

      const result = graphifyDiff(tmpDir);
      assert.ok(!('error' in result) && !result.no_baseline, 'diff must find the baseline alongside the configured graph');
      assert.strictEqual(result.nodes.added, 1);
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('unset → writeSnapshot writes to the default project graphs dir (byte-identical)', () => {
    fs.mkdirSync(path.join(planningDir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'graphs', 'graph.json'), JSON.stringify(SAMPLE_GRAPH), 'utf8');

    const result = writeSnapshot(tmpDir);
    assert.strictEqual(result.saved, true);
    assert.ok(fs.existsSync(path.join(planningDir, 'graphs', '.last-build-snapshot.json')), 'unset → default snapshot location');
  });
});

// ─── build (graphs_dir honors the key) ────────────────────────────────────────

describe('graphify graph_path override — build', () => {
  let tmpDir, planningDir, cfgDir, env;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    cfgDir = makeSurfacedConfigDir();
    env = saveSurfacedEnv();
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    delete process.env.GSD_RUNTIME;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    // Mock the graphify subprocess probes so build's pre-flight passes.
    mock.method(childProcess, 'spawnSync', (_cmd, args) => {
      if (args && args[0] === '--help') return { status: 0, stdout: 'Usage', stderr: '', error: undefined, signal: null };
      return { status: 0, stdout: '0.4.3\n', stderr: '', error: undefined, signal: null };
    });
  });

  afterEach(() => {
    mock.restoreAll();
    cleanup(tmpDir);
    cleanup(cfgDir);
    env.restore();
  });

  test('set → build stays project-scoped (graphs_dir is the default; umbrella graph is built in the umbrella project)', () => {
    // graphify.graph_path is a READ-path override only (#1825). Build always cp's
    // into the project's `.planning/graphs/` (the build skill hardcodes that dest),
    // so graphs_dir must reflect the real destination even when graph_path is set.
    const umbrellaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-umbrella-build-'));
    try {
      const abs = path.join(umbrellaDir, 'graph.json');
      setGraphPath(planningDir, abs);

      const result = graphifyBuild(tmpDir);
      assert.strictEqual(result.graphs_dir, path.join(planningDir, 'graphs'));
    } finally {
      cleanup(umbrellaDir);
    }
  });

  test('unset → graphs_dir is the default .planning/graphs (byte-identical)', () => {
    const result = graphifyBuild(tmpDir);
    assert.strictEqual(result.graphs_dir, path.join(planningDir, 'graphs'));
  });
});

'use strict';

// #1575 — Golden-parity harness (ADR-1235 §0).
//
// Asserts that the surface path (applySurface) produces byte-for-byte identical
// agent output to the install path (installRuntimeArtifacts) for every
// descriptor-driven runtime. Both paths run against the SAME configDir so
// pathPrefix, attribution, and converter outputs match.
//
// The harness:
//   1. installRuntimeArtifacts(runtime, configDir, 'global', profile, resolveAttribution)
//   2. Snapshot every gsd-* agent file in configDir/agents/
//   3. applySurface(configDir, layout, manifest, ..., opts)
//   4. Compare every agent file byte-for-byte: snapshot === current

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const COMMANDS_GSD = path.join(ROOT, 'commands', 'gsd');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { cleanup } = require('./helpers.cjs');

// The 7 descriptor-driven agent runtimes (cline deferred per code comment:
// rules-only local branch + local/global complication).
const DESCRIPTOR_RUNTIMES = [
  'cursor',
  'windsurf',
  'augment',
  'trae',
  'codebuddy',
  'copilot',
  'antigravity',
];

function snapshotAgents(agentsDir) {
  const snap = new Map();
  if (!fs.existsSync(agentsDir)) return snap;
  for (const name of fs.readdirSync(agentsDir)) {
    if (!name.startsWith('gsd-')) continue;
    if (!name.endsWith('.md') && !name.endsWith('.agent.md')) continue;
    snap.set(name, fs.readFileSync(path.join(agentsDir, name), 'utf8'));
  }
  return snap;
}

// Shared manifest + profile so both paths see the same source agents.
const manifest = loadSkillsManifest(COMMANDS_GSD);
const profile = resolveProfile({ modes: ['full'], manifest });
// Same attribution resolver for both paths (undefined → no Co-Authored-By mutation).
const resolveAttribution = () => undefined;

describe('#1575 — golden-parity: surface path matches install path for descriptor-driven agents', () => {

  for (const runtime of DESCRIPTOR_RUNTIMES) {
    test(`${runtime}: surface agents byte-identical to install agents`, (t) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-1575-${runtime}-`));
      t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

      // Step 1: install path writes agents
      installRuntimeArtifacts(runtime, configDir, 'global', profile, resolveAttribution);

      // Step 2: snapshot agent files
      const agentsDir = path.join(configDir, 'agents');
      const installSnap = snapshotAgents(agentsDir);
      assert.ok(installSnap.size > 0, `${runtime}: install must produce at least one gsd-* agent`);

      // Step 3: surface path re-materializes into the SAME configDir
      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
      applySurface(configDir, layout, manifest, undefined, undefined, { resolveAttribution });

      // Step 4: compare byte-for-byte
      const surfaceSnap = snapshotAgents(agentsDir);

      // File lists must match
      const installFiles = [...installSnap.keys()].sort();
      const surfaceFiles = [...surfaceSnap.keys()].sort();
      assert.deepEqual(
        surfaceFiles,
        installFiles,
        `${runtime}: file lists must match after surface. Install: [${installFiles.join(', ')}] Surface: [${surfaceFiles.join(', ')}]`,
      );

      // Content must match byte-for-byte
      for (const [fileName, installContent] of installSnap) {
        const surfaceContent = surfaceSnap.get(fileName);
        assert.strictEqual(
          surfaceContent,
          installContent,
          `${runtime}/${fileName}: surface content must be byte-identical to install content`,
        );
      }
    });
  }

  test('cursor with non-undefined attribution: surface agents byte-identical to install agents (M2 coverage)', (t) => {
    // M2 regression guard: verify parity holds when resolveAttribution returns
    // a real value. Source agents don't carry Co-Authored-By, so processAttribution
    // is a no-op (it replaces existing lines, doesn't add new ones). But this test
    // proves the agentCtx threading is correct for both paths regardless.
    const attrResolver = () => 'Test Bot <test@example.com>';
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-attr-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    installRuntimeArtifacts('cursor', configDir, 'global', profile, attrResolver);

    const agentsDir = path.join(configDir, 'agents');
    const installSnap = snapshotAgents(agentsDir);
    assert.ok(installSnap.size > 0, 'install must produce agents');

    const layout = resolveRuntimeArtifactLayout('cursor', configDir, 'global');
    applySurface(configDir, layout, manifest, undefined, undefined, { resolveAttribution: attrResolver });

    const surfaceSnap = snapshotAgents(agentsDir);
    for (const [fileName, installContent] of installSnap) {
      assert.strictEqual(surfaceSnap.get(fileName), installContent,
        `cursor/${fileName}: content must be byte-identical with non-undefined attribution`);
    }
  });

  test('copilot: agents installed as .agent.md (filename rename parity)', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-copilot-rename-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    installRuntimeArtifacts('copilot', configDir, 'global', profile, resolveAttribution);

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'copilot agents dir must exist');
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-'));
    assert.ok(agentFiles.length > 0, 'copilot must have installed agents');
    assert.ok(
      agentFiles.every((f) => f.endsWith('.agent.md')),
      `copilot agents must be .agent.md, got: [${agentFiles.slice(0, 3).join(', ')}]`,
    );
  });
});

describe('#1575 — surface path: no prune data-loss over pre-existing legacy agents', () => {
  test('pre-existing gsd-* agents not in staged set are pruned; user agents preserved', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1575-prune-'));
    t.after(() => { try { cleanup(configDir); } catch { /* best-effort */ } });

    // Seed a pre-existing legacy .agent.md (simulating a prior install)
    const agentsDir = path.join(configDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-old-defunct.agent.md'), '# Old\n');
    fs.writeFileSync(path.join(agentsDir, 'user-custom.md'), '# User\n');

    // Install (should prune stale gsd-*, preserve user agents)
    installRuntimeArtifacts('copilot', configDir, 'global', profile, resolveAttribution);

    const afterInstall = fs.readdirSync(agentsDir);
    assert.ok(!afterInstall.includes('gsd-old-defunct.agent.md'), 'stale gsd-* agent must be pruned');
    assert.ok(afterInstall.includes('user-custom.md'), 'user agent must be preserved');

    // Now surface over the install — must converge to the same state
    const layout = resolveRuntimeArtifactLayout('copilot', configDir, 'global');
    applySurface(configDir, layout, manifest, undefined, undefined, { resolveAttribution });

    const afterSurface = fs.readdirSync(agentsDir);
    // Same set of agent files as after install
    const installAgents = afterInstall.filter((f) => f.startsWith('gsd-')).sort();
    const surfaceAgents = afterSurface.filter((f) => f.startsWith('gsd-')).sort();
    assert.deepEqual(surfaceAgents, installAgents, 'surface must converge to same agent set as install');
    assert.ok(afterSurface.includes('user-custom.md'), 'user agent still preserved after surface');
  });
});

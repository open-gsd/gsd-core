'use strict';

// #4761 follow-up — W010's expected-agent set must follow `/gsd:surface`.
//
// applySurface() re-stages agents from the surface-resolved skills and prunes every other gsd-* agent file, so after a
// surface change the staged agent set is no longer the one the `.gsd-profile` marker alone derives. W010 read only the
// marker and reported every pruned agent as missing on a correct install.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(REPO, 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(REPO, 'gsd-core', 'workflows');
const AGENTS_SRC = path.join(REPO, 'agents');

const installProfiles = require('../gsd-core/bin/lib/install-profiles.cjs');
const surface = require('../gsd-core/bin/lib/surface.cjs');
const { checkAgentsInstalled } = require('../gsd-core/bin/lib/agent-install-check.cjs');
const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-catalog.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const ALL_AGENTS = Object.keys(MODEL_PROFILES);
const FULL_MANIFEST = installProfiles.loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
const AGENT_KEY = '_calls_agents_';

/** Skills a profile stages, derived the way the installer does (core: empty skill manifest). */
function baseSkills(profile) {
  const manifest = profile === 'core' ? new Map() : FULL_MANIFEST;
  const resolved = installProfiles.resolveProfile({ modes: [profile], manifest, agentManifest: FULL_MANIFEST, registry });
  // `full` resolves to the '*' sentinel: every skill stem in the manifest.
  if (resolved.skills === '*') return [...FULL_MANIFEST.keys()].filter((k) => !k.startsWith(AGENT_KEY)).sort();
  return [...resolved.skills].sort();
}

/** The derivation bin/install.js performs for `core`: an empty skill manifest, the real one for agents. */
function installerCoreAgents() {
  return installProfiles.resolveProfile({ modes: ['core'], manifest: new Map(), agentManifest: FULL_MANIFEST, registry }).agents;
}

/** Independent oracle: the catalog agents the given skills spawn, read straight from the manifest. */
function agentsOfSkills(skills) {
  const agents = new Set();
  for (const skill of skills) {
    for (const agent of FULL_MANIFEST.get(`${AGENT_KEY}${skill}`) || []) {
      if (ALL_AGENTS.includes(agent)) agents.add(agent);
    }
  }
  return [...agents].sort();
}

function makeConfigDir(t) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4761s-'));
  t.after(() => cleanup(cfg));
  fs.mkdirSync(path.join(cfg, 'agents'));
  return cfg;
}

function stage(cfg, names) {
  for (const name of names) {
    fs.copyFileSync(path.join(AGENTS_SRC, `${name}.md`), path.join(cfg, 'agents', `${name}.md`));
  }
}

function writeState(cfg, state) {
  surface.writeSurface(cfg, { disabledClusters: [], explicitAdds: [], explicitRemoves: [], ...state });
}

function check(cfg) {
  const prior = process.env.GSD_AGENTS_DIR;
  process.env.GSD_AGENTS_DIR = path.join(cfg, 'agents');
  try {
    return checkAgentsInstalled('claude', cfg);
  } finally {
    if (prior === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = prior;
  }
}

describe('#4761 W010 expected set follows /gsd:surface', () => {
  test('#4761 unmodified full surface expects every agent', (t) => {
    const cfg = makeConfigDir(t);
    writeState(cfg, { baseProfile: 'full' });
    assert.equal(installProfiles.agentsStagedByMarker(cfg), null);
    stage(cfg, ALL_AGENTS.filter((a) => a !== 'gsd-dom-verifier'));
    const r = check(cfg);
    assert.equal(r.agents_installed, false);
    assert.deepEqual(r.missing_agents, ['gsd-dom-verifier']);
  });

  test('#4761 a surface that removes every skill expects no agents', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'full');
    writeState(cfg, { baseProfile: 'full', explicitRemoves: baseSkills('full') });
    assert.equal(installProfiles.agentsStagedByMarker(cfg).size, 0);
    stage(cfg, ['gsd-planner']);
    const r = check(cfg);
    assert.equal(r.agents_installed, true);
    assert.deepEqual(r.missing_agents, []);
  });

  test('#4761 the surface state wins over the marker (core marker, standard surface)', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    writeState(cfg, { baseProfile: 'standard' });
    const expected = agentsOfSkills(baseSkills('standard'));
    assert.deepEqual(
      [...installProfiles.agentsStagedByMarker(cfg)].filter((a) => ALL_AGENTS.includes(a)).sort(),
      expected,
    );
  });

  test('#4761 a surface with no marker still filters', (t) => {
    const cfg = makeConfigDir(t);
    writeState(cfg, { baseProfile: 'core', explicitAdds: [] });
    const got = installProfiles.agentsStagedByMarker(cfg);
    assert.ok(got instanceof Set);
    const catalog = [...got].filter((a) => ALL_AGENTS.includes(a));
    assert.ok(catalog.length > 0 && catalog.length < ALL_AGENTS.length, 'a strict, non-empty subset of the catalog');
  });

  test('#4761 an unreadable surface file falls back to the marker', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    fs.writeFileSync(path.join(cfg, '.gsd-surface.json'), '{not json');
    const viaMarker = installProfiles.agentsStagedByMarker(cfg);
    assert.ok(viaMarker instanceof Set);
    const catalog = [...viaMarker].filter((a) => ALL_AGENTS.includes(a));
    assert.ok(catalog.length > 0 && catalog.length < ALL_AGENTS.length, 'a filtered marker set');
    assert.deepEqual([...viaMarker].sort(), [...installerCoreAgents()].sort());
  });

  test('#4761 a surface-pruned install is not degraded, and a missing agent is still flagged', (t) => {
    const cfg = makeConfigDir(t);
    const skills = baseSkills('standard');
    const kept = skills.slice(0, 3);
    installProfiles.writeActiveProfile(cfg, 'standard');
    writeState(cfg, { baseProfile: 'standard', explicitRemoves: skills.filter((s) => !kept.includes(s)) });
    const expected = agentsOfSkills(kept);
    assert.ok(expected.length < agentsOfSkills(skills).length, 'fixture must prune at least one agent');
    stage(cfg, expected);
    const healthy = check(cfg);
    assert.equal(healthy.agents_installed, true);
    assert.deepEqual(healthy.missing_agents, []);
    if (expected.length > 0) {
      fs.unlinkSync(path.join(cfg, 'agents', `${expected[0]}.md`));
      const broken = check(cfg);
      assert.equal(broken.agents_installed, false);
      assert.deepEqual(broken.missing_agents, [expected[0]]);
    }
  });

  for (const { baseProfile, withMarker } of [
    { baseProfile: 'standard', withMarker: true },
    { baseProfile: 'core', withMarker: true },
    { baseProfile: 'core', withMarker: false },
  ]) {
    test(`#6715 the check agrees with the agent files the surface writer leaves (${baseProfile}, marker: ${withMarker})`, (t) => {
      const cfg = makeConfigDir(t);
      stage(cfg, ALL_AGENTS); // a full install, as the surface writer finds it
      if (withMarker) installProfiles.writeActiveProfile(cfg, baseProfile);
      const state = {
        baseProfile,
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: baseSkills(baseProfile).filter((_, i) => i % 2 === 0),
      };
      writeState(cfg, state);
      // The writer's own pieces: the agent stager and the pruning sync applySurface calls, fed what applySurface feeds them.
      const resolved = surface.resolveSurface(cfg, FULL_MANIFEST, undefined, registry, state);
      const staged = installProfiles.stageAgentsForProfile(AGENTS_SRC, resolved);
      const agentsDir = path.join(cfg, 'agents');
      surface._syncGsdDir(staged, agentsDir, 'agents', FULL_MANIFEST);
      const onDisk = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
      assert.ok(onDisk.length > 0 && onDisk.length < ALL_AGENTS.length, 'fixture must prune some agents and keep some');
      const r = check(cfg);
      assert.deepEqual(r.missing_agents, [], 'no pruned agent is reported missing');
      assert.equal(r.agents_installed, true);
      assert.deepEqual([...r.installed_agents].sort(), onDisk.filter((a) => ALL_AGENTS.includes(a)));
      // And a kept agent that goes missing is still reported.
      const kept = onDisk.filter((a) => ALL_AGENTS.includes(a))[0];
      fs.unlinkSync(path.join(agentsDir, `${kept}.md`));
      assert.deepEqual(check(cfg).missing_agents, [kept]);
    });
  }

  test('#6715 the surface state file name matches the one the writer produces', (t) => {
    const cfg = makeConfigDir(t);
    writeState(cfg, { baseProfile: 'standard', explicitRemoves: ['help'] });
    assert.ok(fs.existsSync(path.join(cfg, '.gsd-surface.json')));
  });

  test('#6715 a marker-only install is unchanged by the surface lookup', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    const got = [...installProfiles.agentsStagedByMarker(cfg)].sort();
    assert.deepEqual(got, [...installerCoreAgents()].sort());
  });

  test('#4761 property: expected agents are exactly those the remaining skills spawn', () => {
    const skills = baseSkills('standard');
    fc.assert(
      fc.property(fc.subarray(skills), (removed) => {
        const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4761s-p-'));
        try {
          fs.mkdirSync(path.join(cfg, 'agents'));
          installProfiles.writeActiveProfile(cfg, 'standard');
          writeState(cfg, { baseProfile: 'standard', explicitRemoves: removed });
          const expected = agentsOfSkills(skills.filter((s) => !removed.includes(s)));
          stage(cfg, expected);
          const r = check(cfg);
          assert.deepEqual(r.missing_agents, []);
          assert.equal(r.agents_installed, true);
          if (expected.length > 0) {
            fs.unlinkSync(path.join(cfg, 'agents', `${expected[0]}.md`));
            assert.deepEqual(check(cfg).missing_agents, [expected[0]]);
          }
        } finally {
          cleanup(cfg);
        }
      }),
    );
  });
});

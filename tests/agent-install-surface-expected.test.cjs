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
  return [...resolved.skills].sort();
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
    assert.ok(got instanceof Set && got.size < ALL_AGENTS.length);
  });

  test('#4761 an unreadable surface file falls back to the marker', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    fs.writeFileSync(path.join(cfg, '.gsd-surface.json'), '{not json');
    const viaMarker = [...installProfiles.agentsStagedByMarker(cfg)].sort();
    fs.unlinkSync(path.join(cfg, '.gsd-surface.json'));
    assert.deepEqual([...installProfiles.agentsStagedByMarker(cfg)].sort(), viaMarker);
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

  test('#4761 expected set equals what applySurface stages (parity with the writer)', (t) => {
    const cfg = makeConfigDir(t);
    const skills = baseSkills('standard');
    const state = { baseProfile: 'standard', disabledClusters: [], explicitAdds: [], explicitRemoves: skills.slice(3) };
    writeState(cfg, state);
    const resolved = surface.resolveSurface(cfg, FULL_MANIFEST, undefined, registry, state);
    assert.deepEqual(
      [...installProfiles.agentsStagedByMarker(cfg)].sort(),
      [...resolved.agents].sort(),
    );
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
        } finally {
          cleanup(cfg);
        }
      }),
    );
  });
});

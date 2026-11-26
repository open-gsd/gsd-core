'use strict';

// #4761 — W010's expected-agent set must follow the install profile, and the
// `intel` capability must claim the agent it documents.
//
// checkAgentsInstalled() expected every MODEL_PROFILES agent regardless of the
// `.gsd-profile` marker. A tiered (core/standard) install deliberately stages
// only the agents its skills spawn (stageAgentsForProfile), so a correct,
// untouched tiered install reported degraded health on every omitted agent.

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
const { checkAgentsInstalled } = require('../gsd-core/bin/lib/agent-install-check.cjs');
const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-catalog.cjs');
const registryMod = require('../gsd-core/bin/lib/capability-registry.cjs');
const healthRule = require('../gsd-core/bin/lib/health-diagnostic-rules/agent-install.cjs');

const ALL_AGENTS = Object.keys(MODEL_PROFILES);

/** The derivation bin/install.js performs at install(): core gets an empty skill manifest. */
function installerAgents(profileName) {
  const full = installProfiles.loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
  const manifest = profileName === 'core' ? new Map() : full;
  return installProfiles.resolveProfile({ modes: [profileName], manifest, agentManifest: full }).agents;
}

/** Installer shape for a composed marker: not the `core` alias, so the real manifest drives skills and agents. */
function installerComposedAgents(marker) {
  const full = installProfiles.loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
  return installProfiles.resolveProfile({ modes: [marker], manifest: full, agentManifest: full }).agents;
}

/** A staged-agent set restricted to catalog agents (the set the check iterates). */
function catalogAgents(agents) {
  return [...agents].filter((a) => ALL_AGENTS.includes(a));
}

function makeConfigDir(t) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4761-'));
  t.after(() => cleanup(cfg));
  fs.mkdirSync(path.join(cfg, 'agents'));
  return cfg;
}

function stage(cfg, names) {
  for (const name of names) {
    fs.copyFileSync(path.join(AGENTS_SRC, `${name}.md`), path.join(cfg, 'agents', `${name}.md`));
  }
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

describe('#4761 intel capability claims gsd-intel-updater', () => {
  test('#4761 intel capability claims gsd-intel-updater', () => {
    const reg = registryMod.CAPABILITY_REGISTRY || registryMod;
    assert.equal(reg.byAgent['gsd-intel-updater'], 'intel');
    assert.ok(reg.capabilities.intel.agents.includes('gsd-intel-updater'));
  });

  test('#4761 claim does not alter tiered staging', () => {
    const reg = registryMod.CAPABILITY_REGISTRY || registryMod;
    const full = installProfiles.loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
    for (const mode of ['core', 'standard']) {
      const manifest = mode === 'core' ? new Map() : full;
      const without = installProfiles.resolveProfile({ modes: [mode], manifest, agentManifest: full }).agents;
      const withRegistry = installProfiles.resolveProfile({ modes: [mode], manifest, agentManifest: full, registry: reg }).agents;
      assert.deepEqual([...withRegistry].sort(), [...without].sort(), `${mode}: the shipped registry (claims included) adds no agents`);
    }
  });
});

describe('#4761 W010 expected set follows the install profile', () => {
  test('#4761 no marker expects every agent', (t) => {
    const cfg = makeConfigDir(t);
    stage(cfg, ALL_AGENTS);
    const r = check(cfg);
    assert.equal(r.agents_installed, true);
    assert.deepEqual(r.missing_agents, []);
    assert.equal(r.installed_agents.length, ALL_AGENTS.length);
  });

  test('#4761 full profile still reports a missing agent', (t) => {
    const cfg = makeConfigDir(t);
    stage(cfg, ALL_AGENTS.filter((a) => a !== 'gsd-dom-verifier'));
    installProfiles.writeActiveProfile(cfg, 'full');
    const r = check(cfg);
    assert.equal(r.agents_installed, false);
    assert.deepEqual(r.missing_agents, ['gsd-dom-verifier']);
  });

  for (const profile of ['core', 'standard']) {
    test(`#4761 ${profile} install is not degraded`, (t) => {
      const cfg = makeConfigDir(t);
      const staged = catalogAgents(installerAgents(profile));
      assert.ok(staged.length > 0 && staged.length < ALL_AGENTS.length, 'fixture must be a strict tiered subset');
      stage(cfg, staged);
      installProfiles.writeActiveProfile(cfg, profile);
      const r = check(cfg);
      assert.equal(r.agents_installed, true);
      assert.deepEqual(r.missing_agents, []);
      assert.deepEqual([...r.installed_agents].sort(), [...staged].sort());
    });
  }

  test('#4761 tiered install still flags a missing staged agent', (t) => {
    const cfg = makeConfigDir(t);
    const staged = catalogAgents(installerAgents('core')).sort();
    const dropped = staged[0];
    stage(cfg, staged.filter((a) => a !== dropped));
    installProfiles.writeActiveProfile(cfg, 'core');
    const r = check(cfg);
    assert.equal(r.agents_installed, false);
    assert.deepEqual(r.missing_agents, [dropped]);
  });

  test('#4761 tiered incomplete detection survives', (t) => {
    const cfg = makeConfigDir(t);
    const staged = catalogAgents(installerAgents('core')).sort();
    stage(cfg, staged);
    installProfiles.writeActiveProfile(cfg, 'core');
    const tracked = staged[0];
    fs.writeFileSync(
      path.join(cfg, 'gsd-file-manifest.json'),
      JSON.stringify({ version: '1', files: { [`agents/${tracked}.md`]: 'x', [`agents/${tracked}.toml`]: 'y' } }),
    );
    const r = check(cfg);
    assert.deepEqual(r.incomplete_agents, [tracked]);
    assert.equal(r.agents_installed, false);
  });

  test('#4761 composed marker expects union', (t) => {
    const cfg = makeConfigDir(t);
    const staged = catalogAgents(installerComposedAgents('core,standard'));
    stage(cfg, staged);
    installProfiles.writeActiveProfile(cfg, 'core,standard');
    const r = check(cfg);
    assert.equal(r.agents_installed, true);
    assert.deepEqual(r.missing_agents, []);
  });

  for (const marker of ['!!bad', '', '   ', 'nosuch']) {
    test(`#4761 unusable marker ${JSON.stringify(marker)} falls back to every agent`, (t) => {
      const cfg = makeConfigDir(t);
      stage(cfg, catalogAgents(installerAgents('core')));
      fs.writeFileSync(path.join(cfg, '.gsd-profile'), `${marker}\n`);
      const r = check(cfg);
      assert.equal(r.agents_installed, false);
      assert.ok(r.missing_agents.length > 0);
      assert.deepEqual([...r.missing_agents, ...r.installed_agents].sort(), [...ALL_AGENTS].sort());
    });
  }

  test('#4761 missing agents dir reports only profile set', (t) => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4761-'));
    t.after(() => cleanup(cfg));
    installProfiles.writeActiveProfile(cfg, 'core');
    const r = check(cfg);
    assert.equal(r.agents_installed, false);
    assert.deepEqual([...r.missing_agents].sort(), catalogAgents(installerAgents('core')).sort());
  });

  test('#4761 empty expected set is healthy', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    const prior = process.env.GSD_AGENTS_DIR;
    process.env.GSD_AGENTS_DIR = path.join(cfg, 'agents');
    try {
      const r = checkAgentsInstalled('claude', cfg, { stagedAgents: () => new Set() });
      assert.equal(r.agents_installed, true);
      assert.deepEqual(r.missing_agents, []);
    } finally {
      if (prior === undefined) delete process.env.GSD_AGENTS_DIR;
      else process.env.GSD_AGENTS_DIR = prior;
    }
  });

  test('#4761 a throwing derivation degrades to every agent', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    const prior = process.env.GSD_AGENTS_DIR;
    process.env.GSD_AGENTS_DIR = path.join(cfg, 'agents');
    try {
      const r = checkAgentsInstalled('claude', cfg, { stagedAgents: () => { throw new Error('boom'); } });
      assert.equal(r.agents_installed, false);
      assert.equal(r.missing_agents.length, ALL_AGENTS.length);
    } finally {
      if (prior === undefined) delete process.env.GSD_AGENTS_DIR;
      else process.env.GSD_AGENTS_DIR = prior;
    }
  });

  test('#4761 W010 silent on a healthy core install', (t) => {
    const cfg = makeConfigDir(t);
    stage(cfg, catalogAgents(installerAgents('core')));
    installProfiles.writeActiveProfile(cfg, 'core');
    const status = check(cfg);
    const rule = healthRule.RULES[0];
    const diags = rule.check({ agentInstall: { value: status, scope: 'complete' } });
    assert.deepEqual(diags, []);
  });
});

describe('#4761 agentsStagedByMarker', () => {
  test('#4761 no source manifest degrades to full', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    const got = installProfiles.agentsStagedByMarker(cfg, {
      commandsDirs: [path.join(cfg, 'does-not-exist')],
      workflowsDir: WORKFLOWS_DIR,
    });
    assert.equal(got, null);
  });

  test('#4761 installed layout candidate is used', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'standard');
    const got = installProfiles.agentsStagedByMarker(cfg, {
      commandsDirs: [path.join(cfg, 'does-not-exist'), COMMANDS_DIR],
      workflowsDir: WORKFLOWS_DIR,
    });
    assert.deepEqual([...got].sort(), [...installerAgents('standard')].sort());
  });

  test('#4761 a capability with core membership widens the expected set like the installer', (t) => {
    const cfg = makeConfigDir(t);
    installProfiles.writeActiveProfile(cfg, 'core');
    const registry = {
      capabilityClusters: { widen: ['review'] },
      profileMembership: { widen: { tier: 'core', profiles: ['core'] } },
    };
    const full = installProfiles.loadSkillsManifest(COMMANDS_DIR, WORKFLOWS_DIR);
    const installer = installProfiles.resolveProfile({ modes: ['core'], manifest: new Map(), agentManifest: full, registry }).agents;
    const got = installProfiles.agentsStagedByMarker(cfg, { registry });
    assert.deepEqual([...got].sort(), [...installer].sort());
    for (const agent of installerAgents('core')) assert.ok(got.has(agent), `${agent} still expected`);
  });

  test('#4761 marker read boundary: limit, limit+1, directory, empty', (t) => {
    const cfg = makeConfigDir(t);
    const marker = path.join(cfg, '.gsd-profile');
    const limit = 4096;
    fs.writeFileSync(marker, `${'a'.repeat(limit - 1)}\n`);
    assert.equal(installProfiles.readActiveProfile(cfg), 'a'.repeat(limit - 1), 'at the limit is read');
    fs.writeFileSync(marker, `${'a'.repeat(limit)}\n`);
    assert.equal(installProfiles.readActiveProfile(cfg), null, 'limit+1 is refused');
    fs.unlinkSync(marker);
    fs.mkdirSync(marker);
    assert.equal(installProfiles.readActiveProfile(cfg), null, 'a non-regular marker is refused');
    fs.rmdirSync(marker);
    fs.writeFileSync(marker, '');
    assert.equal(installProfiles.readActiveProfile(cfg), null, 'empty is no marker');
  });

  test('#4761 no marker and full marker mean no filtering', (t) => {
    const cfg = makeConfigDir(t);
    assert.equal(installProfiles.agentsStagedByMarker(cfg), null);
    installProfiles.writeActiveProfile(cfg, 'full');
    assert.equal(installProfiles.agentsStagedByMarker(cfg), null);
  });

  test('#4761 helper matches installer resolveProfile shape', (t) => {
    for (const marker of ['core', 'standard', 'core,standard']) {
      const cfg = makeConfigDir(t);
      installProfiles.writeActiveProfile(cfg, marker);
      const got = installProfiles.agentsStagedByMarker(cfg);
      const expected = marker.includes(',') ? installerComposedAgents(marker) : installerAgents(marker);
      assert.deepEqual([...got].sort(), [...expected].sort(), marker);
    }
  });

  test('#4761 property: missing equals removed staged agents', () => {
    const staged = catalogAgents(installerAgents('standard')).sort();
    fc.assert(
      fc.property(fc.subarray(staged), (removed) => {
        const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4761-p-'));
        try {
          fs.mkdirSync(path.join(cfg, 'agents'));
          stage(cfg, staged.filter((a) => !removed.includes(a)));
          installProfiles.writeActiveProfile(cfg, 'standard');
          const r = check(cfg);
          assert.deepEqual([...r.missing_agents].sort(), [...removed].sort());
          assert.equal(r.agents_installed, removed.length === 0);
        } finally {
          cleanup(cfg);
        }
      }),
    );
  });
});

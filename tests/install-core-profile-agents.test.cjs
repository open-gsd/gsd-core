/**
 * #5503 — a core/minimal install must stage the agents its own skills spawn.
 *
 * The core profile skips the skills `requires:` closure on purpose (its skill set is exactly the eight
 * `PROFILES.core` skills), but the same empty manifest also emptied the agent set, so `/gsd-plan-phase`
 * and friends failed with "agent type not found". Agents are now derived from the real manifest while the
 * skill set stays unchanged.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { runMinimalInstall, manifestSkillSet } = require('./helpers/install-shared.cjs');
const {
  PROFILES,
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const REPO = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO, 'agents');

// Agents the issue names, spawned by name from the core skills' workflows.
const REQUIRED_CORE_AGENTS = [
  'gsd-roadmapper',
  'gsd-planner',
  'gsd-plan-checker',
  'gsd-phase-researcher',
  'gsd-executor',
  'gsd-verifier',
];

const manifest = loadSkillsManifest();

/** Agents referenced by the eight core skills, straight from the real manifest. */
function expectedCoreAgents() {
  const out = new Set();
  for (const stem of PROFILES.core) {
    for (const agent of manifest.get(`_calls_agents_${stem}`) || []) out.add(agent);
  }
  return out;
}

function allAgentStems() {
  return fs.readdirSync(AGENTS_DIR)
    .filter((f) => f.startsWith('gsd-') && f.endsWith('.md') && !f.endsWith('.compact.md'))
    .map((f) => f.slice(0, -3));
}

function installedAgentStems(configDir) {
  const dir = path.join(configDir, 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

describe('#5503 core profile stages the agents its skills spawn', () => {
  const expected = [...expectedCoreAgents()].sort();

  test('precondition: the real manifest says the core skills spawn the six named agents', () => {
    for (const agent of REQUIRED_CORE_AGENTS) {
      assert.ok(expected.includes(agent), `${agent} must be referenced by a core skill, got ${JSON.stringify(expected)}`);
    }
  });

  for (const [label, extraArgs] of [
    ['--profile=core', ['--profile=core']],
    ['--minimal', ['--minimal']],
  ]) {
    describe(`claude --global ${label}`, () => {
      test(`${label} stages the agents the core skills spawn`, () => {
        const { manifest: installManifest, configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global', extraArgs });
        try {
          const installed = installedAgentStems(configDir);
          for (const agent of REQUIRED_CORE_AGENTS) {
            assert.ok(installed.includes(agent), `${label}: ${agent} must be installed, got ${JSON.stringify(installed)}`);
          }
          assert.deepStrictEqual(installed, expected, `${label}: installed agents must be exactly the agents the core skills reference`);

          // Independence: closing over the real manifest must not widen the skill set.
          assert.deepStrictEqual(
            [...manifestSkillSet(installManifest)].sort(),
            [...PROFILES.core].sort(),
            `${label}: the core skill set must stay exactly the eight core skills`,
          );
        } finally {
          cleanup(root);
        }
      });

      test(`${label} stages only the agents its skills reference, not the full roster`, () => {
        const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global', extraArgs });
        try {
          const installed = new Set(installedAgentStems(configDir));
          const notReferenced = allAgentStems().filter((a) => !expected.includes(a));
          assert.ok(notReferenced.length > 0, 'precondition: some agent is not spawned by any core skill');
          for (const agent of notReferenced) {
            assert.ok(!installed.has(agent), `${label}: ${agent} is not spawned by a core skill and must not be staged`);
          }
        } finally {
          cleanup(root);
        }
      });
    });
  }

  test('codex core agent source matches the profile, not the whole roster', () => {
    const { configDir, root } = runMinimalInstall({ runtime: 'codex', scope: 'global', extraArgs: ['--profile=core'] });
    try {
      const tomlPath = path.join(configDir, 'config.toml');
      assert.ok(fs.existsSync(tomlPath), 'codex install must write config.toml');
      const toml = fs.readFileSync(tomlPath, 'utf8');
      const registered = [...toml.matchAll(/^\[agents\.(gsd-[A-Za-z0-9-]+)\]/gm)].map((m) => m[1]).sort();
      for (const agent of REQUIRED_CORE_AGENTS) {
        assert.ok(registered.includes(agent), `codex core: ${agent} must be registered, got ${JSON.stringify(registered)}`);
      }
      assert.deepStrictEqual(registered, expected, 'codex core registers exactly the agents the core skills reference');
    } finally {
      cleanup(root);
    }
  });

  describe('resolveProfile agentManifest', () => {
    test('derives agents from agentManifest without widening the skill set', () => {
      const resolved = resolveProfile({ modes: ['core'], manifest: new Map(), agentManifest: manifest });
      assert.deepStrictEqual([...resolved.skills].sort(), [...PROFILES.core].sort());
      assert.deepStrictEqual([...resolved.agents].sort(), expected);
    });

    test('without agentManifest agents come from the closure manifest exactly as before', () => {
      const resolved = resolveProfile({ modes: ['core'], manifest: new Map() });
      assert.equal(resolved.agents.size, 0, 'the empty-manifest default is unchanged');
      const standard = resolveProfile({ modes: ['standard'], manifest });
      assert.ok(standard.agents.size > 0, 'a tiered profile still derives agents from its own closure');
    });
  });
});

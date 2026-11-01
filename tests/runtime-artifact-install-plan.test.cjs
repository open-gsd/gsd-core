'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimeArtifactInstallPlan, createRuntimeArtifactUninstallPlan } = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const { cleanup } = require('./helpers.cjs');

function kind(name, destSubpath, stagedDir, calls) {
  return {
    kind: name,
    destSubpath,
    prefix: 'gsd-',
    stage: (resolvedProfile) => {
      calls.push([name, resolvedProfile.name]);
      return stagedDir;
    },
  };
}

describe('createRuntimeArtifactInstallPlan', () => {
  test('stages layout kinds in order and projects rewritten source dirs', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const calls = [];
    const rewriteCalls = [];
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        kind('commands', 'commands', '/tmp/staged-commands', calls),
        kind('agents', 'agents', '/tmp/staged-agents', calls),
        kind('skills', 'skills', '/tmp/staged-skills', calls),
        kind('kimi-agents', 'agents', '/tmp/staged-kimi-agents', calls),
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedSkillBodies: (stagedDir, opts) => {
          rewriteCalls.push(['skills', stagedDir, opts.runtime, opts.configDir, opts.scope]);
          return stagedDir;
        },
        rewriteStagedCommandBodies: (stagedDir, opts) => {
          rewriteCalls.push(['commands', stagedDir, opts.runtime, opts.configDir, opts.scope]);
          return `${stagedDir}-rewritten`;
        },
      },
    });

    assert.deepStrictEqual(calls, [
      ['commands', 'core'],
      ['agents', 'core'],
      ['skills', 'core'],
      ['kimi-agents', 'core'],
    ]);
    assert.deepStrictEqual(rewriteCalls, [
      ['commands', '/tmp/staged-commands', 'claude', configDir, 'global'],
      ['skills', '/tmp/staged-skills', 'claude', configDir, 'global'],
      ['skills', '/tmp/staged-kimi-agents', 'claude', configDir, 'global'],
    ]);
    assert.deepStrictEqual(result, {
      ok: true,
      plan: {
        cleanupDirs: ['/tmp/staged-commands-rewritten'],
        items: [
          { kind: 'commands', sourceDir: '/tmp/staged-commands-rewritten', destDir: path.join(configDir, 'commands') },
          { kind: 'agents', sourceDir: '/tmp/staged-agents', destDir: path.join(configDir, 'agents') },
          { kind: 'skills', sourceDir: '/tmp/staged-skills', destDir: path.join(configDir, 'skills') },
          { kind: 'kimi-agents', sourceDir: '/tmp/staged-kimi-agents', destDir: path.join(configDir, 'agents') },
        ],
      },
    });
  });

  test('returns stage_failed when a layout kind stage adapter throws', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        {
          kind: 'skills',
          destSubpath: 'skills',
          stage: () => { throw new Error('stage boom'); },
        },
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedSkillBodies: () => { throw new Error('must not rewrite after stage failure'); },
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'stage_failed');
    assert.strictEqual(result.failedKind, 'skills');
    assert.strictEqual(result.message, 'stage boom');
    assert.deepStrictEqual(result.cleanupDirs, []);
  });

  test('returns rewrite_failed with prior cleanup obligations when conversion throws', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const calls = [];
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        kind('commands', 'commands', '/tmp/staged-commands', calls),
        kind('skills', 'skills', '/tmp/staged-skills', calls),
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedCommandBodies: (stagedDir) => `${stagedDir}-rewritten`,
        rewriteStagedSkillBodies: () => { throw new Error('rewrite boom'); },
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'rewrite_failed');
    assert.strictEqual(result.failedKind, 'skills');
    assert.strictEqual(result.message, 'rewrite boom');
    assert.deepStrictEqual(result.cleanupDirs, ['/tmp/staged-commands-rewritten']);
  });

  test('uses real command rewrite seam by default', (t) => {
    const stagedCommands = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-plan-commands-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-plan-config-'));
    t.after(() => {
      cleanup(stagedCommands);
      cleanup(configDir);
    });
    fs.writeFileSync(path.join(stagedCommands, 'help.md'), '# help\n');
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [kind('commands', 'commands', stagedCommands, [])],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      resolveAttribution: () => undefined,
      homedir: () => '/Users/example',
      platform: 'linux',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.plan.items.length, 1);
    assert.strictEqual(result.plan.items[0].kind, 'commands');
    assert.notStrictEqual(result.plan.items[0].sourceDir, stagedCommands);
    assert.ok(fs.existsSync(path.join(result.plan.items[0].sourceDir, 'help.md')));
    assert.deepStrictEqual(result.plan.cleanupDirs, [result.plan.items[0].sourceDir]);
    for (const dir of result.plan.cleanupDirs) cleanup(dir);
  });
});

describe('#5179 uninstall plan install roots', () => {
  test('an empty-string home falls back to configDir', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-uninstall-plan-config');
    const plan = createRuntimeArtifactUninstallPlan({
      runtime: 'claude', configDir, scope: 'local',
      kinds: [{ kind: 'agents', home: '', destSubpath: 'agents' }],
    });
    assert.deepStrictEqual(plan.items, [{ kind: 'agents', destDir: path.join(configDir, 'agents') }]);
  });

  test('a valid home keeps its alternate destination', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-uninstall-plan-config');
    const alternateHome = path.join(os.tmpdir(), 'gsd-uninstall-plan-alternate');
    const plan = createRuntimeArtifactUninstallPlan({
      runtime: 'claude', configDir, scope: 'local',
      kinds: [{ kind: 'agents', home: alternateHome, destSubpath: 'agents' }],
    });
    assert.deepStrictEqual(plan.items, [{ kind: 'agents', destDir: path.join(alternateHome, 'agents') }]);
  });
});

describe('#5179 plan roots reject malformed homes', () => {
  for (const home of [false, 42]) {
    for (const operation of ['install', 'uninstall']) {
      test(`${operation} plan rejects home: ${home}`, () => {
        const layout = {
          runtime: 'claude', configDir: path.join(os.tmpdir(), 'gsd-invalid-home'), scope: 'local',
          kinds: [{ kind: 'agents', home, destSubpath: 'agents', stage: () => '/tmp/staged-agents' }],
        };
        assert.throws(() => operation === 'install'
          ? createRuntimeArtifactInstallPlan({ layout, resolvedProfile: { name: 'core' } })
          : createRuntimeArtifactUninstallPlan(layout), { name: 'TypeError' });
      });
    }
  }
});

describe('#5179 direct preflight decisions', () => {
  const plan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  const fc = require('./helpers/fast-check-setup.cjs');

  test('shouldInstallCombinedFamily follows the declared family flag', () => {
    assert.equal(plan.shouldInstallCombinedFamily({}), false);
    assert.equal(plan.shouldInstallCombinedFamily({ combinedFamilyInstall: false }), false);
    assert.equal(plan.shouldInstallCombinedFamily({ combinedFamilyInstall: true }), true);
  });

  test('isLegacyFlatLocalInstall requires both local scope and legacy-flat style', () => {
    for (const [scope, style, expected] of [
      ['local', 'legacy-flat', true], ['global', 'legacy-flat', false],
      ['local', 'skills', false], ['local', undefined, false],
    ]) assert.equal(plan.isLegacyFlatLocalInstall({ localInstallStyle: style }, scope), expected);
  });

  test('shouldInstallStandaloneAgents excludes plugin-only and layout installs', () => {
    for (const [pluginOnly, skillsRuntime, expected] of [
      [false, false, true], [false, true, false], [true, false, false], [true, true, false],
    ]) assert.equal(plan.shouldInstallStandaloneAgents(pluginOnly, skillsRuntime), expected);
  });

  test('requiredRuntimeSurfaceSources maps every kind only for global scope', () => {
    for (const [kind, expected] of [
      ['commands', ['commands']], ['skills', ['commands']], ['agents', ['agents']],
      ['kimi-agents', ['agents']], ['unknown', []],
    ]) {
      assert.deepEqual([...plan.requiredRuntimeSurfaceSources({ kinds: [{ kind }] }, 'global')], expected);
      assert.deepEqual([...plan.requiredRuntimeSurfaceSources({ kinds: [{ kind }] }, 'local')], []);
    }
    assert.deepEqual([...plan.requiredRuntimeSurfaceSources({ kinds: [{ kind: 'skills' }, { kind: 'commands' }, { kind: 'agents' }] }, 'global')], ['commands', 'agents']);
  });

  test('codexAgentRolesEnabled retains selected core agents and all non-core modes', () => {
    for (const [mode, agents, expected] of [
      ['minimal', new Set(), false], ['core-only', new Set(['gsd-planner']), true],
      ['minimal', undefined, false], ['standard', new Set(), true], ['full', new Set(), true],
    ]) assert.equal(plan.codexAgentRolesEnabled(mode, { agents }), expected);
  });

  for (const [type, expectedByPath] of [
    ['rewrite-json', [true, true, false]],
    ['remove-managed', [true, true, false]],
    ['backup-and-remove', [true, true, false]],
    ['record-baseline', [false, false, false]],
    ['baseline-preserve-user', [false, false, false]],
    ['prompt-user', [false, false, false]],
    ['preserve-user', [false, false, false]],
  ]) {
    for (const [index, relPath] of ['hooks.json', 'config.toml', 'settings.json'].entries()) {
      test(`plannedActionsMutateCodexHooksInputs classifies ${type} on ${relPath}`, () => {
        assert.equal(plan.plannedActionsMutateCodexHooksInputs([{ type, relPath }]), expectedByPath[index]);
      });
    }
  }

  test('plannedActionsMutateCodexHooksInputs is false for no actions and finds later mutations', () => {
    assert.equal(plan.plannedActionsMutateCodexHooksInputs([]), false);
    assert.equal(plan.plannedActionsMutateCodexHooksInputs([
      { type: 'preserve-user', relPath: 'hooks.json' },
      { type: 'rewrite-json', relPath: 'settings.json' },
      { type: 'remove-managed', relPath: 'config.toml' },
    ]), true);
  });

  test('resolveRuntimeArtifactInstallRoot normalizes only absent and empty homes', () => {
    const kindArbitrary = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.record({ home: fc.oneof(fc.string(), fc.jsonValue(), fc.constant(undefined)) }),
    );
    fc.assert(fc.property(kindArbitrary, (kind) => {
      const configDir = '/fixture/config';
      const home = kind?.home;
      if (home != null && typeof home !== 'string') {
        assert.throws(() => plan.resolveRuntimeArtifactInstallRoot(configDir, kind), TypeError);
      } else {
        const actual = plan.resolveRuntimeArtifactInstallRoot(configDir, kind);
        if (home == null || home === '') assert.equal(actual, configDir);
        else assert.equal(actual, home);
      }
    }), { examples: [[null], [undefined]] });
  });
});

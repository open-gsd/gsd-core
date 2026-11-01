'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createTempDir: rawCreateTempDir, cleanup, sandboxHome } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { INSTALL_SCRIPT, installerEnv, stripAnsi, runMinimalInstall } = require('./helpers/install-shared.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest, resolveProfile, CAPABILITY_SKILL_MARKER } = require('../gsd-core/bin/lib/install-profiles.cjs');
const messages = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const MANIFEST = loadSkillsManifest(path.join(__dirname, '..', 'commands', 'gsd'));
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

const createTempDir = (prefix) => fs.realpathSync(rawCreateTempDir(prefix));

const originalGsdHome = process.env.GSD_HOME;
afterEach(() => {
  if (originalGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = originalGsdHome;
});

// Keep each seed at its original absolute HOME: emitted artifacts contain it.
// Reset by copying the pristine tree, so upgrades stay real CLI subprocesses
// without repeating the initial install for each destination or migration state.
const preparedInstalls = new Map();
function preparedInstall(t, runtime, scope) {
  const key = `${runtime}:${scope}`;
  let prepared = preparedInstalls.get(key);
  if (!prepared) {
    const root = createTempDir('gsd-5179-prepared-');
    const seed = createTempDir('gsd-5179-seed-');
    const { configDir } = runMinimalInstall({ runtime, scope, root, extraArgs: ['--no-legacy-cleanup'] });
    fs.cpSync(root, seed, { recursive: true, verbatimSymlinks: true });
    prepared = { root, seed, configDir };
    preparedInstalls.set(key, prepared);
  } else {
    cleanup(prepared.root);
    fs.cpSync(prepared.seed, prepared.root, { recursive: true, verbatimSymlinks: true });
  }
  t.after(() => cleanup(prepared.root));
  return prepared;
}
after(() => {
  for (const { root, seed } of preparedInstalls.values()) {
    cleanup(root);
    cleanup(seed);
  }
});

function snapshotInstallSymlinkTree(root, prefix) {
  const snapshot = {};

  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relPath = path.posix.join(relative.split(path.sep).join('/'), entry.name);
      const stat = fs.lstatSync(fullPath);
      const key = `${prefix}/${relPath}`;

      if (stat.isSymbolicLink()) {
        snapshot[key] = `symlink:${crypto.createHash('sha256').update(fs.readlinkSync(fullPath)).digest('hex')}`;
      } else if (stat.isDirectory()) {
        snapshot[key] = 'directory';
        visit(fullPath, relPath);
      } else if (stat.isFile()) {
        snapshot[key] = `file:${crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')}`;
      } else {
        snapshot[key] = `other:${stat.mode}`;
      }
    }
  }

  visit(root);
  return snapshot;
}

function prepareInstallSymlinkUpgrade(t, { allowOptIn = false } = {}) {
  const { root, configDir } = preparedInstall(t, 'claude', 'global');

  const coreDir = path.join(configDir, 'gsd-core');
  fs.writeFileSync(path.join(coreDir, 'VERSION'), '0.0.1\n');
  fs.writeFileSync(
    path.join(coreDir, 'previous-install-sentinel.txt'),
    'must survive a refused upgrade\n',
  );

  const skillsDir = path.join(configDir, 'skills');
  const skillsTarget = path.join(root, 'external-skills');
  fs.renameSync(skillsDir, skillsTarget);
  try {
    fs.symlinkSync(skillsTarget, skillsDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
      t.skip(`directory symlink creation is unavailable: ${error.code}`);
      return null;
    }
    throw error;
  }

  let refreshedSkillFile;
  let expectedSkillBytes;
  if (allowOptIn) {
    refreshedSkillFile = path.join(skillsTarget, 'gsd-help', 'SKILL.md');
    expectedSkillBytes = fs.readFileSync(refreshedSkillFile);
    fs.writeFileSync(refreshedSkillFile, 'stale temp fixture content\n');
  }

  const beforeTarget = snapshotInstallSymlinkTree(skillsTarget, 'skills-target');
  const before = {
    ...snapshotInstallSymlinkTree(configDir, 'config'),
    ...beforeTarget,
  };
  const result = runNode(
    [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', configDir, '--no-legacy-cleanup'],
    {
      cwd: process.cwd(),
      env: installerEnv({
        HOME: root,
        USERPROFILE: root,
        GSD_ALLOW_SYMLINKED_DEST: allowOptIn ? '1' : '',
      }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  const afterTarget = snapshotInstallSymlinkTree(skillsTarget, 'skills-target');
  const after = {
    ...snapshotInstallSymlinkTree(configDir, 'config'),
    ...afterTarget,
  };

  return {
    result,
    output: `${result.stdout}\n${result.stderr}`,
    before,
    after,
    beforeTarget,
    afterTarget,
    expectedSkillBytes, configDir, skillsDir,
    refreshedSkillBytes: refreshedSkillFile ? fs.readFileSync(refreshedSkillFile) : null,
  };
}

describe('#5179 install refusal preserves the previous install', () => {
  test('refuses an untrusted symlinked destination', (t) => {
    const fixture = prepareInstallSymlinkUpgrade(t);
    if (!fixture) return;

    assert.notEqual(fixture.result.exitCode, 0, 'the installer must exit non-zero');
    assert.ok(fixture.output.includes(messages.installRuntimeArtifactsSymlinkRefusalMessage(
      fixture.skillsDir, fixture.configDir)), fixture.output);
  });

  test('leaves the previous install byte-identical', (t) => {
    const fixture = prepareInstallSymlinkUpgrade(t);
    if (!fixture) return;

    const paths = [...new Set([...Object.keys(fixture.before), ...Object.keys(fixture.after)])].sort();
    const changedPaths = paths
      .filter((key) => fixture.before[key] !== fixture.after[key])
      .map((key) => ({
        path: key,
        before: fixture.before[key] ?? null,
        after: fixture.after[key] ?? null,
      }));

    assert.deepStrictEqual(
      changedPaths,
      [],
      'a refused upgrade must not remove, rewrite, or add paths under the config dir or skills target',
    );
  });

  test('installs the same layout with GSD_ALLOW_SYMLINKED_DEST=1', (t) => {
    const fixture = prepareInstallSymlinkUpgrade(t, { allowOptIn: true });
    if (!fixture) return;

    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.deepStrictEqual(fixture.refreshedSkillBytes, fixture.expectedSkillBytes, 'the opted-in install must restore the SKILL.md bytes through the symlink');
  });

  test('checks a kind with an alternate home against that home', (t) => {
    const root = createTempDir('gsd-symlink-alt-home-');
    t.after(() => cleanup(root));

    const { configDir } = runMinimalInstall({
      runtime: 'codex',
      scope: 'global',
      root,
      extraArgs: ['--no-legacy-cleanup'],
    });
    const homeDir = path.join(root, '.agents');
    const skillsDir = path.join(homeDir, 'skills');
    assert.equal(fs.statSync(skillsDir).isDirectory(), true, 'the initial Codex install must use $HOME/.agents/skills');

    const skillsTarget = path.join(root, 'external-agent-skills');
    fs.renameSync(skillsDir, skillsTarget);
    try {
      fs.symlinkSync(skillsTarget, skillsDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
        t.skip(`directory symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const coreDir = path.join(configDir, 'gsd-core');
    fs.writeFileSync(path.join(coreDir, 'VERSION'), '0.0.1\n');
    fs.writeFileSync(
      path.join(coreDir, 'previous-install-sentinel.txt'),
      'must survive a refused upgrade\n',
    );

    const before = {
      ...snapshotInstallSymlinkTree(configDir, 'config'),
      ...snapshotInstallSymlinkTree(homeDir, 'alternate-home'),
      ...snapshotInstallSymlinkTree(skillsTarget, 'skills-target'),
    };
    const result = runNode(
      [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', configDir, '--no-legacy-cleanup'],
      {
        cwd: process.cwd(),
        env: installerEnv({ HOME: root, USERPROFILE: root, GSD_ALLOW_SYMLINKED_DEST: '' }),
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    const after = {
      ...snapshotInstallSymlinkTree(configDir, 'config'),
      ...snapshotInstallSymlinkTree(homeDir, 'alternate-home'),
      ...snapshotInstallSymlinkTree(skillsTarget, 'skills-target'),
    };

    assert.notEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(`${result.stdout}\n${result.stderr}`.includes(
      messages.installRuntimeArtifactsSymlinkRefusalMessage(skillsDir, homeDir)));
    assert.deepStrictEqual(after, before, 'an alternate-home refusal must preserve both install roots and the symlink target');
  });
});

function prepareInstallSymlinkBranchUpgrade(t, {
  runtime = 'claude', scope = 'global', destination, surface = null, upgradeArgs = [],
  allowOptIn = false, dangling = false, refreshFile = null, staleBytes = '# stale previous install bytes\n', configContent = null, pendingMigrations = false, migrationState = null,
}) {
  const { root, configDir } = preparedInstall(t, runtime, scope);
  const coreDir = path.join(configDir, 'gsd-core');
  fs.writeFileSync(path.join(coreDir, 'VERSION'), '0.0.1\n');
  fs.writeFileSync(path.join(coreDir, 'previous-install-sentinel.txt'), 'must survive a refused upgrade\n');
  if (surface) {
    fs.writeFileSync(path.join(configDir, '.gsd-surface.json'), JSON.stringify(surface) + '\n');
  }

  if (configContent !== null) fs.writeFileSync(path.join(configDir, 'config.toml'), configContent);
  if (pendingMigrations) {
    // Seed the Windows-only shim on every host so the migration fixture also
    // exercises its unmanifested path on POSIX; execution remains host-native.
    const { buildCodexHookWindowsShimIR } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
    const shim = buildCodexHookWindowsShimIR(path.join(configDir, 'hooks', 'gsd-check-update.js'), JSON.stringify(process.execPath));
    if (!fs.existsSync(shim.cmdPath)) fs.writeFileSync(shim.cmdPath, shim.render.cmd());
    const { INSTALL_STATE_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
    const hooksMigration = require('../gsd-core/bin/lib/installer-migrations/002-codex-legacy-hooks-json.cjs');
    const statePath = path.join(configDir, INSTALL_STATE_NAME);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.appliedMigrations.some((entry) => entry.id === hooksMigration.id));
    // Only the hooks cleanup needs to run again. Preserve the applied baseline:
    // resetting it would prompt for the unmanifested Windows .cmd shim.
    state.appliedMigrations = state.appliedMigrations.filter((entry) => entry.id !== hooksMigration.id);
    fs.writeFileSync(statePath, JSON.stringify(state) + '\n');
  }

  if (migrationState) {
    const { INSTALL_STATE_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
    const statePath = path.join(configDir, INSTALL_STATE_NAME);
    if (migrationState === 'absent') {
      cleanup(statePath);
      // No managed registrations: pending 002 has nothing to replace.
      fs.writeFileSync(path.join(configDir, 'hooks.json'), '{"hooks":{"SessionStart":[]}}\n');
    } else {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const unrelated = require('../gsd-core/bin/lib/installer-migrations/007-retire-config-root-commonjs-marker.cjs');
      assert.ok(state.appliedMigrations.some((entry) => entry.id === unrelated.id));
      state.appliedMigrations = state.appliedMigrations.filter((entry) => entry.id !== unrelated.id);
      fs.writeFileSync(statePath, JSON.stringify(state) + '\n');
    }
  }

  const dest = path.join(configDir, destination);
  assert.ok(fs.existsSync(dest), `the previous install must contain ${destination}`);
  const isDirectory = fs.statSync(dest).isDirectory();
  const target = path.join(root, 'previous-destination');
  fs.renameSync(dest, target);
  try {
    fs.symlinkSync(target, dest, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return null;
    }
    throw error;
  }

  let expectedRefreshedBytes;
  if (refreshFile !== null) {
    const file = isDirectory ? path.join(dest, refreshFile) : dest;
    expectedRefreshedBytes = fs.readFileSync(file);
    fs.writeFileSync(file, staleBytes);
  }

  const previousDestinationBytes = isDirectory ? null : fs.readFileSync(dest);
  if (dangling) {
    assert.equal(isDirectory, false);
    cleanup(target);
  }
  const before = snapshotInstallSymlinkTree(root, 'previous-install');
  const args = [INSTALL_SCRIPT, `--${runtime}`, `--${scope}`, '--no-legacy-cleanup', ...upgradeArgs];
  if (scope === 'global') args.push('--config-dir', configDir);
  const result = runNode(args, {
    cwd: scope === 'local' ? root : process.cwd(),
    env: installerEnv({ HOME: root, USERPROFILE: root, GSD_ALLOW_SYMLINKED_DEST: allowOptIn ? '1' : '' }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return {
    result, output: stripAnsi(`${result.stdout}\n${result.stderr}`),
    before, after: snapshotInstallSymlinkTree(root, 'previous-install'),
    configDir, dest, target, expectedRefreshedBytes, previousDestinationBytes,
  };
}

function assertInstallSymlinkBranchPreserved(fixture) {
  assert.notEqual(fixture.result.exitCode, 0, fixture.output);
  assert.deepStrictEqual(fixture.after, fixture.before, 'a refused upgrade must preserve the previous install and symlink target byte-identically');
}

describe('#5179 install root resolution', () => {
  const planModule = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  const engine = require('../gsd-core/bin/lib/install-engine.cjs');
  const layoutModule = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

  for (const [label, kind] of [
    ['null kind', null],
    ['missing kind', undefined],
    ['missing home', {}],
    ['empty home', { home: '' }],
    ['null home', { home: null }],
  ]) {
    test(`falls back to configDir for ${label}`, () => {
      const configDir = path.join(os.tmpdir(), 'gsd-5179-config');
      assert.equal(planModule.resolveRuntimeArtifactInstallRoot(configDir, kind), configDir);
    });
  }

  test('uses a non-empty string home for containment', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-5179-config');
    const alternateHome = path.join(os.tmpdir(), 'gsd-5179-alternate');
    const kind = { home: alternateHome, destSubpath: 'agents' };
    assert.equal(planModule.resolveRuntimeArtifactInstallRoot(configDir, kind), alternateHome);
    assert.equal(planModule.resolveRuntimeArtifactDestination(configDir, kind), path.join(alternateHome, 'agents'));
  });

  test('standalone agents with an empty home write under configDir', (t) => {
    const configDir = createTempDir('gsd-5179-empty-home-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);
    const stagedDir = path.join(configDir, 'staged');
    fs.mkdirSync(stagedDir);
    fs.writeFileSync(path.join(stagedDir, 'gsd-proof.md'), '# staged agent\n');
    t.mock.method(layoutModule, 'resolveRuntimeArtifactLayout', () => ({
      runtime: 'claude', configDir, scope: 'local',
      kinds: [{ kind: 'agents', home: '', destSubpath: 'agents', prefix: 'gsd-', stage: () => stagedDir }],
    }));

    const result = engine.installAgentsKindStandalone('claude', configDir, 'local', RESOLVED_CORE, './');
    assert.equal(result.destDir, path.join(configDir, 'agents'));
    assert.equal(fs.readFileSync(path.join(result.destDir, 'gsd-proof.md'), 'utf8'), '# staged agent\n');
  });
});

describe('#5179 Codex rollback arming', () => {
  test('a core install keeps its pre-surface rollback when the committed surface selects zero agents', (t) => {
    const root = createTempDir('gsd-5179-core-rollback-');
    t.after(() => cleanup(root));
    const { configDir } = runMinimalInstall({ runtime: 'codex', scope: 'global', root });
    const versionPath = path.join(configDir, 'gsd-core', 'VERSION');
    fs.writeFileSync(versionPath, '0.0.1\n');
    const surface = {
      baseProfile: 'core', disabledClusters: [], explicitAdds: [],
      explicitRemoves: [...MANIFEST.keys()].filter((stem) => !stem.startsWith('_')),
    };
    fs.writeFileSync(path.join(configDir, '.gsd-surface.json'), JSON.stringify(surface));
    const { resolveSurface } = require('../gsd-core/bin/lib/surface.cjs');
    assert.equal(resolveSurface(configDir, MANIFEST).agents.size, 0, 'the committed surface must select no agents');
    const script = `
      const fs = require('node:fs');
      process.env.GSD_TEST_MODE = '1';
      process.argv = [process.execPath, ${JSON.stringify(INSTALL_SCRIPT)}, '--profile=core'];
      const installer = require(${JSON.stringify(INSTALL_SCRIPT)});
      const originalWrite = fs.writeFileSync;
      let injected = false;
      fs.writeFileSync = (file, ...args) => {
        const result = originalWrite(file, ...args);
        if (file === ${JSON.stringify(versionPath)} && !injected) {
          injected = true;
          throw new Error('synthetic VERSION failure');
        }
        return result;
      };
      try {
        installer.install(true, 'codex', ${JSON.stringify(configDir)});
        throw new Error('the fault was not raised');
      } catch (error) {
        if (error.message !== 'synthetic VERSION failure') throw error;
      }
      if (!injected) throw new Error('the VERSION writer was not reached');
    `;
    const result = runNode(['-e', script], {
      cwd: root, env: installerEnv({ HOME: root, USERPROFILE: root }), timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(versionPath, 'utf8'), '0.0.1\n', 'the armed pre-config rollback must restore VERSION');
  });
});

describe('#5179 preflight branch coverage', () => {
  const branches = [
    { branch: 'gsd-core is symlinked', destination: 'gsd-core' },
    { branch: 'Codex hooks.json is symlinked', runtime: 'codex', destination: 'hooks.json' },
    { branch: 'Codex config.toml is symlinked', runtime: 'codex', destination: 'config.toml' },
    { branch: 'the Codex agents directory is symlinked', runtime: 'codex', destination: 'agents' },
    { branch: 'combined-family skills are symlinked', runtime: 'opencode', destination: 'skills' },
    { branch: 'combined-family agents are symlinked', runtime: 'opencode', destination: 'agents' },
    { branch: 'legacy-flat local agents are symlinked', scope: 'local', destination: 'agents', standalone: true },
  ];
  for (const row of branches) {
    test(`preserves the previous install when ${row.branch}`, (t) => {
      const fixture = prepareInstallSymlinkBranchUpgrade(t, row);
      if (!fixture) return;
      assertInstallSymlinkBranchPreserved(fixture);
      if (row.standalone) assert.ok(fixture.output.includes(
        messages.installAgentsKindStandaloneSymlinkRefusalMessage(fixture.dest, fixture.configDir)), fixture.output);
    });
  }

  for (const row of [
    { branch: 'commands corpus', destination: 'gsd-core/commands/gsd', refreshFile: 'help.md' },
    { branch: 'agents corpus', destination: 'gsd-core/agents', refreshFile: 'gsd-planner.md' },
  ]) {
    test(`does not newly refuse a symlinked ${row.branch} subdirectory`, (t) => {
      const fixture = prepareInstallSymlinkBranchUpgrade(t, row);
      if (!fixture) return;
      assert.equal(fixture.result.exitCode, 0, fixture.output);

      assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
      assert.deepStrictEqual(fs.readFileSync(path.join(fixture.dest, row.refreshFile)), fixture.expectedRefreshedBytes);
    });
  }

  for (const allowOptIn of [false, true]) {
    for (const dangling of [false, true]) {
      test(`replaces Codex agent TOML links with refreshed files (opt-in=${allowOptIn}, dangling=${dangling})`, (t) => {
        const fixture = prepareInstallSymlinkBranchUpgrade(t, {
          runtime: 'codex', destination: 'agents/gsd-planner.toml', refreshFile: '', allowOptIn, dangling,
        });
        if (!fixture) return;
        assert.equal(fixture.result.exitCode, 0, fixture.output);
        assert.equal(fs.lstatSync(fixture.dest).isFile(), true);
        assert.deepStrictEqual(fs.readFileSync(fixture.dest), fixture.expectedRefreshedBytes);
        assert.equal(fs.readFileSync(path.join(fixture.configDir, 'gsd-core', 'VERSION'), 'utf8'), require('../package.json').version);
        if (dangling) assert.equal(fs.existsSync(fixture.target), false);
      });
    }
  }

  for (const [shape, configContent] of [
    ['inline features', 'features = { other_feature = true }\n'],
    ['scalar features', 'features = "disabled"\n'],
    ['inline hooks feature', 'features = { hooks = true }\n'],
  ]) {
    test(`does not refuse symlinked Codex hooks.json when ${shape} skip hook reconciliation`, (t) => {
      const fixture = prepareInstallSymlinkBranchUpgrade(t, {
        runtime: 'codex', destination: 'hooks.json', configContent,
      });
      if (!fixture) return;
      assert.equal(fixture.result.exitCode, 0, fixture.output);

      assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), true);
      assert.deepStrictEqual(fs.readFileSync(fixture.dest), fixture.previousDestinationBytes, 'a no-reconciliation install must leave hooks.json bytes untouched');
      assert.equal(fs.readFileSync(path.join(fixture.configDir, 'gsd-core', 'VERSION'), 'utf8'), require('../package.json').version);
    });
  }

  test('does not newly refuse symlinked Codex hooks.json before pending migrations replace it', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'hooks.json', pendingMigrations: true,
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);

    assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
    assert.deepStrictEqual(fs.readFileSync(fixture.dest), fixture.previousDestinationBytes);
  });

  test('allows opted-in Codex hooks.json and refreshes its symlink target', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'hooks.json', allowOptIn: true,
      refreshFile: '', staleBytes: '{"hooks":{}}\n',
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);

    assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), true, 'the opted-in hooks writer follows the symlink');
    assert.deepStrictEqual(fs.readFileSync(fs.realpathSync(fixture.dest)), fixture.expectedRefreshedBytes);
  });

  test('does not newly refuse symlinked legacy-flat local commands', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, { scope: 'local', destination: 'commands' });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), true);
    assert.ok(fs.existsSync(path.join(fixture.dest, 'gsd-help.md')), 'the flat writer must install commands through the symlink');
  });

  test('does not newly refuse symlinked legacy-flat local skills cleanup', (t) => {
    const root = createTempDir('gsd-5179-local-skills-');
    t.after(() => cleanup(root));
    const { configDir } = runMinimalInstall({
      runtime: 'claude', scope: 'local', root, extraArgs: ['--no-legacy-cleanup'],
    });
    const skillsTarget = path.join(root, 'previous-skills');
    const staleSkill = path.join(skillsTarget, 'gsd-stale');
    fs.mkdirSync(staleSkill, { recursive: true });
    fs.writeFileSync(path.join(staleSkill, 'SKILL.md'), '# stale skill\n');
    fs.writeFileSync(path.join(staleSkill, CAPABILITY_SKILL_MARKER), 'retired-fixture-capability\n');
    fs.writeFileSync(path.join(skillsTarget, 'user-skill.md'), '# keep user skill\n');
    const skillsDir = path.join(configDir, 'skills');
    try {
      fs.symlinkSync(skillsTarget, skillsDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
        t.skip(`directory symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = runNode([INSTALL_SCRIPT, '--claude', '--local', '--no-legacy-cleanup'], {
      cwd: root,
      env: installerEnv({ HOME: root, USERPROFILE: root, GSD_ALLOW_SYMLINKED_DEST: '' }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    assert.equal(result.exitCode, 0, output);

    assert.equal(fs.lstatSync(skillsDir).isSymbolicLink(), true);
    assert.equal(fs.existsSync(staleSkill), false, 'legacy-flat cleanup removes stale GSD skills through the symlink');
    assert.equal(fs.readFileSync(path.join(skillsTarget, 'user-skill.md'), 'utf8'), '# keep user skill\n');
  });

  test('does not refuse a trusted non-symlinked layout', (t) => {
    const root = createTempDir('gsd-5179-trusted-');
    t.after(() => cleanup(root));
    const { configDir } = runMinimalInstall({ runtime: 'codex', scope: 'global', root });
    fs.writeFileSync(path.join(configDir, 'gsd-core', 'VERSION'), '0.0.1\n');
    runMinimalInstall({ runtime: 'codex', scope: 'global', root });

    assert.equal(fs.readFileSync(path.join(configDir, 'gsd-core', 'VERSION'), 'utf8'), require('../package.json').version);
    assert.ok(fs.existsSync(path.join(configDir, 'agents', 'gsd-planner.toml')));
  });

  test('does not refuse a Codex toml omitted by the committed surface', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'agents/gsd-ai-researcher.toml',
      surface: { baseProfile: 'standard', disabledClusters: [], explicitAdds: [], explicitRemoves: [] },
      upgradeArgs: ['--profile=standard'],
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.equal(fs.existsSync(fixture.dest), false, 'the omitted agent must not be emitted');
    assert.ok(fs.existsSync(path.join(fixture.configDir, 'agents', 'gsd-planner.toml')), 'the selected agent must be emitted');
  });

  test('core Codex replaces a selected agent TOML link', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'agents/gsd-planner.toml', refreshFile: '', upgradeArgs: ['--profile=core'],
      surface: { baseProfile: 'core', disabledClusters: [], explicitAdds: [], explicitRemoves: [] },
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.equal(fs.lstatSync(fixture.dest).isFile(), true);
    assert.deepStrictEqual(fs.readFileSync(fixture.dest), fixture.expectedRefreshedBytes);
  });

  test('core Codex omits TOMLs for agents absent from core staging', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'agents/gsd-ai-researcher.toml', upgradeArgs: ['--profile=core'],
      surface: { baseProfile: 'core', disabledClusters: [], explicitAdds: [], explicitRemoves: [] },
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.equal(fs.existsSync(fixture.dest), false, 'core must not emit the omitted agent');
    assert.ok(fs.existsSync(path.join(fixture.configDir, 'agents', 'gsd-planner.toml')), 'core must emit its selected agent roles');
  });

  test('Codex replaces a TOML link for an agent added by the committed surface', (t) => {
    const standard = resolveProfile({ modes: ['standard'], manifest: MANIFEST });
    assert.equal(standard.agents.has('gsd-ai-researcher'), false, 'the base profile must omit the added agent');
    const fixture = prepareInstallSymlinkBranchUpgrade(t, {
      runtime: 'codex', destination: 'agents/gsd-ai-researcher.toml', refreshFile: '',
      surface: { baseProfile: 'standard', disabledClusters: [], explicitAdds: ['ai-integration-phase'], explicitRemoves: [] },
      upgradeArgs: ['--profile=standard'],
    });
    if (!fixture) return;
    assert.equal(fixture.result.exitCode, 0, fixture.output);
    assert.equal(fs.lstatSync(fixture.dest).isFile(), true);
    assert.deepStrictEqual(fs.readFileSync(fixture.dest), fixture.expectedRefreshedBytes);
  });

  test('combined-family refusal message matches the agents write-time check', (t) => {
    const fixture = prepareInstallSymlinkBranchUpgrade(t, { runtime: 'opencode', destination: 'agents' });
    if (!fixture) return;
    assert.notEqual(fixture.result.exitCode, 0, fixture.output);
    const message = messages.installAgentsKindStandaloneSymlinkRefusalMessage(fixture.dest, fixture.configDir);
    assert.ok(fixture.output.includes(message), fixture.output);
  });
});

describe('#5179 migration refusal ordering', () => {
  for (const scope of ['global', 'local']) {
    for (const migrationState of ['unrelated-pending', 'absent']) {
      test(`Codex ${scope} refuses hooks before writes with ${migrationState} state`, (t) => {
        const fixture = prepareInstallSymlinkBranchUpgrade(t, {
          runtime: 'codex', scope, destination: 'hooks.json', migrationState,
          upgradeArgs: ['--profile=core'],
        });
        if (fixture) assertInstallSymlinkBranchPreserved(fixture);
      });
    }
  }

  for (const allowOptIn of [false, true]) {
    test(`caught dev-preferences refusal restores legacy preferences and refreshes core (opt-in=${allowOptIn})`, (t) => {
      const root = createTempDir('gsd-5179-caught-dev-prefs-');
      t.after(() => cleanup(root));
      const { configDir } = runMinimalInstall({ runtime: 'qwen', scope: 'global', root });
      fs.writeFileSync(path.join(configDir, 'gsd-core', 'VERSION'), '0.0.1\n');
      const legacyDir = path.join(configDir, 'commands', 'gsd');
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyFile = path.join(legacyDir, 'dev-preferences.md');
      const preferences = '# user preferences\n';
      fs.writeFileSync(legacyFile, preferences);
      const skillDir = path.join(configDir, 'skills', 'gsd-dev-preferences');
      cleanup(skillDir);
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      const missingTarget = path.join(root, 'missing-preferences.md');
      try {
        fs.symlinkSync(missingTarget, skillFile, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          t.skip(`symlink creation unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const env = installerEnv({ HOME: root, USERPROFILE: root });
      if (allowOptIn) env.GSD_ALLOW_SYMLINKED_DEST = '1';
      else delete env.GSD_ALLOW_SYMLINKED_DEST;
      const result = runNode([INSTALL_SCRIPT, '--qwen', '--global', '--config-dir', configDir, '--no-legacy-cleanup'], {
        env, timeoutMs: INSTALL_TIMEOUT_MS,
      });
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.equal(result.exitCode, 0, output);

      assert.equal(fs.readFileSync(legacyFile, 'utf8'), preferences);
      assert.equal(fs.readlinkSync(skillFile), missingTarget);
      assert.equal(fs.existsSync(missingTarget), false);
      assert.equal(fs.readFileSync(path.join(configDir, 'gsd-core', 'VERSION'), 'utf8'), require('../package.json').version);
    });
  }
});

describe('#5179 writer root parity', () => {
  const engine = require('../gsd-core/bin/lib/install-engine.cjs');
  const layoutModule = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
  const plan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  test('artifact writers and install/uninstall plans agree on the empty-home root', (t) => {
    const root = createTempDir('gsd-5179-all-writers-');
    t.after(() => cleanup(root));
    sandboxHome(t, root);
    let layout;
    t.mock.method(layoutModule, 'resolveRuntimeArtifactLayout', () => layout);
    for (const writer of ['generic', 'standalone', 'combined-family', 'dev-preferences', 'apply-surface']) {
      const configDir = path.join(root, writer);
      fs.mkdirSync(configDir);
      const stage = path.join(configDir, 'stage');
      fs.mkdirSync(stage);
      fs.writeFileSync(path.join(stage, writer === 'combined-family' ? 'help.md' : 'gsd-proof.md'), '---\ndescription: Proof\n---\n# Proof\n');
      const agents = ['generic', 'standalone', 'apply-surface'].includes(writer);
      const kind = {
        kind: agents ? 'agents' : 'skills', home: '', destSubpath: agents ? 'agents' : 'skills',
        prefix: 'gsd-', converter: 'convertClaudeCommandToOpencodeSkill', stage: () => stage,
      };
      layout = { runtime: 'qwen', configDir, scope: 'local', kinds: [kind] };
      const expectedDest = path.join(configDir, kind.destSubpath);
      assert.equal(plan.resolveRuntimeArtifactDestination(configDir, kind), expectedDest);
      assert.equal(plan.createRuntimeArtifactUninstallPlan(layout).items[0].destDir, expectedDest);
      if (writer === 'generic') engine.installRuntimeArtifacts('qwen', configDir, 'local', RESOLVED_CORE);
      if (writer === 'standalone') engine.installAgentsKindStandalone('qwen', configDir, 'local', RESOLVED_CORE, './');
      if (writer === 'combined-family') engine.installOpencodeFamilySkills('opencode', configDir, stage, './');
      if (writer === 'apply-surface') applySurface(configDir, layout, MANIFEST);
      if (writer === 'dev-preferences') engine.migrateLegacyDevPreferencesToSkill(configDir, new Map([['dev-preferences.md', '# Proof\n']]), 'qwen', 'local');
      const written = agents ? 'gsd-proof.md' : path.join(writer === 'combined-family' ? 'gsd-help' : 'gsd-dev-preferences', 'SKILL.md');
      assert.equal(splitLines(fs.readFileSync(path.join(expectedDest, written), 'utf8').trimEnd()).at(-1), '# Proof', writer);
    }
  });

  for (const writer of ['combined-family', 'dev-preferences']) {
    for (const home of ['', 42]) {
      test(`${writer} uses the preflight root contract for home ${JSON.stringify(home)}`, (t) => {
        const root = createTempDir('gsd-5179-parity-');
        t.after(() => cleanup(root));
        sandboxHome(t, root);
        const kind = { kind: 'skills', home, destSubpath: 'skills', prefix: 'gsd-', converter: 'convertClaudeCommandToOpencodeSkill' };
        t.mock.method(layoutModule, 'resolveRuntimeArtifactLayout', () => ({ runtime: 'opencode', configDir: root, scope: 'local', kinds: [kind] }));
        const commands = path.join(root, 'raw-commands');
        fs.mkdirSync(commands);
        fs.writeFileSync(path.join(commands, 'help.md'), '---\ndescription: Help\n---\n# Help\n');
        const write = () => writer === 'combined-family'
          ? engine.installOpencodeFamilySkills('opencode', root, commands, './')
          : engine.migrateLegacyDevPreferencesToSkill(root, new Map([['dev-preferences.md', '# preferences\n']]), 'opencode', 'local');
        if (typeof home !== 'string') {
          assert.throws(write, { name: 'TypeError', message: 'Artifact home must be a string, null, or undefined' });
        } else {
          assert.equal(plan.resolveRuntimeArtifactInstallRoot(root, kind), root);
          const expectedRoot = root;
          write();
          assert.ok(fs.existsSync(path.join(expectedRoot, 'skills', writer === 'combined-family' ? 'gsd-help' : 'gsd-dev-preferences', 'SKILL.md')));
        }
      });
    }
  }
});

describe('#5179 direct hooks destination resolution', () => {
  const { resolveCodexHooksJsonDestination } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
  test('resolveCodexHooksJsonDestination preserves trust and opt-in target semantics without writes', (t) => {
    const root = createTempDir('gsd-5179-hooks-destination-');
    t.after(() => cleanup(root));
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir);
    const nominal = path.join(configDir, 'hooks.json');
    assert.equal(resolveCodexHooksJsonDestination(configDir), nominal);
    assert.equal(fs.existsSync(nominal), false);
    const external = path.join(root, 'external.json');
    fs.writeFileSync(external, '{}\n');
    try { fs.symlinkSync(external, nominal, 'file'); } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`symlink creation unavailable: ${error.code}`); return; }
      throw error;
    }
    const before = snapshotInstallSymlinkTree(root, 'hooks');
    const original = process.env.GSD_ALLOW_SYMLINKED_DEST;
    t.after(() => {
      if (original === undefined) delete process.env.GSD_ALLOW_SYMLINKED_DEST;
      else process.env.GSD_ALLOW_SYMLINKED_DEST = original;
    });
    delete process.env.GSD_ALLOW_SYMLINKED_DEST;
    assert.throws(() => resolveCodexHooksJsonDestination(configDir), Error);
    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';
    assert.equal(resolveCodexHooksJsonDestination(configDir), fs.realpathSync(external));
    assert.deepEqual(snapshotInstallSymlinkTree(root, 'hooks'), before);
  });
});

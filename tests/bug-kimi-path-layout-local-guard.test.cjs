'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALL_SCRIPT = path.join(ROOT, 'bin', 'install.js');

const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
  getGlobalSkillDir,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));
const {
  resolveRuntimeArtifactLayout,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs'));
const {
  getGlobalDir,
  getConfigDirFromHome,
} = require('../bin/install.js');

function withEnv(updates, fn) {
  const saved = {};
  for (const key of Object.keys(updates)) {
    saved[key] = process.env[key];
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(updates)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('Kimi runtime homes', () => {
  test('canonical global skills base is ~/.agents/skills, not ~/.kimi-code/skills', () => {
    withEnv({ KIMI_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(
        getGlobalConfigDir('kimi'),
        path.join(os.homedir(), '.agents'),
      );
      assert.strictEqual(
        getGlobalSkillsBase('kimi'),
        path.join(os.homedir(), '.agents', 'skills'),
      );
      assert.strictEqual(
        getGlobalSkillDir('kimi', 'gsd-help'),
        path.join(os.homedir(), '.agents', 'skills', 'gsd-help'),
      );
      assert.notStrictEqual(
        getGlobalSkillsBase('kimi'),
        path.join(os.homedir(), '.kimi-code', 'skills'),
      );
    });
  });

  test('KIMI_CONFIG_DIR can select the brand-specific ~/.kimi-code root', () => {
    withEnv({ KIMI_CONFIG_DIR: '/tmp/custom-kimi-code', XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(getGlobalConfigDir('kimi'), '/tmp/custom-kimi-code');
      assert.strictEqual(
        getGlobalSkillsBase('kimi'),
        path.join('/tmp/custom-kimi-code', 'skills'),
      );
      assert.strictEqual(getGlobalDir('kimi'), '/tmp/custom-kimi-code');
    });
  });

  test('XDG_CONFIG_HOME does not change Kimi default root', () => {
    withEnv({ KIMI_CONFIG_DIR: undefined, XDG_CONFIG_HOME: '/tmp/xdg-home' }, () => {
      assert.strictEqual(
        getGlobalConfigDir('kimi'),
        path.join(os.homedir(), '.agents'),
      );
      assert.strictEqual(
        getConfigDirFromHome('kimi', true),
        "'.agents'",
      );
    });
  });
});

describe('Kimi runtime artifact layout', () => {
  test('global layout stages Kimi skills and agents while local layout remains guarded', () => {
    const globalLayout = resolveRuntimeArtifactLayout('kimi', '/tmp/kimi-config', 'global');
    assert.strictEqual(globalLayout.runtime, 'kimi');
    assert.strictEqual(globalLayout.configDir, '/tmp/kimi-config');
    assert.strictEqual(globalLayout.kinds.length, 2);
    assert.strictEqual(globalLayout.kinds[0].kind, 'skills');
    assert.strictEqual(globalLayout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(globalLayout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof globalLayout.kinds[0].stage, 'function');
    assert.strictEqual(globalLayout.kinds[1].kind, 'kimi-agents');
    assert.strictEqual(globalLayout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(globalLayout.kinds[1].prefix, 'gsd');
    assert.strictEqual(typeof globalLayout.kinds[1].stage, 'function');

    const localLayout = resolveRuntimeArtifactLayout('kimi', '/tmp/kimi-config', 'local');
    assert.strictEqual(localLayout.runtime, 'kimi');
    assert.deepStrictEqual(localLayout.kinds, []);
  });
});

describe('Kimi local install guard', () => {
  test('--kimi --local exits successfully without writing local Kimi project artifacts', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-local-project-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-local-home-'));
    try {
      const result = spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--kimi', '--local', '--no-sdk'],
        {
          cwd: tmpProject,
          encoding: 'utf8',
          env: installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome }),
        },
      );

      assert.strictEqual(
        result.status,
        0,
        `expected --kimi --local guard to no-op successfully\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.match(combined, /Kimi local install/i);
      assert.match(combined, /deferred/i);

      assert.ok(!fs.existsSync(path.join(tmpProject, '.kimi')), 'must not create legacy .kimi/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.kimi-code')), 'must not create .kimi-code/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.agents')), 'must not create .agents/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.claude')), 'must not fall back to Claude local install');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global writes converted Kimi skills and agent artifacts', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-home-'));
    try {
      const result = spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'],
        {
          cwd: tmpProject,
          encoding: 'utf8',
          env: installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome }),
        },
      );

      assert.strictEqual(
        result.status,
        0,
        `expected --kimi --global to install Kimi skills successfully\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.match(combined, /Installing for .*Kimi/i);
      assert.match(combined, /Installed \d+ Kimi skills to skills\//i);
      assert.match(combined, /Generated Kimi root agent: .*agents.*gsd\.yaml/i);
      assert.match(combined, /kimi --agent-file/i);
      assert.match(combined, /Wrote file manifest/i);

      const skillFile = path.join(tmpConfig, 'skills', 'gsd-new-project', 'SKILL.md');
      assert.ok(fs.existsSync(skillFile), 'must write gsd-new-project/SKILL.md');
      const skillContent = fs.readFileSync(skillFile, 'utf8');
      assert.match(skillContent, /^name: gsd-new-project$/m);
      assert.match(skillContent, /\/skill:gsd-new-project/);
      assert.match(skillContent, /gsd-core\/workflows\/new-project\.md/);
      assert.doesNotMatch(skillContent, /@~\/\.claude\/gsd-core|@\$HOME\/\.claude\/gsd-core/);
      assert.doesNotMatch(skillContent, /@[^\r\n]*\\/, 'serialized Kimi payload references must use forward slashes');
      assert.doesNotMatch(skillContent, /kimi_cli\.tools|system_prompt_path|^version: 1$/m);

      const rootYaml = path.join(tmpConfig, 'agents', 'gsd.yaml');
      const rootPrompt = path.join(tmpConfig, 'agents', 'gsd.md');
      const executorYaml = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.yaml');
      const executorPrompt = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md');
      assert.ok(fs.existsSync(rootYaml), 'must write agents/gsd.yaml');
      assert.ok(fs.existsSync(rootPrompt), 'must write agents/gsd.md');
      assert.ok(fs.existsSync(executorYaml), 'must write agents/subagents/gsd-executor.yaml');
      assert.ok(fs.existsSync(executorPrompt), 'must write agents/subagents/gsd-executor.md');

      const rootYamlContent = fs.readFileSync(rootYaml, 'utf8');
      assert.match(rootYamlContent, /^version: 1$/m);
      assert.match(rootYamlContent, /^agent:$/m);
      assert.match(rootYamlContent, /extend: default/);
      assert.match(rootYamlContent, /system_prompt_path: \.\/gsd\.md/);
      assert.match(rootYamlContent, /tools:/);
      assert.match(rootYamlContent, /subagents:/);
      assert.match(rootYamlContent, /kimi_cli\.tools\./);
      assert.doesNotMatch(rootYamlContent, /mcp__/);

      const executorYamlContent = fs.readFileSync(executorYaml, 'utf8');
      assert.match(executorYamlContent, /system_prompt_path: \.\/gsd-executor\.md/);
      assert.match(executorYamlContent, /kimi_cli\.tools\./);
      assert.doesNotMatch(executorYamlContent, /mcp__/);

      assert.ok(fs.existsSync(path.join(tmpConfig, 'gsd-core', 'workflows', 'new-project.md')), 'must write workflow payloads used by Kimi skills');
      const manifestPath = path.join(tmpConfig, 'gsd-file-manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'must write gsd-file-manifest.json for Kimi installs');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(manifest.files['skills/gsd-new-project/SKILL.md'], 'manifest tracks generated Kimi skill');
      assert.ok(manifest.files['agents/gsd.yaml'], 'manifest tracks Kimi root agent YAML');
      assert.ok(manifest.files['agents/gsd.md'], 'manifest tracks Kimi root agent prompt');
      assert.ok(manifest.files['agents/subagents/gsd-executor.yaml'], 'manifest tracks Kimi subagent YAML');
      assert.ok(manifest.files['agents/subagents/gsd-executor.md'], 'manifest tracks Kimi subagent prompt');
      assert.ok(manifest.files['gsd-core/workflows/new-project.md'], 'manifest tracks installed workflow payload');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'hooks')), 'must not write hooks under the Kimi root');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'settings.json')), 'must not write settings.json under the Kimi root');
      assert.ok(!fs.existsSync(path.join(tmpConfig, '.clinerules')), 'must not write rules under the Kimi root');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global backs up local edits to generated skills and agent artifacts on reinstall', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-home-'));
    const env = installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome });

    try {
      const installArgs = [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'];
      const first = spawnSync(process.execPath, installArgs, {
        cwd: tmpProject,
        encoding: 'utf8',
        env,
      });
      assert.strictEqual(
        first.status,
        0,
        `first install failed\nstdout: ${first.stdout}\nstderr: ${first.stderr}`,
      );

      const skillFile = path.join(tmpConfig, 'skills', 'gsd-new-project', 'SKILL.md');
      const agentPrompt = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md');
      fs.appendFileSync(skillFile, '\nUSER LOCAL KIMI SKILL EDIT\n');
      fs.appendFileSync(agentPrompt, '\nUSER LOCAL KIMI AGENT EDIT\n');

      const second = spawnSync(process.execPath, installArgs, {
        cwd: tmpProject,
        encoding: 'utf8',
        env,
      });
      assert.strictEqual(
        second.status,
        0,
        `second install failed\nstdout: ${second.stdout}\nstderr: ${second.stderr}`,
      );
      assert.match(`${second.stdout}\n${second.stderr}`, /locally modified GSD file/i);

      const skillBackup = path.join(tmpConfig, 'gsd-local-patches', 'skills', 'gsd-new-project', 'SKILL.md');
      const agentBackup = path.join(tmpConfig, 'gsd-local-patches', 'agents', 'subagents', 'gsd-executor.md');
      assert.match(fs.readFileSync(skillBackup, 'utf8'), /USER LOCAL KIMI SKILL EDIT/);
      assert.match(fs.readFileSync(agentBackup, 'utf8'), /USER LOCAL KIMI AGENT EDIT/);

      const meta = JSON.parse(fs.readFileSync(path.join(tmpConfig, 'gsd-local-patches', 'backup-meta.json'), 'utf8'));
      assert.ok(meta.files.includes('skills/gsd-new-project/SKILL.md'));
      assert.ok(meta.files.includes('agents/subagents/gsd-executor.md'));
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global --uninstall removes GSD artifacts and preserves non-GSD Kimi content', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-home-'));
    const env = installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome });

    try {
      const installArgs = [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'];
      const installResult = spawnSync(process.execPath, installArgs, {
        cwd: tmpProject,
        encoding: 'utf8',
        env,
      });
      assert.strictEqual(
        installResult.status,
        0,
        `install failed\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`,
      );

      const foreignSkill = path.join(tmpConfig, 'skills', 'user-custom-skill', 'SKILL.md');
      const foreignRootAgent = path.join(tmpConfig, 'agents', 'user-agent.yaml');
      const foreignSubagent = path.join(tmpConfig, 'agents', 'subagents', 'user-agent.yaml');
      fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
      fs.mkdirSync(path.dirname(foreignSubagent), { recursive: true });
      fs.writeFileSync(foreignSkill, '# user skill\n', 'utf8');
      fs.writeFileSync(foreignRootAgent, 'version: 1\n', 'utf8');
      fs.writeFileSync(foreignSubagent, 'version: 1\n', 'utf8');

      const uninstallResult = spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--uninstall'],
        {
          cwd: tmpProject,
          encoding: 'utf8',
          env,
        },
      );
      assert.strictEqual(
        uninstallResult.status,
        0,
        `uninstall failed\nstdout: ${uninstallResult.stdout}\nstderr: ${uninstallResult.stderr}`,
      );
      assert.match(`${uninstallResult.stdout}\n${uninstallResult.stderr}`, /Kimi CLI/);

      assert.ok(!fs.existsSync(path.join(tmpConfig, 'skills', 'gsd-new-project')), 'must remove generated Kimi skills');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'gsd.yaml')), 'must remove Kimi root agent YAML');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'gsd.md')), 'must remove Kimi root agent prompt');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.yaml')), 'must remove generated Kimi subagent YAML');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md')), 'must remove generated Kimi subagent prompt');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'gsd-core')), 'must remove installed workflow payload');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'gsd-file-manifest.json')), 'must remove the manifest');

      assert.ok(fs.existsSync(foreignSkill), 'must preserve non-GSD Kimi skills');
      assert.ok(fs.existsSync(foreignRootAgent), 'must preserve non-GSD root agents');
      assert.ok(fs.existsSync(foreignSubagent), 'must preserve non-GSD subagents');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });
});

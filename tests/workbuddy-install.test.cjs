// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  getConfigDirFromHome,
  convertClaudeToWorkbuddyMarkdown,
  convertClaudeCommandToWorkbuddySkill,
  convertClaudeAgentToWorkbuddyAgent,
  install,
  uninstall,
  writeManifest,
} = require('../bin/install.js');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { getDirName } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

// ─── Profile resolution for installRuntimeArtifacts tests ────────────────────
const _gsdLibDir = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const { loadSkillsManifest, resolveProfile } = require(path.join(_gsdLibDir, 'install-profiles.cjs'));
const _manifest = loadSkillsManifest();
const resolvedProfileFull = resolveProfile({ modes: [], manifest: _manifest });

describe('WorkBuddy runtime directory mapping', () => {
  test('maps WorkBuddy to .workbuddy for local installs', () => {
    assert.strictEqual(getDirName('workbuddy'), '.workbuddy');
  });

  test('maps WorkBuddy to ~/.workbuddy for global installs', () => {
    assert.strictEqual(getGlobalConfigDir('workbuddy'), path.join(os.homedir(), '.workbuddy'));
  });

  test('returns .workbuddy config fragments for local and global installs', () => {
    assert.strictEqual(getConfigDirFromHome('workbuddy', false), "'.workbuddy'");
    assert.strictEqual(getConfigDirFromHome('workbuddy', true), "'.workbuddy'");
  });
});

describe('getGlobalConfigDir (WorkBuddy)', () => {
  let originalWorkbuddyConfigDir;

  beforeEach(() => {
    originalWorkbuddyConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalWorkbuddyConfigDir !== undefined) {
      process.env.WORKBUDDY_CONFIG_DIR = originalWorkbuddyConfigDir;
    } else {
      delete process.env.WORKBUDDY_CONFIG_DIR;
    }
  });

  test('returns ~/.workbuddy with no env var or explicit dir', () => {
    delete process.env.WORKBUDDY_CONFIG_DIR;
    const result = getGlobalConfigDir('workbuddy');
    assert.strictEqual(result, path.join(os.homedir(), '.workbuddy'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalConfigDir('workbuddy', '/custom/workbuddy-path');
    assert.strictEqual(result, '/custom/workbuddy-path');
  });

  test('respects WORKBUDDY_CONFIG_DIR env var', () => {
    process.env.WORKBUDDY_CONFIG_DIR = '~/custom-workbuddy';
    const result = getGlobalConfigDir('workbuddy');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-workbuddy'));
  });

  test('explicit dir takes priority over WORKBUDDY_CONFIG_DIR', () => {
    process.env.WORKBUDDY_CONFIG_DIR = '~/from-env';
    const result = getGlobalConfigDir('workbuddy', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalConfigDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalConfigDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('WorkBuddy markdown conversion', () => {
  test('converts Claude-specific references to WorkBuddy equivalents', () => {
    const input = [
      'Claude Code reads CLAUDE.md before using .claude/skills/.',
      'Run /gsd:plan-phase with $ARGUMENTS.',
      'Use Bash(command) and Edit(file).',
    ].join('\n');

    const result = convertClaudeToWorkbuddyMarkdown(input);

    // #4952: WorkBuddy reads CODEBUDDY.md (same host file as CodeBuddy, since
    // WorkBuddy is built on the CodeBuddy Code core), but resolves the
    // *config* root as .workbuddy/ — so the path family is split-correct.
    assert.ok(result.includes('WorkBuddy reads CODEBUDDY.md before using .workbuddy/skills/.'), result);
    assert.ok(result.includes('/gsd-plan-phase'), result);
    // #4952 (key difference from CodeBuddy): WorkBuddy preserves $ARGUMENTS
    // verbatim — its built-in commands interpolate it natively. CodeBuddy
    // rewrites to {{GSD_ARGS}}; WorkBuddy MUST NOT.
    assert.ok(result.includes('$ARGUMENTS'), 'WorkBuddy must preserve $ARGUMENTS verbatim');
    assert.ok(!result.includes('{{GSD_ARGS}}'), 'WorkBuddy must NOT rewrite $ARGUMENTS to {{GSD_ARGS}}');
    // WorkBuddy uses the same tool names as Claude Code — no conversion needed
    assert.ok(result.includes('Bash('), result);
    assert.ok(result.includes('Edit('), result);
  });

  test('converts commands and agents to WorkBuddy frontmatter', () => {
    const command = `---
name: gsd:new-project
description: Initialize a project
---

Use .claude/skills/ and /gsd:help.
`;
    const agent = `---
name: gsd-planner
description: Planner agent
tools: Read, Write
color: blue
---

Read CLAUDE.md before acting.
`;

    const convertedCommand = convertClaudeCommandToWorkbuddySkill(command, 'gsd-new-project');
    const convertedAgent = convertClaudeAgentToWorkbuddyAgent(agent);

    assert.ok(convertedCommand.includes('name: gsd-new-project'), convertedCommand);
    assert.ok(convertedCommand.includes('.workbuddy/skills/'), convertedCommand);
    assert.ok(convertedCommand.includes('/gsd-help'), convertedCommand);

    assert.ok(convertedAgent.includes('name: gsd-planner'), convertedAgent);
    assert.ok(!convertedAgent.includes('color:'), convertedAgent);
    assert.ok(convertedAgent.includes('CODEBUDDY.md'), convertedAgent);
  });
});

describe('installRuntimeArtifacts (workbuddy integration)', () => {
  // Output layout: <configDir>/skills/gsd-<stem>/SKILL.md (destSubpath='skills', prefix='gsd-').
  // Mirrors the codebuddy install path; WorkBuddy shares the same descriptor shape.
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-workbuddy-copy-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('creates one skill directory per GSD command', () => {
    installRuntimeArtifacts('workbuddy', configDir, 'local', resolvedProfileFull);

    const generated = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(generated), generated);

    const content = fs.readFileSync(generated, 'utf8');
    assert.ok(content.includes('name: gsd-help'), content);
  });
});

describe('WorkBuddy local install/uninstall', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-workbuddy-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.workbuddy and removes it cleanly', () => {
    const result = install(false, 'workbuddy');
    const targetDir = path.join(tmpDir, '.workbuddy');

    // WorkBuddy supports settings.json hooks (Claude Code compatible, same as CodeBuddy)
    assert.strictEqual(result.runtime, 'workbuddy');
    assert.ok(result.settingsPath, 'should have settingsPath (WorkBuddy supports hooks)');

    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gsd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'workbuddy');
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('skills/gsd-help/')), JSON.stringify(manifest));

    uninstall(false, 'workbuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gsd-help')), 'WorkBuddy skill directory removed');
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')), 'gsd-core removed');
  });
});

describe('E2E: WorkBuddy uninstall skills cleanup', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-workbuddy-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes all gsd-* skill directories on --workbuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.workbuddy');
    install(false, 'workbuddy');

    const skillsDir = path.join(targetDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills dir exists after install');

    const installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(installedSkills.length > 0, `found ${installedSkills.length} gsd-* skill dirs before uninstall`);

    uninstall(false, 'workbuddy');

    if (fs.existsSync(skillsDir)) {
      const remainingGsd = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(remainingGsd.length, 0,
        `Expected 0 gsd-* skill dirs after uninstall, found: ${remainingGsd.map(e => e.name).join(', ')}`);
    }
  });

  test('preserves non-GSD skill directories during --workbuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.workbuddy');
    install(false, 'workbuddy');

    const customSkillDir = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')), 'custom skill exists before uninstall');

    uninstall(false, 'workbuddy');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')),
      'Non-GSD skill directory should be preserved after WorkBuddy uninstall');
  });

  test('removes engine directory on --workbuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.workbuddy');
    install(false, 'workbuddy');

    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')),
      'engine exists before uninstall');

    uninstall(false, 'workbuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')),
      'gsd-core engine should be removed after WorkBuddy uninstall');
  });
});

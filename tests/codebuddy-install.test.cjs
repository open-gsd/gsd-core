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
  getDirName,
  getGlobalDir,
  getConfigDirFromHome,
  convertClaudeToCodebuddyMarkdown,
  convertClaudeCommandToCodebuddySkill,
  convertClaudeAgentToCodebuddyAgent,
  install,
  uninstall,
  writeManifest,
  installRuntimeArtifacts,
} = require('../bin/install.js');

// ─── Profile resolution for installRuntimeArtifacts tests ────────────────────
const _gsdLibDir = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const { loadSkillsManifest, resolveProfile } = require(path.join(_gsdLibDir, 'install-profiles.cjs'));
const _manifest = loadSkillsManifest();
const resolvedProfileFull = resolveProfile({ modes: [], manifest: _manifest });

describe('CodeBuddy runtime directory mapping', () => {
  test('maps CodeBuddy to .codebuddy for local installs', () => {
    assert.strictEqual(getDirName('codebuddy'), '.codebuddy');
  });

  test('maps CodeBuddy to ~/.codebuddy for global installs', () => {
    assert.strictEqual(getGlobalDir('codebuddy'), path.join(os.homedir(), '.codebuddy'));
  });

  test('returns .codebuddy config fragments for local and global installs', () => {
    assert.strictEqual(getConfigDirFromHome('codebuddy', false), "'.codebuddy'");
    assert.strictEqual(getConfigDirFromHome('codebuddy', true), "'.codebuddy'");
  });
});

describe('getGlobalDir (CodeBuddy)', () => {
  let originalCodebuddyConfigDir;

  beforeEach(() => {
    originalCodebuddyConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalCodebuddyConfigDir !== undefined) {
      process.env.CODEBUDDY_CONFIG_DIR = originalCodebuddyConfigDir;
    } else {
      delete process.env.CODEBUDDY_CONFIG_DIR;
    }
  });

  test('returns ~/.codebuddy with no env var or explicit dir', () => {
    delete process.env.CODEBUDDY_CONFIG_DIR;
    const result = getGlobalDir('codebuddy');
    assert.strictEqual(result, path.join(os.homedir(), '.codebuddy'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalDir('codebuddy', '/custom/codebuddy-path');
    assert.strictEqual(result, '/custom/codebuddy-path');
  });

  test('respects CODEBUDDY_CONFIG_DIR env var', () => {
    process.env.CODEBUDDY_CONFIG_DIR = '~/custom-codebuddy';
    const result = getGlobalDir('codebuddy');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-codebuddy'));
  });

  test('explicit dir takes priority over CODEBUDDY_CONFIG_DIR', () => {
    process.env.CODEBUDDY_CONFIG_DIR = '~/from-env';
    const result = getGlobalDir('codebuddy', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('CodeBuddy markdown conversion', () => {
  test('converts Claude-specific references to CodeBuddy equivalents', () => {
    const input = [
      'Claude Code reads CLAUDE.md before using .claude/skills/.',
      'Run /gsd:plan-phase with $ARGUMENTS.',
      'Use Bash(command) and Edit(file).',
    ].join('\n');

    const result = convertClaudeToCodebuddyMarkdown(input);

    assert.ok(result.includes('CodeBuddy reads CODEBUDDY.md before using .codebuddy/skills/.'), result);
    assert.ok(result.includes('/gsd-plan-phase'), result);
    assert.ok(result.includes('{{GSD_ARGS}}'), result);
    // CodeBuddy uses the same tool names as Claude Code — no conversion needed
    assert.ok(result.includes('Bash('), result);
    assert.ok(result.includes('Edit('), result);
  });

  test('converts commands and agents to CodeBuddy frontmatter', () => {
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

    const convertedCommand = convertClaudeCommandToCodebuddySkill(command, 'gsd-new-project');
    const convertedAgent = convertClaudeAgentToCodebuddyAgent(agent);

    assert.ok(convertedCommand.includes('name: gsd-new-project'), convertedCommand);
    assert.ok(convertedCommand.includes('.codebuddy/skills/'), convertedCommand);
    assert.ok(convertedCommand.includes('/gsd-help'), convertedCommand);

    assert.ok(convertedAgent.includes('name: gsd-planner'), convertedAgent);
    assert.ok(!convertedAgent.includes('color:'), convertedAgent);
    assert.ok(convertedAgent.includes('CODEBUDDY.md'), convertedAgent);
  });
});

describe('installRuntimeArtifacts (codebuddy integration)', () => {
  // Pivoted from copyCommandsAsCodebuddySkills(srcDir, skillsDir, 'gsd', '$HOME/.codebuddy/', 'codebuddy')
  // shim to installRuntimeArtifacts('codebuddy', configDir, 'local', resolvedProfileFull).
  // Output layout: <configDir>/skills/gsd-<stem>/SKILL.md (destSubpath='skills', prefix='gsd-').
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-codebuddy-copy-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  test('creates one skill directory per GSD command', () => {
    installRuntimeArtifacts('codebuddy', configDir, 'local', resolvedProfileFull);

    const generated = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(generated), generated);

    const content = fs.readFileSync(generated, 'utf8');
    assert.ok(content.includes('name: gsd-help'), content);
  });
});

describe('CodeBuddy local install/uninstall', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-codebuddy-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.codebuddy and removes it cleanly', () => {
    const result = install(false, 'codebuddy');
    const targetDir = path.join(tmpDir, '.codebuddy');

    // CodeBuddy supports settings.json hooks (Claude Code compatible)
    assert.strictEqual(result.runtime, 'codebuddy');
    assert.ok(result.settingsPath, 'should have settingsPath (CodeBuddy supports hooks)');

    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gsd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'codebuddy');
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('skills/gsd-help/')), JSON.stringify(manifest));

    uninstall(false, 'codebuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gsd-help')), 'CodeBuddy skill directory removed');
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')), 'gsd-core removed');
  });
});

describe('CodeBuddy artifact surface (#789)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-codebuddy-surface-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('emits gsd-* subagent manifests, converted to CodeBuddy frontmatter', () => {
    install(false, 'codebuddy');
    const agentsDir = path.join(tmpDir, '.codebuddy', 'agents');

    assert.ok(fs.existsSync(agentsDir), 'agents/ directory exists after install');

    // The full surface staged from agents/ is emitted, not a stray single file
    // (the shared loop in bin/install.js copies every staged agent). Lock a
    // meaningful floor so a regression that drops most manifests fails here.
    const sourceAgentCount = fs.readdirSync(path.join(__dirname, '..', 'agents'))
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const agentFiles = fs.readdirSync(agentsDir)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(sourceAgentCount > 0, 'sanity: repo ships gsd-* source agents');
    assert.strictEqual(agentFiles.length, sourceAgentCount,
      `expected every gsd-* source agent emitted (${sourceAgentCount}), found ${agentFiles.length}: ${agentFiles.join(', ')}`);

    // EVERY manifest must be CodeBuddy-converted: a name: gsd- field inside the
    // leading YAML frontmatter block, and no leftover Claude home-dir refs.
    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, `${file}: expected a leading YAML frontmatter block`);
      assert.ok(/^name:\s*gsd-/m.test(fmMatch[1]),
        `${file}: frontmatter should declare a gsd- name:\n${fmMatch[1]}`);
      assert.ok(!content.includes('~/.claude/'),
        `${file}: should not retain ~/.claude/ references after CodeBuddy conversion`);
    }
  });

  test('skills are user-invocable by default (slash-accessible), i.e. never marked user-invocable: false', () => {
    install(false, 'codebuddy');
    const skillsDir = path.join(tmpDir, '.codebuddy', 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory exists after install');

    const gsdSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(gsdSkills.length > 0, 'at least one gsd-* skill dir is emitted');

    // CodeBuddy hides a skill from the `/` menu only when `user-invocable: false`
    // (docs/cli/skills). GSD must never emit that, or the workflow would vanish
    // from the slash menu — this is CodeBuddy's slash-command surface (#789).
    for (const skill of gsdSkills) {
      const skillMd = path.join(skillsDir, skill.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `${skill.name}/ must contain a SKILL.md`);
      const content = fs.readFileSync(skillMd, 'utf8');
      assert.ok(!/^user-invocable:\s*false\b/mi.test(content),
        `${skill.name}/SKILL.md must not set user-invocable: false (would hide it from the / menu)`);
    }
  });
});

describe('E2E: CodeBuddy uninstall skills cleanup', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-codebuddy-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes all gsd-* skill directories on --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    const skillsDir = path.join(targetDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills dir exists after install');

    const installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(installedSkills.length > 0, `found ${installedSkills.length} gsd-* skill dirs before uninstall`);

    uninstall(false, 'codebuddy');

    if (fs.existsSync(skillsDir)) {
      const remainingGsd = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(remainingGsd.length, 0,
        `Expected 0 gsd-* skill dirs after uninstall, found: ${remainingGsd.map(e => e.name).join(', ')}`);
    }
  });

  test('preserves non-GSD skill directories during --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    const customSkillDir = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')), 'custom skill exists before uninstall');

    uninstall(false, 'codebuddy');

    assert.ok(fs.existsSync(path.join(customSkillDir, 'SKILL.md')),
      'Non-GSD skill directory should be preserved after CodeBuddy uninstall');
  });

  test('removes engine directory on --codebuddy --uninstall', () => {
    const targetDir = path.join(tmpDir, '.codebuddy');
    install(false, 'codebuddy');

    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')),
      'engine exists before uninstall');

    uninstall(false, 'codebuddy');

    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')),
      'gsd-core engine should be removed after CodeBuddy uninstall');
  });
});

// allow-test-rule: cli-output-is-the-product
// OMP readiness and install summaries are the user-facing CLI contract for native extension support.
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createTempDir,
  cleanup,
  captureConsole,
  parseFrontmatter,
} = require('./helpers.cjs');

const {
  getDirName,
  getGlobalConfigDir,
  getConfigDirFromHome,
  install,
  uninstall,
  writeManifest,
  detectGsdWorkspaceState,
  getOmpReadinessSummary,
} = require('../bin/install.js');

const INSTALLER = path.join(__dirname, '..', 'bin', 'install.js');

function installerEnv(extra = {}) {
  const env = { ...process.env, GSD_SKIP_STALE_SDK_CHECK: '1', ...extra };
  delete env.GSD_TEST_MODE;
  return env;
}

function runInstallerCli(cwd, args, extraEnv = {}) {
  return execFileSync(process.execPath, [INSTALLER, ...args], {
    cwd,
    env: installerEnv(extraEnv),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

function listGsdEntries(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(predicate)
    .map(entry => entry.name)
    .sort();
}

function readManifest(targetDir) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, 'gsd-file-manifest.json'), 'utf8'));
}

describe('OMP runtime directory mapping', () => {
  let savedOmpConfigDir;

  beforeEach(() => {
    savedOmpConfigDir = process.env.OMP_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedOmpConfigDir === undefined) delete process.env.OMP_CONFIG_DIR;
    else process.env.OMP_CONFIG_DIR = savedOmpConfigDir;
  });

  test('maps OMP local and global locations', () => {
    delete process.env.OMP_CONFIG_DIR;
    assert.strictEqual(getDirName('omp'), '.omp');
    assert.strictEqual(getConfigDirFromHome('omp', false), "'.omp'");
    assert.strictEqual(getConfigDirFromHome('omp', true), "'.omp', 'agent'");
    assert.strictEqual(getGlobalConfigDir('omp'), path.join(require('node:os').homedir(), '.omp', 'agent'));
  });

  test('respects OMP_CONFIG_DIR and explicit global override', () => {
    process.env.OMP_CONFIG_DIR = '~/custom-omp-agent';
    assert.strictEqual(getGlobalConfigDir('omp'), path.join(require('node:os').homedir(), 'custom-omp-agent'));
    assert.strictEqual(getGlobalConfigDir('omp', '/explicit/omp'), '/explicit/omp');
  });
});

describe('OMP local install and conversion', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-omp-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs commands, skills, agents, rules, extensions, manifest entries, and readiness output', () => {
    const captured = captureConsole(() => {
      const result = install(false, 'omp');
      assert.strictEqual(result.runtime, 'omp');
      assert.strictEqual(result.settingsPath, null);
    });

    const targetDir = path.join(tmpDir, '.omp');
    assert.ok(fs.existsSync(path.join(targetDir, 'commands', 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gsd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents', 'gsd-planner.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'rules', 'gsd-planning-artifacts.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'gsd-core', 'index.js')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'gsd-core', 'package.json')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'gsd-core', 'update-worker.js')));

    const commandFm = parseFrontmatter(fs.readFileSync(path.join(targetDir, 'commands', 'gsd-help.md'), 'utf8'));
    assert.strictEqual(commandFm.name, 'gsd-help');
    const agentFm = parseFrontmatter(fs.readFileSync(path.join(targetDir, 'agents', 'gsd-planner.md'), 'utf8'));
    assert.ok(agentFm.name.startsWith('gsd-'));
    assert.ok(agentFm.description.length > 0);

    const manifest = readManifest(targetDir);
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('commands/gsd-help.md')));
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('skills/gsd-help/')));
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('agents/gsd-planner.md')));
    assert.ok(Object.keys(manifest.files).some(file => file.startsWith('rules/gsd-planning-artifacts.md')));
    assert.ok(Object.keys(manifest.files).includes('extensions/gsd-core/index.js'));
    assert.ok(Object.keys(manifest.files).every(file => !file.startsWith('hooks/')));

    assert.match(captured.stdout, /OMP readiness: target=\.[/\\]\.omp/);
    assert.match(captured.stdout, /Existing GSD state: fresh; next action: \/gsd-new-project/);
    assert.match(captured.stdout, /extensions=1/);
    assert.doesNotMatch(captured.stdout, /degraded/i);
    assert.doesNotMatch(captured.stdout, /Executable GSD hooks/);
  });

  test('converts copied gsd-core payload Markdown for local OMP install', () => {
    install(false, 'omp');

    const workflow = fs.readFileSync(
      path.join(tmpDir, '.omp', 'gsd-core', 'workflows', 'discuss-phase.md'),
      'utf8',
    ).replace(/\\/g, '/');

    assert.ok(workflow.includes('After every Ask call'));
    assert.ok(!workflow.includes('AskUserQuestion'));
    assert.ok(!workflow.includes('~/.claude/'));
    assert.ok(!workflow.includes('$HOME/.claude/'));
    assert.ok(!workflow.includes('./.claude/'));
    assert.ok(!workflow.includes('.claude/'));
    assert.ok(workflow.includes('./.omp/skills/spike-findings-'));
  });

  test('embeds project model_overrides in OMP agent frontmatter', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'inherit',
      model_overrides: {
        'gsd-planner': 'plan',
      },
    }, null, 2) + '\n');

    install(false, 'omp');

    const agentFm = parseFrontmatter(
      fs.readFileSync(path.join(tmpDir, '.omp', 'agents', 'gsd-planner.md'), 'utf8'),
    );
    assert.strictEqual(agentFm.model, 'pi/plan');
  });

  test('profile-limited CLI install keeps core capabilities smaller than full install', () => {
    runInstallerCli(tmpDir, ['--local', '--omp', '--profile=core']);
    const targetDir = path.join(tmpDir, '.omp');
    const commands = listGsdEntries(path.join(targetDir, 'commands'), e => e.isFile() && e.name.startsWith('gsd-'));
    assert.ok(commands.includes('gsd-help.md'));
    assert.ok(commands.includes('gsd-new-project.md'));
    assert.ok(commands.length < 20, `core profile should be small, got ${commands.length}`);
  });

  test('reinstall and uninstall preserve non-GSD OMP artifacts', () => {
    install(false, 'omp');
    const targetDir = path.join(tmpDir, '.omp');
    fs.writeFileSync(path.join(targetDir, 'commands', 'user-command.md'), '# User command\n');
    fs.mkdirSync(path.join(targetDir, 'skills', 'user-skill'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'skills', 'user-skill', 'SKILL.md'), '# User skill\n');
    fs.writeFileSync(path.join(targetDir, 'agents', 'user-agent.md'), '# User agent\n');
    fs.writeFileSync(path.join(targetDir, 'rules', 'user-rule.md'), '# User rule\n');
    fs.mkdirSync(path.join(targetDir, 'extensions', 'user-extension'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'extensions', 'user-extension', 'index.js'), 'module.exports = () => {};\\n');

    install(false, 'omp');
    assert.ok(fs.existsSync(path.join(targetDir, 'commands', 'user-command.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'user-skill', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents', 'user-agent.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'rules', 'user-rule.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'user-extension', 'index.js')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'gsd-core', 'index.js')));

    uninstall(false, 'omp');
    assert.ok(fs.existsSync(path.join(targetDir, 'commands', 'user-command.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'user-skill', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents', 'user-agent.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'rules', 'user-rule.md')));
    assert.ok(fs.existsSync(path.join(targetDir, 'extensions', 'user-extension', 'index.js')));
    assert.ok(!fs.existsSync(path.join(targetDir, 'extensions', 'gsd-core', 'index.js')));
    assert.ok(!fs.existsSync(path.join(targetDir, 'commands', 'gsd-help.md')));
  });

  test('detects existing Spec Kit workspace state and exposes next action', () => {
    fs.mkdirSync(path.join(tmpDir, 'specs', '001-demo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'specs', '001-demo', 'spec.md'), '# Spec\n');
    assert.deepStrictEqual(detectGsdWorkspaceState(tmpDir), { state: 'spec-ready', nextAction: '/speckit.plan' });
    fs.writeFileSync(path.join(tmpDir, 'specs', '001-demo', 'plan.md'), '# Plan\n');
    assert.deepStrictEqual(detectGsdWorkspaceState(tmpDir), { state: 'plan-ready', nextAction: '/speckit.tasks' });
    fs.writeFileSync(path.join(tmpDir, 'specs', '001-demo', 'tasks.md'), '# Tasks\n');
    assert.deepStrictEqual(detectGsdWorkspaceState(tmpDir), { state: 'tasks-ready', nextAction: '/speckit.implement' });
  });

  test('summarizes planning-to-handoff and cross-runtime alternation compatibility', () => {
    runInstallerCli(tmpDir, ['--local', '--omp']);
    runInstallerCli(tmpDir, ['--local', '--opencode']);
    runInstallerCli(tmpDir, ['--local', '--omp']);
    runInstallerCli(tmpDir, ['--local', '--kilo']);
    runInstallerCli(tmpDir, ['--local', '--omp']);

    const targetDir = path.join(tmpDir, '.omp');
    const summary = getOmpReadinessSummary(targetDir, tmpDir);
    assert.ok(summary.counts.commands > 0);
    assert.ok(summary.counts.skills > 0);
    assert.ok(summary.counts.agents > 0);
    assert.ok(summary.counts.rules > 0);
    assert.strictEqual(summary.counts.extensions, 1);
    assert.ok(fs.existsSync(path.join(tmpDir, '.opencode', 'command', 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.kilo', 'command', 'gsd-help.md')));
  });

  test('writeManifest tracks OMP artifacts without hooks', () => {
    install(false, 'omp');
    const targetDir = path.join(tmpDir, '.omp');
    const manifest = writeManifest(targetDir, 'omp');
    const keys = Object.keys(manifest.files);
    assert.ok(keys.some(file => file.startsWith('commands/gsd-help.md')));
    assert.ok(keys.some(file => file.startsWith('rules/gsd-planning-artifacts.md')));
    assert.ok(keys.includes('extensions/gsd-core/index.js'));
    assert.ok(keys.includes('extensions/gsd-core/package.json'));
    assert.ok(keys.includes('extensions/gsd-core/update-worker.js'));
    assert.ok(keys.every(file => !file.startsWith('hooks/')));
  });
});

describe('OMP global install', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-omp-global-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('uses OMP_CONFIG_DIR for global CLI install target', () => {
    const target = path.join(tmpDir, 'omp-agent-home');
    const output = runInstallerCli(tmpDir, ['--global', '--omp'], { OMP_CONFIG_DIR: target });
    assert.ok(fs.existsSync(path.join(target, 'commands', 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(target, 'skills', 'gsd-help', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(target, 'agents', 'gsd-planner.md')));
    assert.ok(fs.existsSync(path.join(target, 'extensions', 'gsd-core', 'index.js')));
    assert.ok(fs.existsSync(path.join(target, 'extensions', 'gsd-core', 'package.json')));
    assert.ok(fs.existsSync(path.join(target, 'extensions', 'gsd-core', 'update-worker.js')));
    const command = fs.readFileSync(path.join(target, 'commands', 'gsd-help.md'), 'utf8').replace(/\\/g, '/');
    const normalizedTarget = target.replace(/\\/g, '/');
    assert.ok(command.includes(`${normalizedTarget}/gsd-core/workflows/help.md`));
    assert.ok(!command.includes('.omp/gsd-core'), 'global OMP commands must not point at project-local .omp');
    assert.match(output, /Installing for .*OMP/);
    assert.match(output, /OMP readiness: target=/);
    assert.match(output, /extensions=1/);
    const workflow = fs.readFileSync(
      path.join(target, 'gsd-core', 'workflows', 'discuss-phase.md'),
      'utf8',
    ).replace(/\\/g, '/');
    assert.ok(workflow.includes('After every Ask call'));
    assert.ok(!workflow.includes('AskUserQuestion'));
    assert.ok(!workflow.includes('~/.claude/'));
    assert.ok(!workflow.includes('$HOME/.claude/'));
    assert.ok(!workflow.includes('./.claude/'));
    assert.ok(!workflow.includes('.claude/'));
    assert.ok(!workflow.includes('./.omp/gsd-core'), 'global OMP payloads must not point at project-local .omp');
    assert.ok(workflow.includes(`${normalizedTarget}/gsd-core/USER-PROFILE.md`));
    assert.ok(workflow.includes(`${normalizedTarget}/skills/spike-findings-`));
  });
});

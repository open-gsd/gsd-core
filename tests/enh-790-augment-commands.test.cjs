'use strict';
/**
 * Regression guard — enh(#790): Augment commands/ emitted alongside skills/.
 *
 * Verifies that a global Augment install writes:
 *   - commands/gsd-<stem>.md  (slash command definitions)
 *   - skills/gsd-<stem>/SKILL.md  (existing skill definitions)
 *
 * mcpServers in settings.json is explicitly excluded: gsd ships no MCP server
 * and registering third-party servers is out of scope for the installer.
 *
 * Ref: https://docs.augmentcode.com/cli/reference — ~/.augment/commands/<name>.md
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { installRuntimeArtifacts } = require('../bin/install.js');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── Layout contract ─────────────────────────────────────────────────────────

describe('enh-790 — augment layout has commands + skills kinds', () => {
  test('resolveRuntimeArtifactLayout augment returns 2 kinds', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    assert.strictEqual(layout.kinds.length, 2, 'augment must have exactly 2 artifact kinds');
    const kindNames = layout.kinds.map(k => k.kind).sort();
    assert.deepStrictEqual(kindNames, ['commands', 'skills']);
  });

  test('augment commands kind targets commands/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
  });

  test('augment skills kind targets skills/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
  });
});

// ─── Install contract ────────────────────────────────────────────────────────

describe('enh-790 — installRuntimeArtifacts augment emits both commands and skills', () => {
  test('global augment install: commands/gsd-help.md and skills/gsd-help/SKILL.md exist', (t) => {
    const configDir = createTempDir('gsd-enh790-augment-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    // Commands dir
    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ dir must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'at least one gsd-*.md command file must be installed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'commands/gsd-help.md must exist');

    // Skills dir (pre-existing behavior preserved)
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ dir must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')), 'skills/gsd-help/SKILL.md must exist');
  });

  test('commands/gsd-help.md has Augment-compatible content (no raw ~/.claude/ refs)', (t) => {
    const configDir = createTempDir('gsd-enh790-content-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    const helpCmd = path.join(configDir, 'commands', 'gsd-help.md');
    assert.ok(fs.existsSync(helpCmd), 'gsd-help.md must exist');
    const content = fs.readFileSync(helpCmd, 'utf8');
    // Should not have raw ~/.claude/ references after path rewrite
    assert.ok(!content.includes('~/.claude/'), 'commands must not contain raw ~/.claude/ refs');
  });

  test('command count matches skill count (profile parity)', (t) => {
    const configDir = createTempDir('gsd-enh790-parity-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    const commandsDir = path.join(configDir, 'commands');
    const skillsDir = path.join(configDir, 'skills');
    const cmdCount = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const skillCount = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
    assert.strictEqual(cmdCount, skillCount, 'command count must equal skill count for same profile');
  });

  test('full profile install does NOT mutate source commands/gsd/ files', (t) => {
    // Regression guard: stageSkillsForProfile returns the real source dir on full profile
    // (skills === '*'). applyRuntimeContentRewritesForCommandsInPlace must copy to temp
    // before rewriting — it must NEVER write back to the source tree.
    const { resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    assert.strictEqual(RESOLVED_FULL.skills, '*', 'full profile must have skills === "*"');

    const configDir = createTempDir('gsd-enh790-full-');
    t.after(() => cleanup(configDir));

    // Record source file content before install
    const srcHelpPath = path.join(__dirname, '..', 'commands', 'gsd', 'help.md');
    const srcContentBefore = fs.readFileSync(srcHelpPath, 'utf8');

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL);

    // Source file must be identical after install
    const srcContentAfter = fs.readFileSync(srcHelpPath, 'utf8');
    assert.strictEqual(srcContentBefore, srcContentAfter,
      'source commands/gsd/help.md must not be mutated by the install');

    // Installed command file must have rewrites applied (Augment path substitution)
    const installedHelp = path.join(configDir, 'commands', 'gsd-help.md');
    assert.ok(fs.existsSync(installedHelp), 'installed gsd-help.md must exist');
    const installedContent = fs.readFileSync(installedHelp, 'utf8');
    assert.ok(!installedContent.includes('~/.claude/'), 'installed command must not have raw ~/.claude/ refs');
  });
});

describe('enh-790 — installRuntimeArtifacts does not leak temp dirs', () => {
  test('install cleans up gsd-cmd-rewrites-* temp dirs (no leak) — #856', (t) => {
    const { resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });

    // Isolate os.tmpdir() to a private root so parallel test processes can't race
    // on the shared system temp dir. os.tmpdir() resolves $TMPDIR/$TEMP/$TMP per call.
    const isolatedTmp = createTempDir('gsd-enh790-tmproot-');
    const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = isolatedTmp;
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;

    const configDir = createTempDir('gsd-enh790-leak-');
    t.after(() => {
      for (const k of ['TMPDIR', 'TEMP', 'TMP']) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      cleanup(configDir);
      cleanup(isolatedTmp);
    });

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL);

    // The install creates its gsd-cmd-rewrites-* temp dirs under the isolated root;
    // after the fix none must remain.
    const leaked = fs.readdirSync(isolatedTmp).filter(n => n.startsWith('gsd-cmd-rewrites-'));
    assert.ok(
      leaked.length === 0,
      `installer must not leak gsd-cmd-rewrites-* temp dirs; leaked: ${leaked.join(', ')}`
    );
  });
});

// ─── Uninstall contract ──────────────────────────────────────────────────────

describe('enh-790 — uninstallRuntimeArtifacts removes augment commands', () => {
  test('uninstall removes gsd-* commands but preserves user commands', (t) => {
    const configDir = createTempDir('gsd-enh790-uninstall-');
    t.after(() => cleanup(configDir));

    const { uninstallRuntimeArtifacts } = require('../bin/install.js');

    // Pre-create: a GSD command + a user-owned command
    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# help\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# user\n');

    uninstallRuntimeArtifacts('augment', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'gsd-help.md must be removed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')), 'user-custom.md must be preserved');
  });
});

// ─── mcpServers exclusion ────────────────────────────────────────────────────

describe('enh-790 — mcpServers excluded (gsd ships no MCP server)', () => {
  test('augment install does not write settings.json mcpServers', (t) => {
    const configDir = createTempDir('gsd-enh790-mcp-excluded-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    // No settings.json with mcpServers should be written by the layout
    const settingsPath = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(!settings.mcpServers, 'settings.json must not contain mcpServers (gsd ships no MCP server)');
    }
    // If no settings.json at all, that is also correct
  });
});

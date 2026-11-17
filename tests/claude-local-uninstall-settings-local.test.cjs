/**
 * #5952: a local Claude install registers its hooks and GSD permission entries in
 * `.claude/settings.local.json` (#338), so a local uninstall must clean that file, not
 * only the shared `settings.json`.
 *
 * Oracle: the installer's own output. The registrations are produced by a real
 * `--claude --local` install, and what counts as GSD-managed is decided by the shipped
 * recognizer (`isManagedHookCommand`, settings-json surface), not by a hand-written list.
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const INSTALL = path.join(__dirname, '..', 'bin', 'install.js');
const GSD_PERMISSION = 'Read(.planning/*)';

describe('local Claude uninstall cleans settings.local.json (#5952)', () => {
  let project;
  let home;

  beforeEach(() => {
    project = createTempDir('gsd-5952-project-');
    home = createTempDir('gsd-5952-home-');
  });

  afterEach(() => {
    cleanup(project);
    cleanup(home);
  });

  function installer(args) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.GSD_ALLOW_SYMLINKED_DEST;
    // bin/install.js runs its CLI main block only when GSD_TEST_MODE is unset (the test runner sets it).
    delete env.GSD_TEST_MODE;
    const result = runNode([INSTALL, '--claude', ...args], { cwd: project, env });
    assert.strictEqual(result.exitCode, 0, `installer ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  const localSettingsPath = () => path.join(project, '.claude', 'settings.local.json');
  const sharedSettingsPath = () => path.join(project, '.claude', 'settings.json');
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  /** Every hook command string registered anywhere in a settings object. */
  function hookCommands(settings) {
    const commands = [];
    for (const entries of Object.values(settings.hooks || {})) {
      for (const entry of entries) {
        for (const hook of (entry && entry.hooks) || []) {
          if (hook && typeof hook.command === 'string') commands.push(hook.command);
        }
      }
    }
    return commands;
  }

  function managedCommands(settings) {
    const { isManagedHookCommand } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    return hookCommands(settings).filter((command) => isManagedHookCommand(command, { surface: 'settings-json' }));
  }

  test('removes every GSD hook command and GSD permission entry from settings.local.json', () => {
    installer(['--local']);
    const installed = readJson(localSettingsPath());
    assert.ok(managedCommands(installed).length > 0, 'the local install must register GSD hooks in settings.local.json');
    assert.ok(installed.permissions.allow.includes(GSD_PERMISSION), 'the local install must register the GSD permissions');

    installer(['--local', '--uninstall']);

    const after = readJson(localSettingsPath());
    assert.deepStrictEqual(managedCommands(after), [], 'no GSD-managed hook command may remain');
    assert.ok(!((after.permissions && after.permissions.allow) || []).includes(GSD_PERMISSION), 'no GSD permission entry may remain');
  });

  test('keeps user hooks, user permissions and other keys', () => {
    installer(['--local']);
    const settings = readJson(localSettingsPath());
    const userCommand = 'echo my-own-hook';
    // A user hook sharing a group with a GSD hook, and a user-only group.
    const sessionStart = settings.hooks.SessionStart;
    sessionStart[0].hooks.push({ type: 'command', command: userCommand });
    settings.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: userCommand }] }];
    settings.permissions.allow.push('Bash(git status)');
    settings.myOwnKey = { keep: true };
    fs.writeFileSync(localSettingsPath(), JSON.stringify(settings, null, 2));

    installer(['--local', '--uninstall']);

    const after = readJson(localSettingsPath());
    assert.deepStrictEqual(managedCommands(after), []);
    assert.strictEqual(hookCommands(after).filter((c) => c === userCommand).length, 2, 'both user hooks must survive');
    assert.ok(after.permissions.allow.includes('Bash(git status)'), 'the user permission must survive');
    assert.deepStrictEqual(after.myOwnKey, { keep: true });
  });

  test('also cleans a legacy GSD entry left in the shared settings.json', () => {
    installer(['--local']);
    const local = readJson(localSettingsPath());
    // An older install put the same registrations in the shared file.
    fs.writeFileSync(sharedSettingsPath(), JSON.stringify({ hooks: local.hooks }, null, 2));
    assert.ok(managedCommands(readJson(sharedSettingsPath())).length > 0);

    installer(['--local', '--uninstall']);

    assert.deepStrictEqual(managedCommands(readJson(sharedSettingsPath())), []);
    assert.deepStrictEqual(managedCommands(readJson(localSettingsPath())), []);
  });

  test('leaves an unparseable settings.local.json byte-identical and names it in the skip notice', () => {
    installer(['--local']);
    const broken = '{ "hooks": [\n';
    fs.writeFileSync(localSettingsPath(), broken);

    const result = installer(['--local', '--uninstall']);

    assert.strictEqual(fs.readFileSync(localSettingsPath(), 'utf8'), broken, 'the file must not be rewritten');
    const notice = splitLines(result.stdout).find((line) => line.includes('Skipping') && line.includes('settings.local.json'));
    assert.ok(notice, `the skip notice must name settings.local.json:\n${result.stdout}`);
  });

  test('global uninstall cleans the global settings.json and never touches a project settings.local.json', () => {
    installer(['--local']);
    installer(['--global']);
    const globalSettings = path.join(home, '.claude', 'settings.json');
    assert.ok(managedCommands(readJson(globalSettings)).length > 0, 'the global install must register GSD hooks in settings.json');
    const before = fs.readFileSync(localSettingsPath(), 'utf8');

    installer(['--global', '--uninstall']);

    assert.deepStrictEqual(managedCommands(readJson(globalSettings)), [], 'the global uninstall still cleans settings.json');
    assert.strictEqual(fs.readFileSync(localSettingsPath(), 'utf8'), before);
  });
});

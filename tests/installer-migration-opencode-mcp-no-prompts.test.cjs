'use strict';

/**
 * Installer migration 011: 2026-10-12-opencode-mcp-no-prompts (#5338; epic #5331, ADR-5331 D6).
 *
 * The GSD MCP companion used to advertise its prompt catalog, which OpenCode lists as a second set of
 * `gsd:<name>` slash commands. The migration adds `--no-prompts` to the `gsd` MCP entry GSD wrote, in the
 * 1.x `mcp.gsd` and 2.x `mcp.servers.gsd` locations, and edits a commented config as text.
 *
 * Coverage: metadata; 1.x entry; 2.x native entry; JSONC comments preserved (exact text outside the
 * command); user-edited and user-defined entries untouched; already-migrated and absent configs no-op;
 * unparseable config untouched; non-opencode runtimes ignored; second run is a no-op.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../gsd-core/bin/lib/installer-migrations/011-opencode-mcp-no-prompts.cjs');
const { planInstallerMigrations, applyInstallerMigrationPlan } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { parseJsonc } = require('../gsd-core/bin/lib/jsonc-edit.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

const PKG = '@opengsd/gsd-core';
const OLD_COMMAND = ['npx', '-y', '-p', PKG, 'gsd-mcp-server'];

function run(configDir, runtime = 'opencode', scope = 'global') {
  const plan = planInstallerMigrations({ configDir, runtime, scope, migrations: [migration] });
  assert.deepEqual(plan.blocked, []);
  if (plan.actions.length > 0) applyInstallerMigrationPlan({ configDir, plan });
  return plan;
}

function fixture(t, name, text) {
  const dir = createTempDir('gsd-migration-011-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('migration 011 metadata', () => {
  test('declares the required authoring fields', () => {
    assert.equal(migration.id, '2026-10-12-opencode-mcp-no-prompts');
    assert.deepEqual(migration.runtimes, ['opencode']);
    assert.deepEqual(migration.scopes, ['global', 'local']);
    assert.equal(migration.destructive, false);
    assert.equal(typeof migration.runtimeContract, 'string');
    assert.equal(typeof migration.plan, 'function');
  });
});

describe('migration 011: converges the GSD-written MCP entry', () => {
  test('1.x mcp.gsd gains --no-prompts and nothing else changes', (t) => {
    const dir = fixture(t, 'opencode.json', JSON.stringify({ theme: 'dark', mcp: { gsd: { type: 'local', command: OLD_COMMAND, enabled: true }, mine: { type: 'local', command: ['m'] } } }, null, 2));
    const plan = run(dir);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'rewrite-json');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.mcp.gsd, { type: 'local', command: [...OLD_COMMAND, '--no-prompts'], enabled: true });
    assert.deepEqual(cfg.mcp.mine, { type: 'local', command: ['m'] });
    assert.equal(cfg.theme, 'dark');
  });

  test('2.x native mcp.servers.gsd gains --no-prompts', (t) => {
    const dir = fixture(t, 'opencode.json', JSON.stringify({ mcp: { servers: { gsd: { type: 'local', command: OLD_COMMAND, disabled: false } } } }, null, 2));
    run(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.mcp.servers.gsd.command, [...OLD_COMMAND, '--no-prompts']);
    assert.equal(cfg.mcp.servers.gsd.disabled, false);
  });

  test('a pinned package version still matches the installer shape', (t) => {
    const pinned = ['npx', '-y', '-p', `${PKG}@1.16.0`, 'gsd-mcp-server'];
    const dir = fixture(t, 'opencode.json', JSON.stringify({ mcp: { gsd: { type: 'local', command: pinned, enabled: true } } }));
    run(dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).mcp.gsd.command, [...pinned, '--no-prompts']);
  });

  test('a commented opencode.jsonc keeps every comment and the text outside the command', (t) => {
    const original = `{
  // my provider notes
  "theme": "dark", // keep this note
  "mcp": {
    /* GSD companion */
    "gsd": { "type": "local", "command": ["npx", "-y", "-p", "${PKG}", "gsd-mcp-server"], "enabled": true },
  },
}
`;
    const dir = fixture(t, 'opencode.jsonc', original);
    run(dir);
    const after = fs.readFileSync(path.join(dir, 'opencode.jsonc'), 'utf8');
    for (const note of ['// my provider notes', '// keep this note', '/* GSD companion */']) assert.ok(after.includes(note), note);
    assert.deepEqual(parseJsonc(after).mcp.gsd.command, [...OLD_COMMAND, '--no-prompts']);
    assert.equal(after.replace(', "--no-prompts"', ''), original, 'only the command array changed');
  });
});

describe('migration 011: never touches what GSD did not write', () => {
  test('a user-edited gsd entry is left alone', (t) => {
    const text = JSON.stringify({ mcp: { gsd: { type: 'local', command: ['node', 'my-server.js'], enabled: true } } }, null, 2);
    const dir = fixture(t, 'opencode.json', text);
    assert.equal(run(dir).actions.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'), text);
  });

  test('an already-migrated entry, an absent config, and an unparseable config are no-ops', (t) => {
    const done = fixture(t, 'opencode.json', JSON.stringify({ mcp: { gsd: { type: 'local', command: [...OLD_COMMAND, '--no-prompts'] } } }));
    assert.equal(run(done).actions.length, 0);
    const empty = createTempDir('gsd-migration-011-empty-');
    t.after(() => cleanup(empty));
    assert.equal(run(empty).actions.length, 0);
    const broken = fixture(t, 'opencode.json', '{ "mcp": ');
    assert.equal(run(broken).actions.length, 0);
    assert.equal(fs.readFileSync(path.join(broken, 'opencode.json'), 'utf8'), '{ "mcp": ');
  });

  test('another runtime is never planned', (t) => {
    const dir = fixture(t, 'opencode.json', JSON.stringify({ mcp: { gsd: { type: 'local', command: OLD_COMMAND } } }));
    assert.equal(run(dir, 'kilo').actions.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).mcp.gsd.command.length, OLD_COMMAND.length);
  });

  test('running the migration twice converges: the second run plans nothing', (t) => {
    const dir = fixture(t, 'opencode.json', JSON.stringify({ mcp: { gsd: { type: 'local', command: OLD_COMMAND, enabled: true } } }));
    run(dir);
    const second = planInstallerMigrations({ configDir: dir, runtime: 'opencode', scope: 'global', migrations: [migration] });
    assert.deepEqual(second.pendingMigrationIds, [], 'recorded as applied');
  });
});

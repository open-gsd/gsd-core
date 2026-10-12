'use strict';

/**
 * opencode-config-jsonc.test.cjs — install and uninstall leave a user's annotated config intact and remove
 * exactly what GSD wrote (#5334 JSONC comments, #5333 mcp.gsd; epic #5331 Phase 2 #5338).
 * Spawns the real installer CLI against a sandbox HOME, for OpenCode and Kilo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SEED = `{
  // my provider notes
  "theme": "dark", // keep this note
  /* block comment */
  "permission": {
    "read": {
      "~/mine/*": "allow", // my own rule
    },
  },
  "mcp": {
    "mine": { "type": "local", "command": ["my-server"] },
  },
}
`;

function stripJsonc(text) {
  return JSON.parse(
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^\n"]*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
  );
}

function run(args, home) {
  const result = runNode([INSTALL_SCRIPT, ...args], {
    env: installerEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.strictEqual(result.exitCode, 0, `installer failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function assertAnnotationsKept(text) {
  for (const note of ['// my provider notes', '// keep this note', '/* block comment */', '// my own rule']) {
    assert.ok(text.includes(note), `lost ${note}\n${text}`);
  }
}

for (const [runtime, file, cfgDirName] of [['opencode', 'opencode.jsonc', 'opencode'], ['kilo', 'kilo.jsonc', 'kilo']]) {
  test(`${runtime}: install and uninstall keep the user's comments and trailing commas`, (t) => {
    const home = createTempDir(`gsd-${runtime}-jsonc-`);
    t.after(() => cleanup(home));
    const cfgDir = path.join(home, '.config', cfgDirName);
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, file);
    fs.writeFileSync(cfgPath, SEED);

    run([`--${runtime}`, '--global', '--config-dir', cfgDir], home);
    const installed = fs.readFileSync(cfgPath, 'utf8');
    assertAnnotationsKept(installed);
    const cfg = stripJsonc(installed);
    assert.ok(Object.keys(cfg.permission.read).some((k) => k.includes('gsd-core')), 'GSD read permission written');
    assert.equal(cfg.permission.read['~/mine/*'], 'allow');
    assert.deepEqual(cfg.mcp.mine, { type: 'local', command: ['my-server'] });

    run([`--${runtime}`, '--global', '--config-dir', cfgDir, '--uninstall'], home);
    const after = fs.readFileSync(cfgPath, 'utf8');
    assertAnnotationsKept(after);
    const cfgAfter = stripJsonc(after);
    assert.equal(Object.keys(cfgAfter.permission.read).some((k) => k.includes('gsd-core')), false);
    assert.equal(cfgAfter.permission.read['~/mine/*'], 'allow');
    assert.equal(cfgAfter.mcp.gsd, undefined);
    assert.deepEqual(cfgAfter.mcp.mine, { type: 'local', command: ['my-server'] });
    assert.deepEqual(cfgAfter, stripJsonc(SEED));
    assert.equal(after, SEED, 'uninstall returns an annotated config to the exact text the user had');
  });
}

test('opencode: uninstall removes the GSD-written mcp.gsd but keeps a user-edited one (#5333)', (t) => {
  const home = createTempDir('gsd-opencode-mcp-');
  t.after(() => cleanup(home));
  const cfgDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'opencode.json');

  run(['--opencode', '--global', '--config-dir', cfgDir], home);
  assert.ok(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcp.gsd, 'installer registered mcp.gsd');
  run(['--opencode', '--global', '--config-dir', cfgDir, '--uninstall'], home);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(after.mcp, undefined, 'mcp.gsd and the emptied mcp object are gone');

  // A user who edited the entry owns it.
  const edited = { type: 'local', command: ['node', 'my-gsd-server.js'], enabled: true };
  fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { gsd: edited, other: { type: 'remote', url: 'https://x.test' } } }, null, 2));
  run(['--opencode', '--global', '--config-dir', cfgDir], home);
  run(['--opencode', '--global', '--config-dir', cfgDir, '--uninstall'], home);
  const kept = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(kept.mcp.gsd, edited);
  assert.equal(kept.mcp.other.type, 'remote');
});

test('opencode: uninstall removes the native 2.x mcp.servers.gsd entry too (#5333)', (t) => {
  const home = createTempDir('gsd-opencode-mcpv2-');
  t.after(() => cleanup(home));
  const cfgDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'opencode.json');
  const gsd = { type: 'local', command: ['npx', '-y', '-p', '@opengsd/gsd-core', 'gsd-mcp-server'], disabled: false };
  fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { servers: { gsd, mine: { type: 'local', command: ['m'] } } } }, null, 2));
  run(['--opencode', '--global', '--config-dir', cfgDir, '--uninstall'], home);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(after.mcp.servers.gsd, undefined);
  assert.deepEqual(after.mcp.servers.mine, { type: 'local', command: ['m'] });
});

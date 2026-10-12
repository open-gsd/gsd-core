'use strict';

/**
 * opencode-uninstall-roundtrip.test.cjs — install then uninstall leaves the OpenCode config directory exactly
 * as it was, on a 1.x and a 2.x install (#5335, #5333, #5334; epic #5331 Phase 2 #5338).
 *
 * Seeds a config dir with an annotated opencode.jsonc and user-owned commands, agents, skills, plugins and
 * hook helpers, installs GSD with a stand-in `opencode` of the given generation on PATH, uninstalls, and
 * compares the whole tree (paths, empty directories and bytes) with the pre-install snapshot. The machine-wide
 * ~/.gsd defaults the install wrote must be reverted too, unless another runtime still needs them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SEED_CONFIG = `{
  // my provider notes
  "theme": "dark", // keep this note
  "mcp": {
    "mine": { "type": "local", "command": ["my-server"] },
  },
}
`;

const USER_FILES = {
  'opencode.jsonc': SEED_CONFIG,
  'commands/mine.md': '---\ndescription: mine\n---\nmine\n',
  'agents/mine.md': '---\ndescription: mine\nmode: subagent\n---\nmine\n',
  'skills/mine/SKILL.md': '---\nname: mine\ndescription: mine\n---\nmine\n',
  'plugins/mine.js': 'module.exports = {};\n',
  'hooks/mine-hook.js': '// user hook\n',
  'hooks/lib/mine-helper.js': '// user helper\n',
};

function snapshot(root) {
  const out = new Map();
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.set(`${r}/`, 'dir');
        walk(full, r);
      } else {
        out.set(r, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  })(root, '');
  return out;
}

function diff(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  return { added, removed, changed };
}

function stageOpencode(home, version) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'opencode');
  fs.writeFileSync(shim, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log(${JSON.stringify(version)});\n`);
  fs.chmodSync(shim, 0o755);
  return bin;
}

function run(args, home, bin) {
  const PATH = bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH;
  const result = runNode([INSTALL_SCRIPT, ...args], {
    env: installerEnv({ HOME: home, USERPROFILE: home, PATH }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.strictEqual(result.exitCode, 0, `installer failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const GENERATIONS = process.platform === 'win32' ? [['unprobed', null]] : [['1.x', '1.19.0'], ['2.x', 'opencode v2.0.27']];

for (const [label, version] of GENERATIONS) {
  test(`OpenCode ${label}: install then uninstall restores the config directory byte for byte`, (t) => {
    const home = createTempDir('gsd-oc-roundtrip-');
    t.after(() => cleanup(home));
    const cfgDir = path.join(home, '.config', 'opencode');
    for (const [rel, content] of Object.entries(USER_FILES)) {
      fs.mkdirSync(path.dirname(path.join(cfgDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(cfgDir, rel), content);
    }
    const before = snapshot(cfgDir);
    const bin = version ? stageOpencode(home, version) : null;

    run(['--opencode', '--global', '--config-dir', cfgDir], home, bin);
    const installed = snapshot(cfgDir);
    assert.ok(installed.size > before.size + 100, 'the install staged a full GSD tree');
    assert.ok(fs.existsSync(path.join(home, '.gsd', 'defaults.json')), 'the install wrote machine-wide defaults');

    run(['--opencode', '--global', '--config-dir', cfgDir, '--uninstall'], home, bin);
    const after = snapshot(cfgDir);
    assert.deepEqual(diff(before, after), { added: [], removed: [], changed: [] }, 'the config dir is exactly as it was');
    assert.equal(fs.existsSync(path.join(home, '.gsd')), false, 'machine-wide defaults written by the install are reverted');
  });
}

test('machine-wide defaults survive uninstall while another runtime still needs them, and a user-set value is never reverted', (t) => {
  const home = createTempDir('gsd-oc-defaults-');
  t.after(() => cleanup(home));
  const ocDir = path.join(home, '.config', 'opencode');
  const kiloDir = path.join(home, '.config', 'kilo');
  run(['--opencode', '--global', '--config-dir', ocDir], home, null);
  run(['--kilo', '--global', '--config-dir', kiloDir], home, null);
  const defaultsPath = path.join(home, '.gsd', 'defaults.json');
  assert.equal(JSON.parse(fs.readFileSync(defaultsPath, 'utf8')).runtime, 'opencode');

  run(['--opencode', '--global', '--config-dir', ocDir, '--uninstall'], home, null);
  assert.ok(fs.existsSync(defaultsPath), 'Kilo is still installed and uses the defaults');
  assert.equal(JSON.parse(fs.readFileSync(defaultsPath, 'utf8')).resolve_model_ids, 'omit');

  // The user changes a value GSD had set; uninstalling the last runtime leaves their choice alone.
  const edited = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  edited.runtime = 'codex';
  fs.writeFileSync(defaultsPath, JSON.stringify(edited, null, 2));
  run(['--kilo', '--global', '--config-dir', kiloDir, '--uninstall'], home, null);
  const kept = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  assert.equal(kept.runtime, 'codex', 'a value the user changed is not reverted');
  assert.equal(kept.resolve_model_ids, undefined, 'the untouched default GSD set is reverted with the last runtime');
});

test('a modified-file backup in the migration journal survives uninstall; GSD\'s own journal records do not', (t) => {
  const home = createTempDir('gsd-oc-journal-');
  t.after(() => cleanup(home));
  const cfgDir = path.join(home, '.config', 'opencode');
  run(['--opencode', '--global', '--config-dir', cfgDir], home, null);
  const journal = path.join(cfgDir, 'gsd-migration-journal');
  fs.mkdirSync(path.join(journal, 'run1-backups', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(journal, 'run1-backups', 'commands', 'gsd-help.md'), 'my edited copy\n');
  fs.writeFileSync(path.join(journal, 'run1.json'), '{}\n');
  fs.mkdirSync(path.join(journal, 'run1-rollback'), { recursive: true });
  run(['--opencode', '--global', '--config-dir', cfgDir, '--uninstall'], home, null);
  assert.equal(fs.readFileSync(path.join(journal, 'run1-backups', 'commands', 'gsd-help.md'), 'utf8'), 'my edited copy\n');
  assert.equal(fs.existsSync(path.join(journal, 'run1.json')), false);
  assert.equal(fs.existsSync(path.join(journal, 'run1-rollback')), false);
});

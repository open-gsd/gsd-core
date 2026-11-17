/**
 * #5947: the Cline global uninstall's `~/.agents/AGENTS.md` cleanup follows the installer's
 * symlinked-destination policy (#2393, #5301).
 *
 * Oracle: that policy. Without GSD_ALLOW_SYMLINKED_DEST a symlinked file is left alone and the
 * uninstall says so; with it the link is kept and the file it points at is edited. A GSD-only
 * target is emptied, never deleted (deleting it would leave a dangling link).
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  uninstall,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,
} = require('../bin/install.js');
const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

const GSD_ONLY = `${GSD_AGENTS_MD_MARKER}\nGSD rules\n${GSD_AGENTS_MD_CLOSE_MARKER}\n`;
const MIXED = `# my own rules\nkeep me\n\n${GSD_ONLY}`;

describe('Cline global uninstall and a symlinked ~/.agents/AGENTS.md (#5947)', () => {
  let home;
  let savedCwd;
  let savedEnv;
  let agentsPath;

  beforeEach(() => {
    home = createTempDir('gsd-5947-home-');
    savedCwd = process.cwd();
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CLINE_CONFIG_DIR: process.env.CLINE_CONFIG_DIR,
      GSD_ALLOW_SYMLINKED_DEST: process.env.GSD_ALLOW_SYMLINKED_DEST,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLINE_CONFIG_DIR;
    delete process.env.GSD_ALLOW_SYMLINKED_DEST;
    process.chdir(home);
    // The cleanup sits after the "target directory missing" early return, so the config dir must exist.
    fs.mkdirSync(getGlobalConfigDir('cline'), { recursive: true });
    agentsPath = path.join(home, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(home);
  });

  /** `~/.agents/AGENTS.md` as a link to a dotfiles file holding `content`; null (skipped) without symlinks. */
  function linked(t, content) {
    const target = path.join(home, 'dotfiles', 'AGENTS.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    try {
      fs.symlinkSync(target, agentsPath, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return null;
      }
      throw error;
    }
    return target;
  }

  function runUninstall() {
    const lines = [];
    const capture = (...args) => lines.push(args.join(' '));
    const saved = { log: console.log, error: console.error, warn: console.warn };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    try {
      uninstall(true, 'cline');
    } finally {
      Object.assign(console, saved);
    }
    return lines.join('\n');
  }

  for (const [label, content] of [['GSD-only', GSD_ONLY], ['mixed', MIXED]]) {
    test(`${label}: without the opt-in the link and its target are left untouched and the skip is reported`, (t) => {
      const target = linked(t, content);
      if (!target) return;
      const output = runUninstall();
      assert.ok(fs.lstatSync(agentsPath).isSymbolicLink(), 'the link must still be a symlink');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), content, 'the target must be byte-identical');
      assert.ok(output.includes('GSD_ALLOW_SYMLINKED_DEST=1'), `the skip must name the opt-in: ${output}`);
    });
  }

  test('GSD-only: with the opt-in the target is emptied and the link is kept', (t) => {
    const target = linked(t, GSD_ONLY);
    if (!target) return;
    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';
    runUninstall();
    assert.ok(fs.lstatSync(agentsPath).isSymbolicLink(), 'the link must be kept');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '', 'a GSD-only target is emptied, not deleted');
    assert.ok(!process.exitCode, 'the exit code is unchanged');
  });

  test('mixed: with the opt-in only the GSD block is removed and the link is kept', (t) => {
    const target = linked(t, MIXED);
    if (!target) return;
    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';
    runUninstall();
    assert.ok(fs.lstatSync(agentsPath).isSymbolicLink(), 'the link must be kept');
    const after = fs.readFileSync(target, 'utf8');
    assert.ok(after.includes('keep me'), 'user text must be kept');
    assert.ok(!after.includes(GSD_AGENTS_MD_MARKER), 'the GSD block must be gone');
    assert.ok(!process.exitCode, 'the exit code is unchanged');
  });

  for (const optIn of [undefined, '1']) {
    test(`a dangling link is not touched (opt-in ${optIn === undefined ? 'unset' : optIn})`, (t) => {
      try {
        fs.symlinkSync(path.join(home, 'gone', 'AGENTS.md'), agentsPath, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation is not available'); return; }
        throw error;
      }
      if (optIn !== undefined) process.env.GSD_ALLOW_SYMLINKED_DEST = optIn;
      assert.doesNotThrow(() => runUninstall());
      assert.ok(fs.lstatSync(agentsPath).isSymbolicLink(), 'the dangling link must remain');
      assert.strictEqual(fs.existsSync(path.join(home, 'gone')), false, 'nothing may be created through the dangling link');
    });
  }

  test('regular files are unchanged: GSD-only is removed, mixed is cleaned', () => {
    fs.writeFileSync(agentsPath, GSD_ONLY);
    runUninstall();
    assert.strictEqual(fs.existsSync(agentsPath), false, 'a regular GSD-only file is removed');

    fs.writeFileSync(agentsPath, MIXED);
    runUninstall();
    const after = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(after.includes('keep me') && !after.includes(GSD_AGENTS_MD_MARKER));
  });
});

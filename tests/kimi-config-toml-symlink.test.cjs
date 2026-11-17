/**
 * #5949: Kimi CLI / Kimi Code install and uninstall follow the symlinked-destination
 * policy (#2393, #5301) for their native `config.toml`.
 *
 * Oracle: the policy the Codex hooks.json writer already follows. Without
 * GSD_ALLOW_SYMLINKED_DEST a symlinked config.toml is refused and left byte-identical (link and
 * target), with the opt-in the link is kept and the file it points at is edited. A GSD-only
 * target is emptied, never unlinked. The managed block is produced by a real install, not
 * hand-written.
 */
'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { resolveKimiHooksTomlDir, getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

const INSTALL = path.join(__dirname, '..', 'bin', 'install.js');
const USER_KEYS = 'default_model = "my-own-model"\n\n[providers.mine]\ntype = "custom"\n';
const OPT_IN = 'GSD_ALLOW_SYMLINKED_DEST=1';
// Everything that can point Kimi's config home away from the temp HOME, plus the policy switch and
// the test-mode switch that makes bin/install.js skip its CLI block.
const ISOLATED_ENV = [
  'GSD_ALLOW_SYMLINKED_DEST', 'GSD_TEST_MODE', 'KIMI_CONFIG_DIR', 'KIMI_CODE_CONFIG_DIR', 'KIMI_SHARE_DIR', 'KIMI_CODE_HOME',
];

for (const runtime of ['kimi', 'kimi-code']) {
  describe(`${runtime}: a symlinked config.toml (#5949)`, () => {
    let home;
    let configToml;
    let dotfile;
    let gsdOnly; // the config.toml a real global install writes into an empty home
    let beginMarker;

    function run(args, { optIn = false } = {}) {
      const env = { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home };
      for (const key of ISOLATED_ENV) delete env[key];
      if (optIn) env.GSD_ALLOW_SYMLINKED_DEST = '1';
      const result = runNode([INSTALL, `--${runtime}`, '--global', ...args], { cwd: home, env });
      return { ...result, output: `${result.stdout}\n${result.stderr}` };
    }

    before(() => {
      const seedHome = createTempDir('gsd-5949-seed-');
      const savedHome = process.env.HOME;
      const savedProfile = process.env.USERPROFILE;
      process.env.HOME = seedHome;
      process.env.USERPROFILE = seedHome;
      const savedKimi = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
      for (const key of ISOLATED_ENV) delete process.env[key];
      try {
        home = seedHome;
        configToml = path.join(resolveKimiHooksTomlDir({ runtime }), 'config.toml');
        const seeded = run([]);
        assert.strictEqual(seeded.exitCode, 0, `seeding install failed:\n${seeded.output}`);
        gsdOnly = fs.readFileSync(configToml, 'utf8');
        beginMarker = splitLines(gsdOnly)[0];
        assert.ok(gsdOnly.includes('[[hooks]]'), 'a real install must write the managed hooks block');
      } finally {
        process.env.HOME = savedHome;
        process.env.USERPROFILE = savedProfile;
        for (const [key, value] of Object.entries(savedKimi)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        cleanup(seedHome);
      }
    });

    let savedHome;
    let savedProfile;
    let savedKimi;
    beforeEach(() => {
      home = createTempDir('gsd-5949-home-');
      savedHome = process.env.HOME;
      savedProfile = process.env.USERPROFILE;
      savedKimi = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
      for (const key of ISOLATED_ENV) delete process.env[key];
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      configToml = path.join(resolveKimiHooksTomlDir({ runtime }), 'config.toml');
      dotfile = path.join(home, 'dotfiles', 'config.toml');
      fs.mkdirSync(path.dirname(configToml), { recursive: true });
      fs.mkdirSync(path.dirname(dotfile), { recursive: true });
      // A real install leaves the runtime's own config dir behind; uninstall returns early when it is
      // missing, before it reaches Kimi's native config.toml.
      fs.mkdirSync(getGlobalConfigDir(runtime), { recursive: true });
    });
    afterEach(() => {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedProfile;
      for (const [key, value] of Object.entries(savedKimi)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cleanup(home);
    });

    /** config.toml as a symlink to a dotfiles file holding `content`; false (skipped) without symlinks. */
    function linked(t, content) {
      fs.writeFileSync(dotfile, content);
      try {
        fs.symlinkSync(dotfile, configToml, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          t.skip('symlink creation is not available on this platform');
          return false;
        }
        throw error;
      }
      return true;
    }

    const isLink = () => fs.lstatSync(configToml).isSymbolicLink();

    for (const [label, content] of [['GSD-only', () => gsdOnly], ['mixed', () => `${USER_KEYS}\n${gsdOnly}`]]) {
      test(`uninstall, ${label}: refused without the opt-in, link and target untouched`, (t) => {
        const body = content();
        if (!linked(t, body)) return;
        const result = run(['--uninstall']);
        assert.ok(isLink(), 'the link must still be a symlink');
        assert.strictEqual(fs.readFileSync(dotfile, 'utf8'), body, 'the target must be byte-identical');
        assert.ok(result.output.includes(OPT_IN), `the refusal must name the opt-in:\n${result.output}`);
        assert.ok(result.exitCode !== 0 && result.exitCode !== null, 'a refused uninstall must exit non-zero');
      });
    }

    test('uninstall, GSD-only: with the opt-in the target is emptied and the link is kept', (t) => {
      if (!linked(t, gsdOnly)) return;
      run(['--uninstall'], { optIn: true });
      assert.ok(isLink(), 'the link must be kept');
      assert.strictEqual(fs.readFileSync(dotfile, 'utf8'), '', 'a GSD-only target is emptied, not deleted');
    });

    test('uninstall, mixed: with the opt-in only the GSD block goes and user keys stay', (t) => {
      if (!linked(t, `${USER_KEYS}\n${gsdOnly}`)) return;
      run(['--uninstall'], { optIn: true });
      assert.ok(isLink(), 'the link must be kept');
      const after = fs.readFileSync(dotfile, 'utf8');
      assert.ok(after.includes('my-own-model') && after.includes('[providers.mine]'), 'user keys must stay');
      assert.ok(!after.includes(beginMarker), 'the GSD block must be gone');
    });

    test('install over a link to a user-owned file: refused without the opt-in, link and target untouched', (t) => {
      if (!linked(t, USER_KEYS)) return;
      const result = run([]);
      assert.ok(isLink(), 'the link must still be a symlink');
      assert.strictEqual(fs.readFileSync(dotfile, 'utf8'), USER_KEYS, 'the target must be byte-identical');
      assert.ok(result.output.includes(OPT_IN), `the refusal must name the opt-in:\n${result.output}`);
      assert.ok(result.exitCode !== 0 && result.exitCode !== null, 'a refused install must exit non-zero');
      assert.strictEqual(fs.existsSync(path.join(path.dirname(configToml), 'hooks')), false, 'nothing else may be installed before the refusal');
    });

    test('install over a link to a user-owned file: with the opt-in the block lands in the target and the link is kept', (t) => {
      if (!linked(t, USER_KEYS)) return;
      const result = run([], { optIn: true });
      assert.strictEqual(result.exitCode, 0, result.output);
      assert.ok(isLink(), 'the link must be kept');
      const after = fs.readFileSync(dotfile, 'utf8');
      assert.ok(after.includes('my-own-model'), 'user keys must stay');
      assert.ok(after.includes('[[hooks]]') && after.includes(beginMarker), 'the managed block must be in the target');
    });

    test('a link chain is followed to its final file and every link is kept (opt-in set)', (t) => {
      const middle = path.join(home, 'dotfiles', 'middle.toml');
      fs.writeFileSync(dotfile, `${USER_KEYS}\n${gsdOnly}`);
      try {
        fs.symlinkSync(dotfile, middle, 'file');
        fs.symlinkSync(middle, configToml, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation is not available'); return; }
        throw error;
      }
      run(['--uninstall'], { optIn: true });
      assert.ok(isLink() && fs.lstatSync(middle).isSymbolicLink(), 'both links must be kept');
      const after = fs.readFileSync(dotfile, 'utf8');
      assert.ok(after.includes('my-own-model') && !after.includes(beginMarker), 'the final file is edited');
    });

    test('uninstall leaves a symlinked config.toml that holds no GSD block alone and does not refuse', (t) => {
      if (!linked(t, USER_KEYS)) return;
      const result = run(['--uninstall']);
      assert.ok(isLink(), 'the link must be kept');
      assert.strictEqual(fs.readFileSync(dotfile, 'utf8'), USER_KEYS, 'the target must be byte-identical');
      assert.ok(!result.output.includes(OPT_IN), `there was nothing to strip, so nothing to refuse:\n${result.output}`);
    });

    for (const optIn of [false, true]) {
      test(`a dangling link is never replaced or deleted (opt-in ${optIn ? 'set' : 'unset'})`, (t) => {
        const missing = path.join(home, 'gone', 'config.toml');
        try {
          fs.symlinkSync(missing, configToml, 'file');
        } catch (error) {
          if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation is not available'); return; }
          throw error;
        }
        run(['--uninstall'], { optIn });
        assert.ok(isLink(), 'uninstall must leave the dangling link');
        run([], { optIn });
        assert.ok(isLink(), 'install must not replace the dangling link with a regular file');
        assert.strictEqual(fs.existsSync(path.dirname(missing)), false, 'nothing may be created through the dangling link');
      });
    }

    test('regular files are unchanged: install writes the block, uninstall removes a GSD-only file', () => {
      const installed = run([]);
      assert.strictEqual(installed.exitCode, 0, installed.output);
      assert.ok(fs.readFileSync(configToml, 'utf8').includes('[[hooks]]'), 'install writes the block into a regular file');
      run(['--uninstall']);
      assert.strictEqual(fs.existsSync(configToml), false, 'a regular GSD-only config.toml is removed');
    });
  });
}

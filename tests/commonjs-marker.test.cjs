'use strict';

/**
 * CommonJS marker ownership — regression coverage for #2544.
 *
 * `installSharedHooksBundle` used to write `{"type":"commonjs"}` over
 * `<configRoot>/package.json` unconditionally — no existence check, no merge,
 * no backup. On OpenCode and Kilo that file is documented, user-writable
 * territory (it is where local-plugin npm dependencies are declared), so every
 * install and every `/gsd-update` destroyed the user's `name`, `type`,
 * `dependencies`, and `scripts`.
 *
 * The uninstall path had always read the file first and unlinked it only on an
 * exact content match. The defect was that asymmetry: the discipline existed,
 * it just was not applied on the write side.
 *
 * The fix moves the marker into the directories GSD actually fills with its own
 * `.js` files — `hooks/` and the `nativePlugin.dir` — and routes install and
 * uninstall through one shared ownership predicate. These tests pin both
 * halves: the config root is never written, and a user-authored package.json is
 * never overwritten even where GSD does write.
 *
 * Coverage maps to the issue's acceptance criteria:
 *   AC1 — a user-authored config-root package.json survives a fresh install
 *   AC2 — it survives a second install (the `/gsd-update` re-install path)
 *   AC3 — GSD's staged .js files still resolve as CommonJS
 *   AC4 — uninstall removes only markers GSD wrote
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const {
  COMMONJS_MARKER,
  classifyMarker,
  ensureCommonJsMarker,
  removeCommonJsMarker,
} = require('../gsd-core/bin/lib/commonjs-marker.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

/** A realistic OpenCode-shape config-root package.json (the issue's repro). */
const USER_PACKAGE_JSON = JSON.stringify(
  {
    name: 'my-opencode-config',
    type: 'module',
    dependencies: { shescape: '^2.1.0', zod: '^3.23.8' },
    scripts: { postinstall: 'echo user-owned' },
  },
  null,
  2,
) + '\n';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the real installer against a throwaway config root.
 *
 * HOME/USERPROFILE/CLAUDE_CONFIG_DIR are all redirected into the temp tree so
 * the installer can never reach the developer's live profile — gsd-core's
 * installer resolves through exactly those variables.
 */
function runInstall(root, runtime, extraArgs = []) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root };
  delete env.GSD_TEST_MODE;
  const result = spawnSync(
    process.execPath,
    [INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', root, ...extraArgs],
    { cwd: root, encoding: 'utf8', env },
  );
  assert.equal(
    result.status,
    0,
    `installer exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

describe('commonjs-marker: ownership predicate', () => {
  test('classifies absent, GSD-owned, and foreign package.json files', (t) => {
    const dir = mkTmp('cjs-marker-classify-');
    t.after(() => cleanup(dir));

    assert.equal(classifyMarker(dir), 'absent');

    fs.writeFileSync(path.join(dir, 'package.json'), `${COMMONJS_MARKER}\n`);
    assert.equal(classifyMarker(dir), 'gsd-owned');

    fs.writeFileSync(path.join(dir, 'package.json'), USER_PACKAGE_JSON);
    assert.equal(classifyMarker(dir), 'foreign');
  });

  test('ensureCommonJsMarker never overwrites a foreign package.json', (t) => {
    const dir = mkTmp('cjs-marker-ensure-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'package.json');

    assert.equal(ensureCommonJsMarker(dir), 'written');
    assert.equal(fs.readFileSync(target, 'utf8').trim(), COMMONJS_MARKER);

    // Idempotent: a re-install must not churn the file.
    assert.equal(ensureCommonJsMarker(dir), 'unchanged');

    // Foreign content is preserved byte-for-byte.
    fs.writeFileSync(target, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(target));
    assert.equal(ensureCommonJsMarker(dir), 'preserved-foreign');
    assert.equal(sha256(fs.readFileSync(target)), before);
  });

  test('a symlinked package.json is foreign — never followed, never removed', (t) => {
    const dir = mkTmp('cjs-marker-symlink-');
    t.after(() => cleanup(dir));
    const outside = path.join(dir, 'outside.json');
    const owned = path.join(dir, 'owned');
    fs.mkdirSync(owned);
    const link = path.join(owned, 'package.json');

    // A DANGLING symlink is the dangerous case: existsSync() reports false for
    // it, so an existsSync-based guard would classify `absent` and then write
    // straight through the link, landing outside the directory GSD owns.
    fs.symlinkSync(outside, link);
    assert.equal(classifyMarker(owned), 'foreign');
    assert.equal(ensureCommonJsMarker(owned), 'preserved-foreign');
    assert.ok(!fs.existsSync(outside), 'the write must not follow the symlink out of the directory');
    assert.equal(removeCommonJsMarker(owned), false, 'a symlink is never GSD-owned');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself must survive');
  });

  test('removeCommonJsMarker removes only GSD-owned markers', (t) => {
    const dir = mkTmp('cjs-marker-remove-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'package.json');

    fs.writeFileSync(target, USER_PACKAGE_JSON);
    assert.equal(removeCommonJsMarker(dir), false);
    assert.ok(fs.existsSync(target), 'a foreign package.json must survive uninstall');

    fs.writeFileSync(target, `${COMMONJS_MARKER}\n`);
    assert.equal(removeCommonJsMarker(dir), true);
    assert.ok(!fs.existsSync(target));
  });
});

describe('#2544 regression: install must not clobber the config-root package.json', () => {
  // hooks/dist is gitignored and built; scoped CI lanes do not run build:hooks,
  // so build it idempotently before driving a real install.
  before(() => {
    const build = spawnSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf8' });
    assert.equal(build.status, 0, `build:hooks failed: ${build.stderr}`);
  });

  for (const runtime of ['opencode', 'claude']) {
    test(`${runtime}: a user-authored package.json survives install and re-install`, (t) => {
      const root = mkTmp(`gsd-2544-${runtime}-`);
      t.after(() => cleanup(root));
      const userPkg = path.join(root, 'package.json');
      fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
      const before = sha256(fs.readFileSync(userPkg));

      // AC1 — fresh install leaves it untouched.
      runInstall(root, runtime);
      assert.equal(
        sha256(fs.readFileSync(userPkg)),
        before,
        'fresh install must not modify the user-authored config-root package.json',
      );

      // AC2 — the /gsd-update re-install path leaves it untouched too.
      runInstall(root, runtime);
      assert.equal(
        sha256(fs.readFileSync(userPkg)),
        before,
        're-install must not modify the user-authored config-root package.json',
      );

      // The user's own keys are still readable and intact.
      const parsed = JSON.parse(fs.readFileSync(userPkg, 'utf8'));
      assert.equal(parsed.name, 'my-opencode-config');
      assert.equal(parsed.type, 'module');
      assert.deepEqual(parsed.dependencies, { shescape: '^2.1.0', zod: '^3.23.8' });
      assert.deepEqual(parsed.scripts, { postinstall: 'echo user-owned' });

      // AC3 — GSD's own staged scripts still get a CommonJS marker, from the
      // directory GSD owns, so `require` keeps working under "type": "module".
      const hooksMarker = path.join(root, 'hooks', 'package.json');
      assert.ok(fs.existsSync(hooksMarker), 'hooks/package.json marker must be staged');
      assert.equal(JSON.parse(fs.readFileSync(hooksMarker, 'utf8')).type, 'commonjs');
    });
  }

  test('staged hook helpers still load as CommonJS under a "type": "module" config root', (t) => {
    const root = mkTmp('gsd-2544-esm-');
    t.after(() => cleanup(root));
    // The config root declares ESM — the exact shape that breaks Node's
    // walk-up resolution for GSD's staged .js files.
    fs.writeFileSync(path.join(root, 'package.json'), USER_PACKAGE_JSON);
    runInstall(root, 'opencode');

    // Actually require a staged CommonJS helper. Without a marker inside
    // hooks/, the walk-up lands on the user's "type": "module" and this throws
    // ERR_REQUIRE_ESM / "require is not defined" — the regression AC3 forbids.
    const target = path.join(root, 'hooks', 'lib', 'git-cmd.js');
    assert.ok(fs.existsSync(target), 'hooks/lib/git-cmd.js must be staged');
    const probe = spawnSync(
      process.execPath,
      ['-e', `const m = require(${JSON.stringify(target)}); if (typeof m.isGitSubcommand !== 'function') { throw new Error('unexpected exports'); } console.log('loaded');`],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(
      probe.status,
      0,
      `staged hook helper must load as CommonJS under an ESM config root\nstderr: ${probe.stderr}`,
    );
    assert.match(probe.stdout, /loaded/);
  });

  test('opencode: the native plugin dir gets its own marker', (t) => {
    const root = mkTmp('gsd-2544-plugin-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    // The adapter is staged as .js, so it needs a marker in its own directory
    // now that the config root no longer carries one. A package.json here is
    // inert to plugin discovery: OpenCode globs plugins/*.{ts,js}.
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'gsd-core.js')));
    const pluginMarker = path.join(root, 'plugins', 'package.json');
    assert.ok(fs.existsSync(pluginMarker), 'plugins/package.json marker must be staged');
    assert.equal(JSON.parse(fs.readFileSync(pluginMarker, 'utf8')).type, 'commonjs');
  });

  test('install writes no package.json at the config root when none existed', (t) => {
    const root = mkTmp('gsd-2544-noroot-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    assert.ok(
      !fs.existsSync(path.join(root, 'package.json')),
      'GSD must not create a package.json in the runtime config root',
    );
  });

  test('uninstall removes GSD markers but preserves a user-authored one', (t) => {
    const root = mkTmp('gsd-2544-uninstall-');
    t.after(() => cleanup(root));
    const userPkg = path.join(root, 'package.json');
    fs.writeFileSync(userPkg, USER_PACKAGE_JSON);
    const before = sha256(fs.readFileSync(userPkg));

    runInstall(root, 'opencode');
    runInstall(root, 'opencode', ['--uninstall']);

    // AC4 — GSD's own markers are gone; the user's file is untouched.
    assert.ok(fs.existsSync(userPkg), 'uninstall must not remove a user-authored package.json');
    assert.equal(sha256(fs.readFileSync(userPkg)), before);
    assert.ok(
      !fs.existsSync(path.join(root, 'hooks', 'package.json')),
      'uninstall must remove the hooks/ marker it wrote',
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'plugins', 'package.json')),
      'uninstall must remove the plugin-dir marker it wrote',
    );
  });

  test('uninstall reclaims the plugin-dir marker even if the adapter is already gone', (t) => {
    const root = mkTmp('gsd-2544-partial-');
    t.after(() => cleanup(root));
    runInstall(root, 'opencode');

    // Model a partial install / hand-deleted adapter. The marker cleanup must
    // not be gated on the adapter still being present, or it is stranded and
    // the directory can never prune.
    fs.unlinkSync(path.join(root, 'plugins', 'gsd-core.js'));
    runInstall(root, 'opencode', ['--uninstall']);

    assert.ok(
      !fs.existsSync(path.join(root, 'plugins', 'package.json')),
      'the plugin-dir marker must be reclaimed even without the adapter',
    );
  });

  test('uninstall retires a pre-#2544 config-root marker', (t) => {
    const root = mkTmp('gsd-2544-legacy-');
    t.after(() => cleanup(root));

    runInstall(root, 'opencode');
    // Model an install made before the fix, which left the marker at the root.
    fs.writeFileSync(path.join(root, 'package.json'), `${COMMONJS_MARKER}\n`);

    runInstall(root, 'opencode', ['--uninstall']);
    assert.ok(
      !fs.existsSync(path.join(root, 'package.json')),
      'uninstall must still retire the legacy config-root marker',
    );
  });
});

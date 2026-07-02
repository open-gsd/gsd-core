'use strict';
/**
 * Regression tests for #1920: the installer must produce a capability-ecosystem-
 * complete flattened layout, and the capability loader must resolve the real host
 * version in that layout.
 *
 * Two gaps broke third-party capabilities on installed (flattened) layouts:
 *
 *   Gap 1 — host version read as 0.0.0. `readHostVersion()` resolved the running GSD
 *     version via require('../../../package.json'), which in the installed layout is the
 *     marker package.json ({"type":"commonjs"}, no version) → the fail-closed fallback
 *     reported 0.0.0, so `capability install` rejected any manifest with a real
 *     engines.gsd range as "incompatible with GSD 0.0.0". Worse, for runtimes that get
 *     no marker and for local installs, that walked-up package.json could be the USER's
 *     own project, reporting a wrong version. Fix: readHostVersion() prefers the
 *     authoritative gsd-core/VERSION the installer writes for EVERY runtime.
 *
 *   Gap 2 — the registry generator was never shipped. The loader composes overlays via
 *     require('../../../scripts/gen-capability-registry.cjs'); the installer never copied
 *     it (nor its sibling gen-loop-host-contract.cjs), so the never-crash invariant
 *     discarded EVERY overlay and fell back to the frozen first-party registry —
 *     installed third-party capabilities were silently inert. Same class of gap as #1223
 *     (scripts/fix-slash-commands.cjs).
 *
 * These tests are RED before the fix (loader/install.js) and GREEN after.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const MANIFEST_NAME = 'gsd-file-manifest.json';

// The generator scripts the capability loader requires by relative path.
const GENERATORS = ['gen-capability-registry.cjs', 'gen-loop-host-contract.cjs'];

// ---------------------------------------------------------------------------
// Gap 1 — readHostVersion() prefers gsd-core/VERSION (the installer-written,
// all-runtime authoritative source) over an ambient/absent package.json.
// ---------------------------------------------------------------------------
describe('Gap 1: readHostVersion resolves the real host version in an installed layout (#1920)', () => {
  const { readHostVersion } = require('../gsd-core/bin/lib/capability-loader.cjs');

  /** Build a fake installed tree and return its gsd-core/bin/lib dir (the module libDir). */
  function fakeTree({ version, pkg }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-ver-'));
    const libDir = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    if (version !== undefined) fs.writeFileSync(path.join(root, 'gsd-core', 'VERSION'), version);
    if (pkg !== undefined) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    return { root, libDir };
  }

  test('prefers gsd-core/VERSION over a wrong ambient package.json version', () => {
    // The walked-up package.json belongs to the user's project (wrong version) — must be ignored.
    const { root, libDir } = fakeTree({ version: '9.9.9\n', pkg: { name: 'user-app', version: '1.2.3', type: 'commonjs' } });
    try {
      assert.strictEqual(readHostVersion(libDir), '9.9.9');
    } finally {
      cleanup(root);
    }
  });

  test('falls back to the runtime-root package.json when no VERSION file (dev/source tree)', () => {
    const { root, libDir } = fakeTree({ pkg: { version: '2.3.4' } });
    try {
      assert.strictEqual(readHostVersion(libDir), '2.3.4');
    } finally {
      cleanup(root);
    }
  });

  test('fail-closes to 0.0.0 when neither VERSION nor a package.json version resolves', () => {
    const { root, libDir } = fakeTree({});
    try {
      assert.strictEqual(readHostVersion(libDir), '0.0.0');
    } finally {
      cleanup(root);
    }
  });

  test('a real global install writes gsd-core/VERSION carrying the host version', () => {
    const dir = realInstall();
    try {
      const vfile = path.join(dir, 'gsd-core', 'VERSION');
      assert.ok(fs.existsSync(vfile), 'installer must write gsd-core/VERSION');
      assert.strictEqual(
        fs.readFileSync(vfile, 'utf8').trim(),
        require('../package.json').version,
        'gsd-core/VERSION must carry the real host version readHostVersion() reads',
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — the installer ships (and uninstalls / manifest-tracks) the capability
// registry generator scripts.
// ---------------------------------------------------------------------------

/** Run a real global install into a fresh temp config dir; return that dir. */
function realInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-'));
  // The module-level GSD_TEST_MODE=1 gates the installer's main() off entirely —
  // strip it from the child env for the spawned REAL install.
  const childEnv = { ...process.env };
  delete childEnv.GSD_TEST_MODE;
  const res = spawnSync(
    process.execPath,
    [INSTALL, '--claude', '--global', '--config-dir', dir],
    { encoding: 'utf8', timeout: 120000, env: childEnv },
  );
  assert.strictEqual(res.status, 0, `install --claude failed: ${res.stderr || res.stdout}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Gap 1 (end-to-end CLI) — the actual repro: `gsd-tools capability install` on an
// INSTALLED layout must resolve the real host version for the engines.gsd gate, not
// 0.0.0. The dev tree always has a versioned package.json two levels up, so this only
// reproduces against a real install (where ../../package.json is the versionless marker
// and gsd-core/VERSION carries the truth). The CLI computes hostVersion itself, so this
// covers capHostVersion() in gsd-tools.cjs — a path the loader unit test does not touch.
// ---------------------------------------------------------------------------
describe('Gap 1 (end-to-end CLI): installed capability install uses the real host version (#1920)', () => {
  const HOST_MAJOR = require('../package.json').version.split('.')[0];

  function writeProbeCapability(engines) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-cap-'));
    const cap = {
      id: 'p1920-probe', role: 'feature', version: '1.0.0', title: 'probe',
      description: 'test capability', tier: 'standard', requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], hooks: [], config: {}, steps: [],
      contributions: [], gates: [], engines,
    };
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    return src;
  }

  test('a capability requiring engines.gsd ">=<host major>.0.0" is not rejected as GSD 0.0.0', () => {
    const dir = realInstall();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-cwd-'));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
    const src = writeProbeCapability({ gsd: `>=${HOST_MAJOR}.0.0` });
    try {
      const installedTools = path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs');
      const env = { ...process.env, GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '', GSD_SESSION_KEY: '', CLAUDE_SESSION_ID: '' };
      delete env.GSD_TEST_MODE;
      const res = spawnSync(
        process.execPath,
        [installedTools, 'capability', 'install', src, '--scope', 'global', '--yes', '--json'],
        { cwd, env, encoding: 'utf8', timeout: 60000 },
      );
      const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
      assert.doesNotMatch(
        combined,
        /incompatible with GSD 0\.0\.0/,
        `installed CLI saw host version 0.0.0 — the engines gate read the versionless marker: ${combined}`,
      );
      assert.strictEqual(res.status, 0, `capability install failed on the installed layout: ${combined}`);
    } finally {
      cleanup(dir); cleanup(home); cleanup(cwd); cleanup(src);
    }
  });
});

describe('Gap 2: installer ships the capability registry generator scripts (#1920)', () => {
  test('the generator scripts are copied into scripts/', () => {
    const dir = realInstall();
    try {
      for (const gen of GENERATORS) {
        const dest = path.join(dir, 'scripts', gen);
        assert.ok(fs.existsSync(dest), `installer must ship scripts/${gen}`);
        assert.ok(fs.statSync(dest).size > 0, `scripts/${gen} must not be empty`);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('the shipped generator scripts are tracked in the file manifest', () => {
    const dir = realInstall();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
      for (const gen of GENERATORS) {
        assert.ok(
          manifest.files[`scripts/${gen}`],
          `manifest must track scripts/${gen} for drift/uninstall accounting`,
        );
      }
    } finally {
      cleanup(dir);
    }
  });
});

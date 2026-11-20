'use strict';

/**
 * #6335 — a tree from `copyRuntimeFixture` is the tree a fresh install into its
 * root writes, for every runtime family.
 *
 * This file runs the real installer: once per family for the fresh tree. The
 * tree the copy is made from is the run's shared one, which other test files
 * read too.
 *
 * Two installs of one checkout differ only in what each draws at random: the
 * typed-text heredoc terminator (`foldInstallNonce`), timestamps, and so the
 * manifest's hashes of the files that hold a terminator. Everything else must
 * match once each tree's own root name is masked. The manifest is checked the
 * other way: every hash it records must be the hash of the file beside it, in
 * the copy exactly as in the fresh install.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { cleanup, createTempDir } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const {
  MANIFEST_FAMILIES,
  MANIFEST_NAME,
  runMinimalInstall,
  installRuntimeFixture,
  copyRuntimeFixture,
  foldInstallNonce,
} = require('./helpers/install-shared.cjs');
const { listTree, treeDigest, RUN_TEMP_ROOT_PREFIX } = require('./helpers/shared-install-fixture.cjs');

const INSTALL_SHARED = path.join(__dirname, 'helpers', 'install-shared.cjs');
const { INSTALL_TIMEOUT_MS, BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Files in the sandbox home that the installer did not write. The opencode
 * install asks an `opencode` binary for its version when one is on PATH, and
 * that binary keeps a log under the home it is given.
 */
const NOT_INSTALLER_OUTPUT = ['.local/share/opencode/'];

const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;

/** relative path -> what must agree between two installs of this checkout. */
function comparable(root) {
  const name = path.basename(root);
  const mask = (text) => foldInstallNonce(text.split(name).join('<ROOT>')).replace(TIMESTAMP, '<TIME>');
  const out = new Map();
  for (const [relPath, stat] of listTree(root)) {
    if (NOT_INSTALLER_OUTPUT.some((prefix) => relPath.startsWith(prefix))) continue;
    const full = path.join(root, relPath);
    if (stat.isDirectory()) out.set(relPath, 'directory');
    else if (stat.isSymbolicLink()) out.set(relPath, `link ${mask(fs.readlinkSync(full))}`);
    else if (path.basename(relPath) === MANIFEST_NAME) {
      // Hashes follow the random terminator; which files are recorded does not.
      const manifest = JSON.parse(fs.readFileSync(full, 'utf8'));
      out.set(relPath, JSON.stringify({ ...manifest, timestamp: '<TIME>', files: Object.keys(manifest.files).sort() }));
    } else out.set(relPath, mask(fs.readFileSync(full).toString('latin1')));
  }
  return out;
}

/** For each manifest entry whose file exists under configDir: does the recorded hash match the file? */
function manifestAgainstFiles(configDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(configDir, MANIFEST_NAME), 'utf8'));
  const matching = [];
  const stale = [];
  const elsewhere = [];
  for (const [relPath, recorded] of Object.entries(manifest.files)) {
    const file = path.join(configDir, relPath);
    if (!fs.existsSync(file)) elsewhere.push(relPath);
    else if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === recorded) matching.push(relPath);
    else stale.push(relPath);
  }
  return { matching: matching.sort(), stale: stale.sort(), elsewhere: elsewhere.sort() };
}

describe('copyRuntimeFixture against a real install (#6335)', () => {
  const roots = [];
  after(() => {
    for (const root of roots) cleanup(root);
  });

  for (const { name, runtime, scope } of MANIFEST_FAMILIES) {
    test(`${name}: the copy has the files and content of a fresh install into its root`, () => {
      const copy = copyRuntimeFixture({ runtime, scope });
      roots.push(copy.root);
      const fresh = runMinimalInstall({ runtime, scope });
      roots.push(fresh.root);

      const copied = comparable(copy.root);
      const installed = comparable(fresh.root);
      assert.deepEqual([...copied.keys()], [...installed.keys()]);
      const differing = [...installed.keys()].filter((relPath) => copied.get(relPath) !== installed.get(relPath));
      assert.deepEqual(differing, []);

      // The fresh install is the reference for what "the manifest matches the files" means
      // for this runtime; the copy must meet it entry for entry.
      const reference = manifestAgainstFiles(fresh.configDir);
      assert.deepEqual(reference.stale, []);
      assert.ok(reference.matching.length > 0);
      assert.deepEqual(manifestAgainstFiles(copy.configDir), reference);

      assert.equal(path.basename(copy.configDir), path.basename(fresh.configDir));
      assert.deepEqual(Object.keys(copy.manifest.files).sort(), Object.keys(fresh.manifest.files).sort());
    });
  }

  test('a copy can be written to without changing the shared tree it came from', () => {
    const shared = installRuntimeFixture({ runtime: 'claude', scope: 'global' });
    const copy = copyRuntimeFixture({ runtime: 'claude', scope: 'global' });
    roots.push(copy.root);
    fs.writeFileSync(path.join(copy.configDir, 'written-by-a-test.txt'), 'x');
    fs.unlinkSync(path.join(copy.configDir, MANIFEST_NAME));

    assert.equal(fs.existsSync(path.join(shared.configDir, 'written-by-a-test.txt')), false);
    assert.equal(fs.statSync(path.join(shared.configDir, MANIFEST_NAME)).isFile(), true);
  });

  test('making a copy leaves the shared tree as it was built', () => {
    const shared = installRuntimeFixture({ runtime: 'claude', scope: 'global' });
    const before = treeDigest(shared.root);
    roots.push(copyRuntimeFixture({ runtime: 'claude', scope: 'global' }).root);
    assert.equal(treeDigest(shared.root), before);
  });

  test('two copies of one fixture are separate trees', () => {
    const a = copyRuntimeFixture({ runtime: 'claude', scope: 'local' });
    const b = copyRuntimeFixture({ runtime: 'claude', scope: 'local' });
    roots.push(a.root, b.root);
    assert.notEqual(a.root, b.root);
    fs.writeFileSync(path.join(a.configDir, 'only-in-a.txt'), 'x');
    assert.equal(fs.existsSync(path.join(b.configDir, 'only-in-a.txt')), false);
  });
});

/**
 * The read-only rule, end to end: real test-file-like processes inside a run
 * root of their own, sharing one real installed tree.
 */
describe('a shared tree across processes, with a real install (#6335)', () => {
  const runRoot = createTempDir(RUN_TEMP_ROOT_PREFIX);
  after(() => cleanup(runRoot));

  // Each child is what a test file is to the store: a process whose temp
  // directory is the run root. It prints one JSON line: its fixture's root and
  // configDir, or the code of the error installRuntimeFixture threw.
  const child = (body) => runNode(
    ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const { installRuntimeFixture } = require(${JSON.stringify(INSTALL_SHARED)});
      let fixture;
      try {
        fixture = installRuntimeFixture({ runtime: 'cline', scope: 'global' });
      } catch (err) {
        process.stdout.write(JSON.stringify({ refused: err.code ?? null }));
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ root: fixture.root, configDir: fixture.configDir }));
      ${body}
    `],
    {
      env: isolatedEnv({ home: runRoot, override: { TMPDIR: runRoot, TMP: runRoot, TEMP: runRoot } }),
      // The first child may run the hooks build and then a full install.
      timeoutMs: INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS,
    },
  );
  const reported = (result) => JSON.parse(result.stdout);

  test('a process that only reads exits 0, and the next one gets the same tree without installing', () => {
    const first = child('');
    assert.equal(first.exitCode, 0, first.summary + first.stderr);
    const second = child('fs.readdirSync(fixture.configDir);');
    assert.equal(second.exitCode, 0, second.summary + second.stderr);
    assert.deepEqual(reported(second), reported(first));
    assert.equal(path.basename(path.dirname(reported(first).root)), path.basename(runRoot));
    assert.equal(fs.readdirSync(runRoot).filter((name) => name.endsWith('.json')).length, 1);
  });

  test('a process that writes into the tree exits 1, and a later process fails as soon as it asks for the tree', () => {
    const writer = child("fs.writeFileSync(path.join(fixture.configDir, 'written-by-a-test.txt'), 'x');");
    // It got its fixture and its write succeeded, so the exit code is the exit-time check's.
    assert.equal(typeof reported(writer).configDir, 'string', writer.summary + writer.stderr);
    assert.equal(fs.statSync(path.join(reported(writer).configDir, 'written-by-a-test.txt')).isFile(), true);
    assert.equal(writer.exitCode, 1, writer.summary + writer.stderr);

    const later = child('');
    assert.equal(later.exitCode, 1, later.summary);
    assert.deepEqual(reported(later), { refused: 'SHARED_FIXTURE_MODIFIED' });
  });
});

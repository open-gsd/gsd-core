'use strict';
/**
 * loadInstallExports honors the .gsd-source marker (relocated / runtime-mirror installs).
 *
 * Regression: findInstallSourceRoot and findAgentsSourceRoot honor a
 * <runtimeConfigDir>/.gsd-source marker so the commands/ and agents/ source can live
 * apart from the runtime lib. loadInstallExports did NOT — it hard-required
 * ../../../bin/install.js with no marker fallback. Any install that relocates
 * gsd-core/bin/lib away from the package root (e.g. a runtime mirror at
 * ~/.claude/gsd-core/, where only the inner gsd-core/ subtree is copied) could
 * resolve commands+agents via the marker but hard-failed the write path
 * (applySurface -> getInstallExports) on a MODULE_NOT_FOUND for bin/install.js.
 *
 * The marker points at <root>/commands/gsd; bin/install.js is a sibling of commands/
 * at the package root, mirroring findAgentsSourceRoot's <root>/agents derivation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadInstallExports } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

// A stub bin/install.js carrying a sentinel so we can prove WHICH install.js was loaded.
function writeStubInstall(binDir, sentinel) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'install.js'),
    `module.exports = { __sentinel: ${JSON.stringify(sentinel)}, ` +
      `computePathPrefix: () => '', applyRuntimeContentRewritesInPlace: () => {}, ` +
      `readGsdCommandNames: () => [] };\n`,
  );
}

// Build a relocated install: a package root with commands/gsd + bin/install.js (stub),
// and a separate runtime config dir whose .gsd-source marker points at <root>/commands/gsd.
function makeRelocatedInstall(sentinel, { withInstallJs = true } = {}) {
  const pkgRoot = createTempDir('gsd-fake-pkg-');
  const commandsGsd = path.join(pkgRoot, 'commands', 'gsd');
  fs.mkdirSync(commandsGsd, { recursive: true });
  if (withInstallJs) writeStubInstall(path.join(pkgRoot, 'bin'), sentinel);
  const configDir = createTempDir('gsd-relocated-cfg-');
  fs.writeFileSync(path.join(configDir, '.gsd-source'), commandsGsd);
  return { pkgRoot, commandsGsd, configDir };
}

describe('loadInstallExports — .gsd-source marker resolution', () => {
  test('honors the marker: loads bin/install.js from the marker-implied package root', () => {
    const { configDir, pkgRoot } = makeRelocatedInstall('from-marker-root');
    try {
      const exp = loadInstallExports(configDir);
      assert.equal(
        exp.__sentinel,
        'from-marker-root',
        'expected install.js to be loaded from <markerRoot>/bin/install.js',
      );
    } finally {
      cleanup(configDir);
      cleanup(pkgRoot);
    }
  });

  test('falls back to the package-relative path when no marker is present', () => {
    const configDir = createTempDir('gsd-nomarker-cfg-');
    try {
      const exp = loadInstallExports(configDir);
      assert.ok(exp && typeof exp === 'object', 'expected real install.js exports');
      assert.equal(exp.__sentinel, undefined, 'must not be the marker stub');
    } finally {
      cleanup(configDir);
    }
  });

  test('falls back when the marker resolves but bin/install.js is absent at that root', () => {
    const { configDir, pkgRoot } = makeRelocatedInstall('unused', { withInstallJs: false });
    try {
      const exp = loadInstallExports(configDir);
      assert.ok(exp && typeof exp === 'object');
      assert.equal(exp.__sentinel, undefined, 'guard must fall through to the real install.js');
    } finally {
      cleanup(configDir);
      cleanup(pkgRoot);
    }
  });

  test('no runtimeConfigDir → package-relative path (unchanged behavior)', () => {
    const exp = loadInstallExports();
    assert.ok(exp && typeof exp === 'object');
    assert.equal(exp.__sentinel, undefined);
  });

  test('marker file present but pointing at a non-existent dir → fallback', () => {
    const configDir = createTempDir('gsd-stalemarker-cfg-');
    fs.writeFileSync(path.join(configDir, '.gsd-source'), path.join(configDir, 'does', 'not', 'exist'));
    try {
      const exp = loadInstallExports(configDir);
      assert.ok(exp && typeof exp === 'object');
      assert.equal(exp.__sentinel, undefined, 'stale marker must not break resolution');
    } finally {
      cleanup(configDir);
    }
  });
});

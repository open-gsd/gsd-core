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

const { loadInstallExports, getInstallExports } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
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

describe('getInstallExports — keyed memoization (no-marker must not mask marker-aware)', () => {
  // Regression for the memoized accessor: getInstallExports caches the loaded
  // exports. With a single unkeyed slot, the FIRST call wins and a no-marker
  // (package-relative) load would mask a later marker-aware load — the exact
  // poisoning the surface write path (applySurface -> getInstallExports) hits
  // when an earlier call already primed the cache. The cache is keyed by the
  // resolved install source so the two memoize independently.
  test('a no-marker call does not poison a later marker-aware call', () => {
    // Prime the cache with the package-relative (no-marker) resolution first.
    const pkg = getInstallExports();
    assert.equal(pkg.__sentinel, undefined, 'no-arg call resolves the real package-relative install.js');

    // A subsequent marker-aware call MUST resolve the marker root, not return
    // the cached package-relative exports.
    const { configDir, pkgRoot } = makeRelocatedInstall('from-marker-memo');
    try {
      const viaMarker = getInstallExports(configDir);
      assert.equal(
        viaMarker.__sentinel,
        'from-marker-memo',
        'marker-aware getInstallExports must not be masked by an earlier no-marker load',
      );
    } finally {
      cleanup(configDir);
      cleanup(pkgRoot);
    }
  });

  test('marker resolution is memoized per source (same configDir returns the cached instance)', () => {
    const { configDir, pkgRoot } = makeRelocatedInstall('memoized-marker');
    try {
      const first = getInstallExports(configDir);
      const second = getInstallExports(configDir);
      assert.equal(first.__sentinel, 'memoized-marker');
      assert.equal(second, first, 'second call with the same source returns the cached instance');
    } finally {
      cleanup(configDir);
      cleanup(pkgRoot);
    }
  });
});

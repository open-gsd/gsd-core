'use strict';

/**
 * Regression tests for issue #1855: Claude plugin marketplace manifest.
 *
 * Asserts structural and semantic correctness of:
 *   .claude-plugin/marketplace.json  — Claude plugin marketplace manifest
 *
 * This manifest lets Claude-plugin-compatible runtimes (ZCODE et al.) discover
 * and install gsd-core from a custom marketplace source. It is the
 * marketplace-discovery sibling of .claude-plugin/plugin.json (issue #766),
 * which remains the Claude Code single-plugin manifest and is unchanged.
 *
 * The version that runtimes read lives at plugins[0].version (the canonical
 * marketplace schema location), and is kept in sync with package.json by
 * scripts/sync-manifest-versions.cjs via a nested versionKey descriptor.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const pluginJson = require(path.join(ROOT, '.claude-plugin', 'plugin.json'));
const {
  VERSIONED_MANIFESTS,
  VERSIONED_MANIFEST_PATHS,
  getByPath,
  setByPath,
  syncManifestVersions,
} = require(path.join(ROOT, 'scripts', 'sync-manifest-versions.cjs'));
const helpers = require(path.join(__dirname, 'helpers.cjs'));

const MARKETPLACE_JSON_PATH = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const MARKETPLACE_REL = '.claude-plugin/marketplace.json';

// ─── Section A: marketplace.json structure ───────────────────────────────────
describe('A: .claude-plugin/marketplace.json', () => {

  let manifest;

  test('exists and is valid JSON', () => {
    assert.ok(fs.existsSync(MARKETPLACE_JSON_PATH), '.claude-plugin/marketplace.json must exist');
    const raw = fs.readFileSync(MARKETPLACE_JSON_PATH, 'utf-8');
    manifest = JSON.parse(raw); // throws on invalid JSON
    assert.ok(typeof manifest === 'object' && manifest !== null, 'manifest must be a JSON object');
  });

  test('top-level name is a non-empty string', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(typeof manifest.name === 'string' && manifest.name.trim().length > 0, 'marketplace name must be a non-empty string');
  });

  test('top-level description is a non-empty string', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(typeof manifest.description === 'string' && manifest.description.trim().length > 0, 'marketplace description must be a non-empty string');
  });

  test('owner.{name,url} are non-empty strings', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(manifest.owner && typeof manifest.owner.name === 'string' && manifest.owner.name.trim().length > 0, 'owner.name must be a non-empty string');
    assert.ok(typeof manifest.owner.url === 'string' && /^https?:\/\//.test(manifest.owner.url), 'owner.url must be an http(s) URL');
  });

  test('plugins[] is a non-empty array', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(Array.isArray(manifest.plugins) && manifest.plugins.length > 0, 'plugins must be a non-empty array');
  });

  test('plugins[0] has the gsd-core entry with source "./"', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    const entry = manifest.plugins[0];
    assert.ok(entry && typeof entry === 'object', 'plugins[0] must be an object');
    assert.equal(entry.name, pluginJson.name, `plugins[0].name (${entry && entry.name}) must equal plugin.json name (${pluginJson.name})`);
    assert.equal(entry.source, './', 'plugins[0].source must be "./" (repo root, same as plugin.json relative refs)');
    assert.ok(typeof entry.description === 'string' && entry.description.trim().length > 0, 'plugins[0].description must be a non-empty string');
  });

  test('plugins[0].author.{name,url} match plugin.json author / owner', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    const entry = manifest.plugins[0];
    assert.ok(entry.author && typeof entry.author.name === 'string' && entry.author.name.trim().length > 0, 'plugins[0].author.name must be a non-empty string');
    assert.equal(entry.author.name, pluginJson.author && pluginJson.author.name, 'plugins[0].author.name must match plugin.json author.name');
  });

  test('plugins[0].version matches package.json version (synced)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    const entry = manifest.plugins[0];
    assert.equal(
      entry.version,
      pkg.version,
      `plugins[0].version (${entry.version}) must match package.json version (${pkg.version}). ` +
      'Run `node scripts/sync-manifest-versions.cjs` to fix — the marketplace plugin version is stamped via a nested versionKey descriptor. (#1855)'
    );
  });

  test('no plugins[0].$schema key (intentionally omitted, parity with plugin.json)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    const entry = manifest.plugins[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(entry, '$schema'), 'plugins[0] must NOT contain a $schema key');
  });
});

// ─── Section B: registration in the version-sync registry ────────────────────
describe('B: marketplace.json is registered for version sync', () => {

  test('marketplace.json path appears in VERSIONED_MANIFESTS', () => {
    const paths = VERSIONED_MANIFESTS.map((e) => (typeof e === 'string' ? e : e && e.path));
    assert.ok(
      paths.includes(MARKETPLACE_REL),
      `VERSIONED_MANIFESTS must register ${MARKETPLACE_REL} so 'npm version' keeps plugins[0].version in sync (issue #844 / #1855). Got: ${JSON.stringify(paths)}`
    );
  });

  test('marketplace.json entry uses the nested plugins.0.version key', () => {
    const entry = VERSIONED_MANIFESTS.find((e) => (typeof e === 'string' ? e : e && e.path) === MARKETPLACE_REL);
    // Nested dot-path is what makes the canonical marketplace version (plugins[0].version) the stamped field.
    const versionKey = typeof entry === 'string' ? 'version' : entry && entry.versionKey;
    assert.equal(
      versionKey,
      'plugins.0.version',
      `${MARKETPLACE_REL} must be registered with versionKey 'plugins.0.version' (the schema-canonical location runtimes read). Got: ${JSON.stringify(entry)}`
    );
  });

  test('marketplace.json is in the staging list (stageManifests derives from VERSIONED_MANIFEST_PATHS)', () => {
    // stageManifests() git-adds [...VERSIONED_MANIFEST_PATHS, ...capabilities]. If
    // marketplace.json were dropped from the paths list, `npm version` would stage
    // every other manifest but silently skip it — so pin the path here too.
    assert.ok(
      VERSIONED_MANIFEST_PATHS.includes(MARKETPLACE_REL),
      `VERSIONED_MANIFEST_PATHS must include ${MARKETPLACE_REL} so stageManifests() stages it on npm version. Got: ${JSON.stringify(VERSIONED_MANIFEST_PATHS)}`
    );
  });
});

// ─── Section D: nested-path helpers are prototype-pollution-safe ──────────────
describe('D: getByPath / setByPath reject reserved properties', () => {

  test('plugins.0.version resolves a nested array-index path', () => {
    const doc = { plugins: [{ version: '1.2.3' }] };
    assert.equal(getByPath(doc, 'plugins.0.version'), '1.2.3');
  });

  test('getByPath returns undefined for a missing intermediate', () => {
    assert.equal(getByPath({ plugins: [] }, 'plugins.0.version'), undefined);
  });

  for (const reserved of ['__proto__', 'constructor', 'prototype']) {
    test(`getByPath refuses to traverse "${reserved}"`, () => {
      assert.throws(
        () => getByPath({}, `${reserved}.x`),
        /refusing to traverse reserved property/,
        `getByPath must reject the reserved "${reserved}" segment`
      );
    });
    test(`setByPath refuses to assign through "${reserved}" (no prototype pollution)`, () => {
      const target = {};
      assert.throws(
        () => setByPath(target, `${reserved}.polluted`, 'yes'),
        /refusing to traverse reserved property/,
        `setByPath must reject the reserved "${reserved}" segment`
      );
      // Confirm nothing leaked onto Object.prototype.
      assert.ok(({}).polluted === undefined, 'Object.prototype must not be polluted');
    });
  }
});

// ─── Section C: sync stamps the nested version (temp fixture, red→green) ─────
describe('C: syncManifestVersions stamps plugins[0].version (temp fixture)', () => {

  test('stamps a stale marketplace plugins[0].version to the package version, then is idempotent', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1855-'));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, 'package.json'),
        JSON.stringify({ name: 'x', version: '9.9.9-test.0' }, null, 2) + '\n'
      );
      // Seed a stale marketplace.json with a nested plugins[0].version.
      const destAbs = path.join(tmpRoot, MARKETPLACE_REL);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      const stale = JSON.parse(fs.readFileSync(MARKETPLACE_JSON_PATH, 'utf8'));
      stale.plugins[0].version = '0.0.0';
      fs.writeFileSync(destAbs, JSON.stringify(stale, null, 2) + '\n');

      // Only sync the marketplace manifest in this fixture (other registered
      // manifests are absent under tmpRoot). syncManifestVersions tolerates a
      // missing manifest file by... it does NOT — it readJson-throws. So seed
      // the other registered manifests too (stale) so the sync loop is happy.
      for (const e of VERSIONED_MANIFESTS) {
        const rel = typeof e === 'string' ? e : e.path;
        if (rel === MARKETPLACE_REL) continue;
        const realAbs = path.join(ROOT, rel);
        if (!fs.existsSync(realAbs)) continue;
        const other = JSON.parse(fs.readFileSync(realAbs, 'utf8'));
        const vk = typeof e === 'string' ? 'version' : (e.versionKey || 'version');
        setNested(other, vk, '0.0.0');
        const d = path.join(tmpRoot, rel);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.writeFileSync(d, JSON.stringify(other, null, 2) + '\n');
      }

      const changed = syncManifestVersions({ root: tmpRoot });
      assert.ok(changed.includes(MARKETPLACE_REL), `sync should report ${MARKETPLACE_REL} as changed`);

      const synced = JSON.parse(fs.readFileSync(destAbs, 'utf8'));
      assert.equal(synced.plugins[0].version, '9.9.9-test.0', 'plugins[0].version should be stamped to the package version');

      // Idempotent second run does not re-report the marketplace manifest.
      const changed2 = syncManifestVersions({ root: tmpRoot });
      assert.ok(!changed2.includes(MARKETPLACE_REL), 'second sync should not re-report an already-synced marketplace manifest');
    } finally {
      helpers.cleanup(tmpRoot);
    }
  });
});

// Minimal nested dot-path setter mirroring the sync script's helper, for fixture seeding.
function setNested(obj, dotPath, value) {
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

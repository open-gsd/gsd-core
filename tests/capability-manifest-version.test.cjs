'use strict';

/**
 * Phase 1 (ADR-1244 / issue #1430): versioned capability manifest.
 *
 * The build-time validator in scripts/gen-capability-registry.cjs must:
 *   - REQUIRE a semver `version` on every capability (the registry rejects a
 *     manifest without one — ADR-1244 D1).
 *   - Shape-validate the optional ecosystem envelope fields `engines`,
 *     `compatVersions`, `integrity`, `provenance` when present.
 *
 * Every native capabilities/<id>/capability.json must carry a valid `version`
 * and `engines.gsd` (the conformance / parity requirement: the build fails when
 * a native manifest lacks a version).
 *
 * These are behavioral tests against the exported validator + generator
 * pipeline — no source-grep. They mirror the harness in
 * tests/capability-registry.test.cjs (makeTempCapDir + loadAndValidate +
 * buildRegistry).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const helpers = require(path.join(__dirname, 'helpers.cjs'));
const {
  validateCapability,
  loadAndValidate,
  buildRegistry,
  SEMVER_RE,
} = require(path.join(ROOT, 'scripts', 'gen-capability-registry.cjs'));

const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const CAPABILITIES_DIR = path.join(ROOT, 'capabilities');

// Single source of truth: the validator's own strict-semver regex.
const SEMVER = SEMVER_RE;

// ─── Minimal, otherwise-valid fixtures ───────────────────────────────────────

function featureCap(overrides) {
  return {
    id: 'demo',
    role: 'feature',
    version: '1.2.3',
    title: 'Demo',
    description: 'A demo capability.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.6.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    ...overrides,
  };
}

function runtimeCap(overrides) {
  return {
    id: 'demo-rt',
    role: 'runtime',
    version: '1.2.3',
    title: 'Demo RT',
    description: 'A demo runtime.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.6.0' },
    runtime: {
      configHome: { kind: 'dot-home', name: '.demo', env: [] },
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'settings-json',
      sandboxTier: 'none',
      supportTier: 2,
      installSurface: 'settings-json',
      writesSharedSettings: false,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
    ...overrides,
  };
}

function makeTempCapDir(capabilities) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ver-test-'));
  for (const [id, cap] of Object.entries(capabilities)) {
    const subDir = path.join(tmpDir, id);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return tmpDir;
}

// ─── Sanity: the base fixtures are valid as-is ───────────────────────────────

describe('version envelope — base fixtures are valid', () => {
  test('a feature cap with a valid version passes validation', () => {
    assert.deepEqual(validateCapability(featureCap(), 'demo'), []);
  });
  test('a runtime cap with a valid version passes validation', () => {
    assert.deepEqual(validateCapability(runtimeCap(), 'demo-rt'), []);
  });
});

// ─── version is required + semver ────────────────────────────────────────────

describe('version is required and must be semver', () => {
  test('missing version is rejected (feature)', () => {
    const { version: _v, ...cap } = featureCap();
    const errors = validateCapability(cap, 'demo');
    assert.ok(errors.some((e) => e.includes('version')), `expected a version error, got: ${JSON.stringify(errors)}`);
  });

  test('missing version is rejected (runtime)', () => {
    const { version: _v, ...cap } = runtimeCap();
    const errors = validateCapability(cap, 'demo-rt');
    assert.ok(errors.some((e) => e.includes('version')), `expected a version error, got: ${JSON.stringify(errors)}`);
  });

  test('empty-string version is rejected', () => {
    const errors = validateCapability(featureCap({ version: '' }), 'demo');
    assert.ok(errors.some((e) => e.includes('version')));
  });

  test('whitespace-only version is rejected', () => {
    const errors = validateCapability(featureCap({ version: '   ' }), 'demo');
    assert.ok(errors.some((e) => e.includes('version')));
  });

  test('non-semver versions are rejected', () => {
    for (const bad of ['1.0', 'v1.0.0', '1.0.0.0', '1', 'latest', '1.x', '1.0.0 ', '01.2.3']) {
      const errors = validateCapability(featureCap({ version: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('version')), `expected "${bad}" to be rejected`);
    }
  });

  test('malformed/hostile prerelease & build identifiers are rejected (strict semver)', () => {
    // The prerelease/build suffix must be dot-separated [0-9A-Za-z-] identifiers
    // with no leading-zero numerics and no empty segments — so a version can
    // never smuggle shell metacharacters, spaces or unicode downstream.
    for (const bad of ['1.2.3-01', '1.2.3-..', '1.2.3-', '1.2.3+', '1.2.3-foo bar', '1.2.3-$(whoami)', '1.2.3-`id`', '1.2.3-😈', '1.2.3+build meta']) {
      const errors = validateCapability(featureCap({ version: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('version')), `expected hostile suffix "${bad}" to be rejected`);
    }
  });

  test('non-string version is rejected', () => {
    for (const bad of [123, null, {}, ['1.0.0']]) {
      const errors = validateCapability(featureCap({ version: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('version')), `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test('valid semver versions (incl. prerelease/build) pass', () => {
    for (const ok of ['1.0.0', '0.0.1', '10.20.30', '1.2.3-dev.0', '1.2.3-rc.1', '1.2.3+build.5', PKG_VERSION]) {
      const errors = validateCapability(featureCap({ version: ok }), 'demo');
      assert.deepEqual(errors, [], `expected "${ok}" to pass, got: ${JSON.stringify(errors)}`);
    }
  });

  test('hostile version strings are rejected (shell metachars, newline, unicode)', () => {
    for (const bad of ['1.0.0; rm -rf /', '1.0.0\n2.0.0', '1.0.0$(whoami)', '१.२.३', '1.0.0`id`']) {
      const errors = validateCapability(featureCap({ version: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('version')), `expected hostile "${bad}" to be rejected`);
    }
  });
});

// ─── engines (optional; shape-validated) ─────────────────────────────────────

describe('engines is optional but shape-validated when present', () => {
  test('omitting engines is valid', () => {
    const { engines: _e, ...cap } = featureCap();
    assert.deepEqual(validateCapability(cap, 'demo'), []);
  });

  test('engines must be an object', () => {
    for (const bad of ['>=1.6.0', 123, ['gsd'], null]) {
      const errors = validateCapability(featureCap({ engines: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('engines')), `expected engines=${JSON.stringify(bad)} rejected`);
    }
  });

  test('engines.gsd must be a non-empty range string', () => {
    for (const bad of ['', '   ', 123, {}, 'not a range!!', '>=1.0.0; rm -rf', 'abcx', '()x']) {
      const errors = validateCapability(featureCap({ engines: { gsd: bad } }), 'demo');
      assert.ok(errors.some((e) => e.includes('engines')), `expected engines.gsd=${JSON.stringify(bad)} rejected`);
    }
  });

  test('valid engines.gsd ranges pass', () => {
    for (const ok of ['>=1.6.0', '>=1.6.0 <3.0.0', '^1.0.0', '~1.2.0', '1.x', '*', '>=1.6.0 || >=2.0.0']) {
      const errors = validateCapability(featureCap({ engines: { gsd: ok } }), 'demo');
      assert.deepEqual(errors, [], `expected range "${ok}" to pass, got: ${JSON.stringify(errors)}`);
    }
  });
});

// ─── compatVersions / integrity / provenance (optional; shape-validated) ──────

describe('optional ecosystem envelope fields are shape-validated', () => {
  test('compatVersions must be an object of semver→range strings', () => {
    assert.deepEqual(validateCapability(featureCap({ compatVersions: { '1.0.0': '>=1.6.0' } }), 'demo'), []);
    for (const bad of ['x', 123, { '1.0.0': 5 }, { 'not-semver': '>=1.6.0' }]) {
      const errors = validateCapability(featureCap({ compatVersions: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('compatVersions')), `expected compatVersions=${JSON.stringify(bad)} rejected`);
    }
  });

  test('integrity must be sha512-<base64>', () => {
    const good = 'sha512-' + 'a'.repeat(86) + '==';
    assert.deepEqual(validateCapability(featureCap({ integrity: good }), 'demo'), []);
    for (const bad of ['abc', 'sha256-deadbeef', 'sha512-', 'sha512-abc', 'sha512-' + 'a'.repeat(40) + '==', 123, 'sha512-not base64!!']) {
      const errors = validateCapability(featureCap({ integrity: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('integrity')), `expected integrity=${JSON.stringify(bad)} rejected`);
    }
  });

  test('provenance must be { sourceRepo, commit } strings', () => {
    assert.deepEqual(validateCapability(featureCap({ provenance: { sourceRepo: 'https://x/y', commit: 'abc123' } }), 'demo'), []);
    for (const bad of ['x', 123, { sourceRepo: 5, commit: 'c' }, { sourceRepo: 'r' }, { commit: 'c' }]) {
      const errors = validateCapability(featureCap({ provenance: bad }), 'demo');
      assert.ok(errors.some((e) => e.includes('provenance')), `expected provenance=${JSON.stringify(bad)} rejected`);
    }
  });
});

// ─── Registry pass-through ────────────────────────────────────────────────────

describe('generated registry preserves version + engines', () => {
  test('buildRegistry carries version and engines onto the capability object', (t) => {
    const capDir = makeTempCapDir({ demo: featureCap({ id: 'demo', version: '2.5.0', engines: { gsd: '>=1.6.0 <2.0.0' } }) });
    t.after(() => helpers.cleanup(capDir));

    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], `loadAndValidate errors: ${JSON.stringify(errors)}`);
    const registry = buildRegistry(capMap);
    assert.equal(registry.capabilities.demo.version, '2.5.0');
    assert.equal(registry.capabilities.demo.engines.gsd, '>=1.6.0 <2.0.0');
  });

  test('loadAndValidate rejects a capability dir whose manifest lacks a version', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ver-noversion-'));
    t.after(() => helpers.cleanup(tmpDir));
    const sub = path.join(tmpDir, 'demo');
    fs.mkdirSync(sub, { recursive: true });
    const { version: _v, ...noVersion } = featureCap({ id: 'demo' });
    fs.writeFileSync(path.join(sub, 'capability.json'), JSON.stringify(noVersion), 'utf8');

    const { errors } = loadAndValidate(new Set(), tmpDir);
    assert.ok(errors.some((e) => e.includes('version')), `expected a version error, got: ${JSON.stringify(errors)}`);
  });
});

// ─── Native manifest conformance (the ADR-1244 parity requirement) ────────────

describe('every native capability.json carries a valid version + engines.gsd', () => {
  const ids = fs
    .readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  test('there are native capabilities to check', () => {
    assert.ok(ids.length >= 30, `expected the full native capability set, found ${ids.length}`);
  });

  for (const id of ids) {
    test(`capabilities/${id}/capability.json has a semver version`, () => {
      const cap = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, id, 'capability.json'), 'utf8'));
      assert.equal(typeof cap.version, 'string', `${id}: version must be a string`);
      assert.ok(SEMVER.test(cap.version), `${id}: version "${cap.version}" must be semver`);
    });

    test(`capabilities/${id}/capability.json declares engines.gsd`, () => {
      const cap = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, id, 'capability.json'), 'utf8'));
      assert.ok(cap.engines && typeof cap.engines.gsd === 'string' && cap.engines.gsd.length > 0,
        `${id}: engines.gsd must be a non-empty string`);
    });

    test(`capabilities/${id}/capability.json passes validateCapability`, () => {
      const cap = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, id, 'capability.json'), 'utf8'));
      assert.deepEqual(validateCapability(cap, id), [], `${id}: native manifest must validate`);
    });
  }
});

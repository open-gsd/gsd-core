'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'validate-registry.cjs');

// validate-registry.cjs resolves docs/registries/ from process.cwd(), so
// tests drive it as a subprocess with `cwd` pointed at an isolated temp
// fixture directory — this covers main() end-to-end without touching the
// real repo's docs/registries/capabilities.json.

function validCapabilityEntry() {
  return {
    id: 'my-capability',
    name: 'My Capability',
    type: 'capability',
    repo: 'octocat/my-capability',
    description: 'Does a useful thing for GSD users.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-capability.git#v1.0.0',
    uninstall: 'gsd capability remove my-capability',
    interactions: {
      loopExtensionPoints: ['execute:pre'],
      hookKinds: ['step'],
      configKeys: [],
      requires: [],
      runtimeCompat: ['all'],
      produces: [],
      consumes: [],
    },
    discussion: 'https://github.com/octocat/my-capability/discussions/1',
  };
}

function withFixture(entries, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(entries, null, 2) + '\n');
    fn(tmp);
  } finally {
    cleanup(tmp);
  }
}

function runValidate(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8' });
}

describe('validate-registry CLI (subprocess)', () => {
  test('a good capabilities.json fixture exits 0', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runValidate(tmp);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    });
  });

  test('a bad capabilities.json fixture (missing required field) exits non-zero', () => {
    const bad = validCapabilityEntry();
    delete bad.discussion;
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    });
  });

  test('a bad capabilities.json fixture (bad id) exits non-zero', () => {
    const bad = validCapabilityEntry();
    bad.id = 'Not_Kebab_Case';
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    });
  });

  test('--json prints a parseable verdict for a good fixture', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.ok, 'boolean');
      assert.ok(Array.isArray(parsed.results));
      assert.ok(parsed.results.some((r) => r.file === 'capabilities.json'));
    });
  });

  test('--json prints a parseable verdict for a bad fixture', () => {
    const bad = validCapabilityEntry();
    delete bad.license;
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.ok, 'boolean');
      assert.equal(parsed.ok, false);
    });
  });

  test('missing capabilities.json entirely exits non-zero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-empty-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    } finally {
      cleanup(tmp);
    }
  });
});

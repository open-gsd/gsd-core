'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'gen-registry.cjs');
const { renderMarkdown } = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

// gen-registry.cjs resolves docs/registries/ from process.cwd() (mirrors
// validate-registry.cjs), so tests drive it as a subprocess with `cwd`
// pointed at an isolated temp fixture directory.

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(entries, null, 2) + '\n');
    fn(tmp, registriesDir);
  } finally {
    cleanup(tmp);
  }
}

function runGen(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8' });
}

describe('gen-registry CLI (subprocess)', () => {
  test('--write then --check is clean (no drift) for a populated registry', () => {
    withFixture([validCapabilityEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);
      assert.ok(fs.existsSync(path.join(registriesDir, 'capability-registry.md')));

      const check = runGen(tmp, ['--check']);
      assert.equal(check.status, 0, `stderr: ${check.stderr}`);
    });
  });

  test('hand-mutating the generated md then --check fails (drift detected)', () => {
    withFixture([validCapabilityEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'capability-registry.md');
      fs.appendFileSync(mdPath, '\nhand-edited drift line\n');

      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0);
    });
  });

  test('--write on an empty registry ([]) produces md containing the empty-state text', () => {
    withFixture([], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'capability-registry.md');
      const content = fs.readFileSync(mdPath, 'utf8');
      assert.match(content, /No entries yet/);
    });
  });

  test('default (no flag) prints rendered markdown to stdout', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runGen(tmp, []);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.length > 0);
    });
  });
});

describe('gen-registry CLI (subprocess): F3 — missing capabilities.json is an error, not a silent pass', () => {
  test('--check exits non-zero when docs/registries/ exists but capabilities.json is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-nocaps-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      // Deliberately do NOT write capabilities.json — only eos.json is optional.
      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0, `expected non-zero exit, got 0. stdout: ${check.stdout}`);
      assert.match(check.stderr, /capabilities\.json/);
    } finally {
      cleanup(tmp);
    }
  });

  test('default mode (no flag) also hard-errors when capabilities.json is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-nocaps-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      const result = runGen(tmp, []);
      assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout: ${result.stdout}`);
      assert.match(result.stderr, /capabilities\.json/);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('gen-registry: renderMarkdown (direct, via registry-schema)', () => {
  test('renders empty-state text for an empty capability registry', () => {
    const rendered = renderMarkdown([], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /No entries yet/);
  });

  test('renders the shields.io badge + discussion link for a populated capability registry', () => {
    const entry = validCapabilityEntry();
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /img\.shields\.io\/github\/v\/release/);
    assert.ok(rendered.includes(entry.discussion));
  });
});

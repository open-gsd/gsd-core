'use strict';

/**
 * gen-cli-surface-manifest.cjs drift guard (#6087, P1a of #6051). Matrix rows T-M1..T-M7.
 * Every test spawns the real generator CLI against the committed manifest or a temp copy.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { CLI_SURFACE, UNDECLARED_VERBS, specFor } = require('../gsd-core/bin/lib/cli-surface.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-cli-surface-manifest.cjs');
const COMMITTED = path.join(ROOT, 'docs', 'CLI-SURFACE-MANIFEST.json');

function runGen(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GENERATOR_SCRIPT_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function withTmp(t) {
  const dir = createTempDir('gsd-cli-surface-');
  t.after(() => cleanup(dir));
  return dir;
}

describe('gen-cli-surface-manifest.cjs --check / --write', () => {
  test('T-M1: --check passes on the committed manifest', () => {
    const r = runGen(['--check']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  });

  test('T-M2: --check names the verb when a flag is removed from a temp copy', (t) => {
    const dir = withTmp(t);
    const manifest = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
    const entry = manifest.verbs.find((v) => Object.keys(v.flags).length > 0);
    assert.ok(entry, 'manifest must contain at least one verb with flags');
    delete entry.flags[Object.keys(entry.flags).sort()[0]];
    const tmpPath = path.join(dir, 'CLI-SURFACE-MANIFEST.json');
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const r = runGen(['--check', '--json', '--manifest-path', tmpPath]);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok((r.stdout + r.stderr).includes(entry.verb), `output must name ${entry.verb}`);
  });

  test('T-M3: --check on a missing manifest exits 1 and points at --write', (t) => {
    const dir = withTmp(t);
    const r = runGen(['--check', '--manifest-path', path.join(dir, 'absent.json')]);
    assert.equal(r.code, 1);
    assert.ok((r.stdout + r.stderr).includes('--write'), `${r.stdout}${r.stderr}`);
  });

  test('T-M4: --write is deterministic and byte-identical to the committed manifest', (t) => {
    const dir = withTmp(t);
    const tmpPath = path.join(dir, 'CLI-SURFACE-MANIFEST.json');
    assert.equal(runGen(['--write', '--manifest-path', tmpPath]).code, 0);
    const first = fs.readFileSync(tmpPath);
    assert.equal(runGen(['--write', '--manifest-path', tmpPath]).code, 0);
    const second = fs.readFileSync(tmpPath);
    assert.ok(first.equals(second), 'two --write runs must be byte-identical');
    assert.ok(first.equals(fs.readFileSync(COMMITTED)), 'must match docs/CLI-SURFACE-MANIFEST.json');
  });

  test('T-M5: verbs with requiredFlags carry a sorted required array matching the registry', () => {
    const manifest = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
    const byVerb = new Map(manifest.verbs.map((v) => [v.verb, v]));
    for (const verb of Object.keys(CLI_SURFACE)) {
      const expected = [...(specFor(verb).requiredFlags ?? [])].sort();
      const entry = byVerb.get(verb);
      assert.ok(entry, `manifest missing declared verb ${verb}`);
      assert.deepEqual(entry.required, expected, `${verb}: required mismatch`);
    }
  });

  test('T-M6: undeclared equals the sorted UNDECLARED_VERBS', () => {
    const manifest = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
    assert.deepEqual(manifest.undeclared, [...UNDECLARED_VERBS].sort());
  });

  test('T-M7: an unknown argument exits 2', () => {
    const r = runGen(['--zz-not-an-option']);
    assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  });
});

describe('gen-cli-surface-manifest.cjs compiled-artifact freshness', () => {
  const { staleCompileProblem, aliasMap } = require('../scripts/gen-cli-surface-manifest.cjs');

  function pair(dir, { sourceAgeS, compiledAgeS }) {
    const source = path.join(dir, 'thing.cts');
    const compiled = path.join(dir, 'thing.cjs');
    fs.writeFileSync(source, '// src\n');
    fs.writeFileSync(compiled, '// out\n');
    const now = Date.now() / 1000;
    fs.utimesSync(source, now - sourceAgeS, now - sourceAgeS);
    fs.utimesSync(compiled, now - compiledAgeS, now - compiledAgeS);
    return { source, compiled };
  }

  test('T-M8: a compiled file older than its source names npm run build:lib', (t) => {
    const dir = withTmp(t);
    const message = staleCompileProblem([pair(dir, { sourceAgeS: 10, compiledAgeS: 100 })]);
    assert.ok(message, 'a stale compile must be reported');
    assert.ok(message.includes('npm run build:lib'), message);
    assert.ok(message.includes('thing.cjs') && message.includes('thing.cts'), message);
  });

  test('T-M9: a compiled file as new as, or newer than, its source passes', (t) => {
    const dir = withTmp(t);
    assert.equal(staleCompileProblem([pair(dir, { sourceAgeS: 100, compiledAgeS: 10 })]), null);
    const dir2 = withTmp(t);
    assert.equal(staleCompileProblem([pair(dir2, { sourceAgeS: 50, compiledAgeS: 50 })]), null);
  });

  test('T-M10: a missing compiled file is reported as not built', (t) => {
    const dir = withTmp(t);
    const source = path.join(dir, 'thing.cts');
    fs.writeFileSync(source, '// src\n');
    const message = staleCompileProblem([{ source, compiled: path.join(dir, 'thing.cjs') }]);
    assert.ok(message && message.includes('npm run build:lib'), message);
  });

  test('T-M11: a source that is not on disk (an installed package) is not checked', (t) => {
    const dir = withTmp(t);
    const compiled = path.join(dir, 'thing.cjs');
    fs.writeFileSync(compiled, '// out\n');
    assert.equal(staleCompileProblem([{ source: path.join(dir, 'absent.cts'), compiled }]), null);
  });

  test('T-M12: the real compiled registry and seam are fresh in this checkout', () => {
    assert.equal(staleCompileProblem(), null);
  });

  test('T-M13: duplicate aliases collapse to one sorted entry per canonical', () => {
    const aliases = aliasMap();
    for (const [canonical, list] of aliases) {
      assert.deepEqual(list, [...new Set(list)].sort(), `${canonical}: aliases must be unique and sorted`);
    }
  });
});

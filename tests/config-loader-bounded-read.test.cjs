'use strict';

/**
 * #5759 — config.json is read as a bounded regular file, in the loader and in the
 * resolve-model "omit" check.
 *
 * The FIFO / device / directory rows need a real POSIX file system and live in
 * tests/config-loader-bounded-read.platform.test.cjs (#5074 split). This file holds the
 * rows that are file-system-neutral: the size cap boundary, parity of absent /
 * corrupt / precedence behaviour, and the property that a regular config below the
 * cap reads back byte-for-byte.
 *
 * Assertions use the CONFIG_REASON codes (`config_unreadable`, ...) and errno codes
 * (`EFBIG`), never diagnostic prose.
 */

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, TOOLS_PATH, installSpawnEnv } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');

const { loadConfigResolved, CONFIG_MAX_BYTES, readConfigFileBounded } = configLoader;

/** A JSON config document padded with trailing whitespace to exactly `bytes` bytes. */
function paddedConfig(obj, bytes) {
  const body = JSON.stringify(obj);
  assert.ok(bytes >= body.length, 'padding target must be at least the document length');
  return body + ' '.repeat(bytes - body.length);
}

/** Collect every stderr write made while `fn` runs. */
function captureStderr(fn) {
  const spy = mock.method(process.stderr, 'write', () => true);
  try {
    fn();
    return spy.mock.calls.map((c) => String(c.arguments[0]));
  } finally {
    spy.mock.restore();
  }
}

describe('#5759 CONFIG_MAX_BYTES contract', () => {
  test('the cap is exported and is 1 MiB', () => {
    assert.strictEqual(CONFIG_MAX_BYTES, 1024 * 1024);
  });
});

describe('#5759 config size boundary — limit-1, limit, limit+1', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-size-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  const configPath = () => path.join(tmpDir, '.planning', 'config.json');

  for (const [label, delta] of [['limit-1', -1], ['limit', 0]]) {
    test(`a regular config at the cap boundary (${label}) is read and applied`, () => {
      fs.writeFileSync(configPath(), paddedConfig({ model_profile: 'quality' }, CONFIG_MAX_BYTES + delta));
      assert.strictEqual(fs.statSync(configPath()).size, CONFIG_MAX_BYTES + delta);

      const r = loadConfigResolved(tmpDir);
      assert.strictEqual(r.reason, 'resolved');
      assert.strictEqual(r.degraded, false);
      assert.strictEqual(r.config.model_profile, 'quality');
    });
  }

  test('a regular config of CONFIG_MAX_BYTES + 1 bytes (limit+1) is unreadable with EFBIG, warned once', () => {
    fs.writeFileSync(configPath(), paddedConfig({ model_profile: 'quality' }, CONFIG_MAX_BYTES + 1));

    let first;
    const writes = captureStderr(() => {
      first = loadConfigResolved(tmpDir);
      loadConfigResolved(tmpDir);
    });

    assert.strictEqual(first.reason, 'config_unreadable');
    assert.strictEqual(first.degraded, true);
    assert.notStrictEqual(first.config.model_profile, 'quality', 'an oversized config must not be applied');
    const warnings = writes.filter((w) => w.includes(configPath()) && w.includes('EFBIG'));
    assert.strictEqual(warnings.length, 1, 'the unusable-config diagnostic is deduplicated per path and errno');
  });
});

describe('#5759 parity — absent, corrupt, precedence are unchanged', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-parity-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  const rootConfig = () => path.join(tmpDir, '.planning', 'config.json');
  const wsConfig = () => path.join(tmpDir, '.planning', 'workstreams', 'ws1', 'config.json');

  test('an absent config is not_configured, not a fault', () => {
    const r = loadConfigResolved(tmpDir);
    assert.strictEqual(r.reason, 'not_configured');
    assert.strictEqual(r.degraded, false);
  });

  test('a corrupt config is config_unparseable, not absent', () => {
    fs.writeFileSync(rootConfig(), '{"model_profile": ');
    const r = loadConfigResolved(tmpDir);
    assert.strictEqual(r.reason, 'config_unparseable');
    assert.strictEqual(r.degraded, true);
  });

  test('a workstream value wins over the root value', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({ model_profile: 'budget' }));
    fs.writeFileSync(wsConfig(), JSON.stringify({ model_profile: 'quality' }));
    const r = loadConfigResolved(tmpDir, { workstream: 'ws1' });
    assert.strictEqual(r.source, 'workstream');
    assert.strictEqual(r.config.model_profile, 'quality');
  });

  test('loader precedence: a workstream value over a root omit means omit does not apply', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({ resolve_model_ids: 'omit' }));
    fs.writeFileSync(wsConfig(), JSON.stringify({ resolve_model_ids: 'keep' }));
    const r = runNode([TOOLS_PATH, 'resolve-model', 'gsd-executor', '--ws', 'ws1'], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: '' }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, r.summary);
    assert.strictEqual(r.exitCode, 0, r.summary);
    assert.notStrictEqual(JSON.parse(r.stdout).model, '', 'the workstream layer set the key, so root omit must not apply');
  });

  test('resolve-model: a root "omit" with a workstream that does not set the key falls through to root', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({ resolve_model_ids: 'omit' }));
    fs.writeFileSync(wsConfig(), JSON.stringify({}));
    const r = runNode([TOOLS_PATH, 'resolve-model', 'gsd-executor', '--ws', 'ws1'], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: '' }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, r.summary);
    assert.strictEqual(r.exitCode, 0, r.summary);
    assert.strictEqual(JSON.parse(r.stdout).model, '');
  });
});

describe('#5759 parity — migrateOnDisk applies the same size cap as readConfigFileBounded', () => {
  const { migrateOnDisk } = require('../gsd-core/bin/lib/configuration.cjs');
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-migrate-')); });
  afterEach(() => { cleanup(tmpDir); });

  // configuration.cts may not import a sibling (#3571), so it carries its own copy of the cap;
  // this row fails if the two bounds ever diverge.
  for (const [label, delta, migrates] of [['limit-1', -1, true], ['limit', 0, true], ['limit+1', 1, false]]) {
    test(`a legacy-key config of CONFIG_MAX_BYTES ${label} bytes ${migrates ? 'is migrated' : 'is left alone'}`, () => {
      const file = path.join(tmpDir, 'config.json');
      fs.writeFileSync(file, paddedConfig({ branching_strategy: 'phase' }, CONFIG_MAX_BYTES + delta));

      const report = migrateOnDisk(tmpDir, undefined, file);

      assert.strictEqual(report.migrated, migrates);
    });
  }
});

describe('#5759 the unusable-config warning names what is applied instead', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-warn-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  const rootConfig = () => path.join(tmpDir, '.planning', 'config.json');
  const wsConfig = () => path.join(tmpDir, '.planning', 'workstreams', 'ws1', 'config.json');
  const warningFor = (writes, file) => writes.filter((w) => w.includes(file)).join('');

  test('an unusable workstream config with a usable root config says the root config is used', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({ model_profile: 'budget' }));
    fs.mkdirSync(wsConfig());

    let resolution;
    const writes = captureStderr(() => { resolution = loadConfigResolved(tmpDir, { workstream: 'ws1' }); });

    assert.strictEqual(resolution.source, 'root');
    assert.strictEqual(resolution.config.model_profile, 'budget');
    const warning = warningFor(writes, wsConfig());
    assert.ok(warning.includes('using the root config instead'), warning);
    assert.ok(!warning.includes('using defaults instead'), warning);
  });

  test('an unusable root config with no workstream says defaults are used', () => {
    fs.mkdirSync(rootConfig());

    const writes = captureStderr(() => { loadConfigResolved(tmpDir); });

    const warning = warningFor(writes, rootConfig());
    assert.ok(warning.includes('using defaults instead'), warning);
    assert.ok(!warning.includes('using the root config instead'), warning);
  });

  test('an unusable workstream config with no root config says defaults are used', () => {
    fs.mkdirSync(wsConfig());

    const writes = captureStderr(() => { loadConfigResolved(tmpDir, { workstream: 'ws1' }); });

    const warning = warningFor(writes, wsConfig());
    assert.ok(warning.includes('using defaults instead'), warning);
    assert.ok(!warning.includes('using the root config instead'), warning);
  });

  test('an unusable root config beside a usable workstream config does not claim defaults replace it', () => {
    fs.mkdirSync(rootConfig());
    fs.writeFileSync(wsConfig(), JSON.stringify({ model_profile: 'quality' }));

    const writes = captureStderr(() => { loadConfigResolved(tmpDir, { workstream: 'ws1' }); });

    const warning = warningFor(writes, rootConfig());
    assert.ok(warning.length > 0, 'the unusable root config is still reported');
    assert.ok(!warning.includes('using defaults instead'), warning);
  });
});

describe('#5759 property — a regular config under the cap reads back unchanged', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-prop-')); });
  afterEach(() => { cleanup(tmpDir); });

  test('readConfigFileBounded returns the exact text and the same key set for any JSON object', () => {
    const file = path.join(tmpDir, 'config.json');
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const text = JSON.stringify(obj, null, 2);
        fs.writeFileSync(file, text, 'utf8');
        const read = readConfigFileBounded(file);
        assert.strictEqual(read, fs.readFileSync(file, 'utf8'));
      }),
    );
  });

  test('a file of n bytes around the cap: text when n <= CONFIG_MAX_BYTES, EFBIG when n > CONFIG_MAX_BYTES', () => {
    const file = path.join(tmpDir, 'sized-config.json');
    fc.assert(
      fc.property(fc.integer({ min: CONFIG_MAX_BYTES - 64, max: CONFIG_MAX_BYTES + 64 }), (n) => {
        const text = paddedConfig({ model_profile: 'quality' }, n);
        fs.writeFileSync(file, text, 'utf8');
        assert.strictEqual(fs.statSync(file).size, n);
        if (n <= CONFIG_MAX_BYTES) {
          assert.strictEqual(readConfigFileBounded(file), text);
        } else {
          assert.throws(() => readConfigFileBounded(file), (err) => err.code === 'EFBIG');
        }
      }),
      { numRuns: 20 },
    );
  });

  test('readConfigFileBounded returns null for an absent file', () => {
    assert.strictEqual(readConfigFileBounded(path.join(tmpDir, 'missing.json')), null);
  });
});

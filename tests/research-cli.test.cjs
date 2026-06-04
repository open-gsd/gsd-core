'use strict';

/**
 * Behavioral tests for research-store, research-plan, and package-legitimacy
 * CLI commands (gsd-tools dispatch layer).
 *
 * Conventions:
 *   - Uses runGsdTools from tests/helpers.cjs (no source-grep)
 *   - No wall-clock assertions (RULESET.TESTS.no-timing-assertion)
 *   - No network calls (package-legitimacy tests are arg-validation only)
 *   - Each test gets a fresh temp dir via fs.mkdtempSync
 *   - HOME is overridden via runGsdTools env param to sandbox ~/.gsd/ writes
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Helper: make a temp dir and return it (caller is responsible for cleanup)
// ---------------------------------------------------------------------------
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-research-test-'));
}

// ---------------------------------------------------------------------------
// (a) research-store put then get round-trip
// ---------------------------------------------------------------------------

describe('research-store: put then get round-trip', () => {
  test('put stores entry; get returns hit:true, stale:false, correct content', () => {
    const tmpDir = makeTempDir();
    try {
      const key = 'test-round-trip-key-abc123';

      // PUT
      const putResult = runGsdTools(
        [
          'research-store', 'put', key,
          '--content', 'hello docs',
          '--source', 'curated',
          '--provider', 'context7',
          '--confidence', 'HIGH',
          '--kind', 'docs',
        ],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(putResult.success, `put failed: ${putResult.error}`);
      const entry = JSON.parse(putResult.output);
      assert.equal(entry.content, 'hello docs', 'put: entry.content mismatch');
      assert.equal(entry.kind, 'docs', 'put: entry.kind mismatch');

      // GET
      const getResult = runGsdTools(
        ['research-store', 'get', key, '--kind', 'docs'],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(getResult.success, `get failed: ${getResult.error}`);
      const got = JSON.parse(getResult.output);
      assert.ok(got.hit === true, `get: expected hit:true, got hit:${got.hit}`);
      assert.ok(got.stale === false, `get: expected stale:false, got stale:${got.stale}`);
      assert.ok(got.entry !== null, 'get: entry should not be null');
      assert.equal(got.entry.content, 'hello docs', 'get: entry.content mismatch');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) research-store get on unknown key -> hit:false, entry:null, exit 0
// ---------------------------------------------------------------------------

describe('research-store: get on unknown key', () => {
  test('returns hit:false, entry:null with exit 0', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['research-store', 'get', 'no-such-key-xyz', '--kind', 'docs'],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(result.success, `expected exit 0 for unknown key; got: ${result.error}`);
      const got = JSON.parse(result.output);
      assert.ok(got.hit === false, `expected hit:false, got hit:${got.hit}`);
      assert.ok(got.entry === null, `expected entry:null, got: ${JSON.stringify(got.entry)}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) research-plan: cache hit — seeded via research-store module directly
// ---------------------------------------------------------------------------

describe('research-plan: cache hit via pre-seeded store', () => {
  test('returns cache.hit:true for pre-seeded question; no fetch property', () => {
    const tmpDir = makeTempDir();
    try {
      // Compute the key the CLI will use for this question
      const researchStore = require('../gsd-core/bin/lib/research-store.cjs');
      const key = researchStore.researchKey({
        ecosystem: 'npm',
        library: '',
        version: '',
        query: 'use zod',
        kind: 'docs',
      });

      // Seed the cache directly, passing homeDir so it writes into tmpDir/.gsd/
      researchStore.putResearch(
        tmpDir,
        key,
        {
          content: 'zod usage documentation',
          source: 'curated',
          provider: 'context7',
          confidence: 'HIGH',
          kind: 'docs',
        },
        { homeDir: tmpDir },
      );

      // Write the --input file
      const inputFile = path.join(tmpDir, 'research-plan-input.json');
      fs.writeFileSync(
        inputFile,
        JSON.stringify({
          ecosystem: 'npm',
          config: {},
          questions: [{ text: 'use zod', kind: 'docs' }],
        }),
      );

      // Run research-plan with HOME overridden so the CLI reads from the same cache
      const result = runGsdTools(
        ['research-plan', '--input', inputFile],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(result.success, `research-plan failed: ${result.error}`);
      const plan = JSON.parse(result.output);
      assert.ok(Array.isArray(plan.items), `expected plan.items array; got: ${JSON.stringify(plan)}`);
      assert.equal(plan.items.length, 1, 'expected exactly one item');
      const item = plan.items[0];
      assert.ok(item.cache && item.cache.hit === true, `expected cache.hit:true, got: ${JSON.stringify(item.cache)}`);
      assert.ok(item.cache.stale === false, `expected stale:false, got: ${JSON.stringify(item.cache)}`);
      assert.ok(!item.fetch, `expected no fetch property for cache hit, got: ${JSON.stringify(item.fetch)}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) research-plan: fetch plan — unseeded question -> item.fetch.provider is string
// ---------------------------------------------------------------------------

describe('research-plan: fetch plan for unseeded question', () => {
  test('returns item with fetch.provider string and no cache hit', () => {
    const tmpDir = makeTempDir();
    try {
      const inputFile = path.join(tmpDir, 'research-plan-input.json');
      fs.writeFileSync(
        inputFile,
        JSON.stringify({
          ecosystem: 'npm',
          config: {},
          questions: [{ text: 'completely unseeded question zxcvbnmasdf', kind: 'docs' }],
        }),
      );

      const result = runGsdTools(
        ['research-plan', '--input', inputFile],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(result.success, `research-plan failed: ${result.error}`);
      const plan = JSON.parse(result.output);
      assert.ok(Array.isArray(plan.items), 'expected plan.items array');
      assert.equal(plan.items.length, 1, 'expected exactly one item');
      const item = plan.items[0];
      assert.ok(item.fetch, 'expected fetch property for unseeded question');
      assert.equal(typeof item.fetch.provider, 'string', `expected fetch.provider to be string, got: ${typeof item.fetch.provider}`);
      assert.ok(item.fetch.provider.length > 0, 'expected non-empty fetch.provider');
      // No cache hit
      assert.ok(!item.cache || item.cache.hit !== true, 'expected no cache hit for unseeded question');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) package-legitimacy check with NO --ecosystem -> usage error, non-zero exit
// ---------------------------------------------------------------------------

describe('package-legitimacy: missing --ecosystem -> usage error', () => {
  test('exits non-zero and reports usage error when --ecosystem is absent', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['package-legitimacy', 'check', 'somepackage'],
        tmpDir,
      );
      assert.ok(!result.success, 'expected non-zero exit when --ecosystem is missing');
      assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

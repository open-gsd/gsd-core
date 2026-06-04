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
      // Must be a valid 64-char sha256 hex string (as produced by researchKey).
      // Using a pre-computed key for 'test-round-trip' to satisfy isValidResearchKey.
      const key = '4642afa8420709e0902413b46e2f26806499a5df710b602c22a5344f0eb298d0';

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
      // Must be a valid 64-char sha256 hex string — but nothing seeded under this key.
      const noSuchKey = '5620aa17b85cb82f1d82633c8cfb4799d3e947f58a1775248c96bbeeeb8f8537';
      const result = runGsdTools(
        ['research-store', 'get', noSuchKey, '--kind', 'docs'],
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
// (e) classify-confidence: context7 provider, no --verified -> HIGH, verified:false
// ---------------------------------------------------------------------------

describe('classify-confidence: context7 without --verified', () => {
  test('returns confidence HIGH and verified false', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['query', 'classify-confidence', '--provider', 'context7'],
        tmpDir,
      );
      assert.ok(result.success, `expected exit 0; got: ${result.error}`);
      const out = JSON.parse(result.output);
      assert.equal(out.confidence, 'HIGH', `expected HIGH, got ${out.confidence}`);
      assert.equal(out.verified, false, `expected verified:false, got ${out.verified}`);
      assert.equal(out.provider, 'context7', `expected provider:context7, got ${out.provider}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (f) classify-confidence: exa provider, no --verified -> LOW
// ---------------------------------------------------------------------------

describe('classify-confidence: exa without --verified', () => {
  test('returns confidence LOW', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['query', 'classify-confidence', '--provider', 'exa'],
        tmpDir,
      );
      assert.ok(result.success, `expected exit 0; got: ${result.error}`);
      const out = JSON.parse(result.output);
      assert.equal(out.confidence, 'LOW', `expected LOW, got ${out.confidence}`);
      assert.equal(out.verified, false, `expected verified:false, got ${out.verified}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (g) classify-confidence: exa with --verified -> MEDIUM
// ---------------------------------------------------------------------------

describe('classify-confidence: exa with --verified', () => {
  test('returns confidence MEDIUM and verified true', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['query', 'classify-confidence', '--provider', 'exa', '--verified'],
        tmpDir,
      );
      assert.ok(result.success, `expected exit 0; got: ${result.error}`);
      const out = JSON.parse(result.output);
      assert.equal(out.confidence, 'MEDIUM', `expected MEDIUM, got ${out.confidence}`);
      assert.equal(out.verified, true, `expected verified:true, got ${out.verified}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// (h) classify-confidence: missing --provider -> usage error, non-zero exit
// ---------------------------------------------------------------------------

describe('classify-confidence: missing --provider -> usage error', () => {
  test('exits non-zero and reports usage error when --provider is absent', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['query', 'classify-confidence'],
        tmpDir,
      );
      assert.ok(!result.success, 'expected non-zero exit when --provider is missing');
      assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);
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

// ---------------------------------------------------------------------------
// FINDING 1 REGRESSION (CLI): research-store put/get must reject non-64-hex keys
// ---------------------------------------------------------------------------

describe('research-store CLI: traversal/invalid key rejected with usage error', () => {
  test('put ../../x --content ... → non-zero exit (usage error)', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        [
          'research-store', 'put', '../../x',
          '--content', 'evil',
          '--source', 'web',
          '--provider', 'p',
          '--confidence', 'HIGH',
          '--kind', 'docs',
        ],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(!result.success, `expected non-zero exit for traversal key; got: ${result.output}`);
      assert.ok(result.exitCode !== 0, `expected non-zero exit code, got ${result.exitCode}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('get ../../etc/passwd → non-zero exit (usage error)', () => {
    const tmpDir = makeTempDir();
    try {
      const result = runGsdTools(
        ['research-store', 'get', '../../etc/passwd'],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(!result.success, `expected non-zero exit for traversal key; got: ${result.output}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('put with valid 64-hex key → success', () => {
    const tmpDir = makeTempDir();
    try {
      const researchStore = require('../gsd-core/bin/lib/research-store.cjs');
      const validKey = researchStore.researchKey({ ecosystem: 'npm', library: 'lodash', version: '4.0.0', query: 'chunk', kind: 'docs' });
      const result = runGsdTools(
        [
          'research-store', 'put', validKey,
          '--content', 'test content',
          '--source', 'web',
          '--provider', 'p',
          '--confidence', 'HIGH',
          '--kind', 'docs',
        ],
        tmpDir,
        { HOME: tmpDir },
      );
      assert.ok(result.success, `put with valid 64-hex key should succeed; got: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

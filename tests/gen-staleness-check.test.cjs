'use strict';

/**
 * Regression tests for the requireFreshDist() staleness guard in gen-*.mjs scripts.
 *
 * For each generator, verifies:
 *   1. Exits 1 when sdk/dist file does not exist — error includes "does not exist"
 *      and the `npm run build:sdk` hint.
 *   2. Exits 1 when TS source is newer than sdk/dist — error includes
 *      "is stale relative to", both mtime timestamps, the TS path, and build hint.
 *   3. Exits 0 when sdk/dist is newer than TS source (fresh build).
 *      Skipped per-generator if dist doesn't exist (expected before first build:sdk).
 *
 * Uses child_process.spawnSync to exercise the real gen-*.mjs entry path.
 *
 * Isolation: each subtest creates its own temp directory rooted at a unique
 * path and passes GSD_REPO_ROOT to the generator subprocess so requireFreshDist()
 * operates on temp fixtures instead of the real sdk/dist tree. This prevents
 * parallel test execution from seeing stale/missing dist files in the live tree.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'sdk', 'scripts');

// Map of generator script → { dist, ts } repo-relative paths
const GENERATORS = [
  {
    script: 'gen-plan-scan.mjs',
    dist: 'sdk/dist/query/plan-scan.js',
    ts: 'sdk/src/query/plan-scan.ts',
  },
  {
    script: 'gen-secrets.mjs',
    dist: 'sdk/dist/query/secrets.js',
    ts: 'sdk/src/query/secrets.ts',
  },
  {
    script: 'gen-schema-detect.mjs',
    dist: 'sdk/dist/query/schema-detect.js',
    ts: 'sdk/src/query/schema-detect.ts',
  },
  {
    script: 'gen-decisions.mjs',
    dist: 'sdk/dist/query/decisions.js',
    ts: 'sdk/src/query/decisions.ts',
  },
  {
    script: 'gen-project-root.mjs',
    dist: 'sdk/dist/runtime/project-root.js',
    ts: 'sdk/src/runtime/project-root.ts',
  },
  {
    script: 'gen-workstream-inventory-builder.mjs',
    dist: 'sdk/dist/workstream/builder.js',
    ts: 'sdk/src/workstream/builder.ts',
  },
  {
    script: 'gen-workstream-name-policy.mjs',
    dist: 'sdk/dist/workstream-name-policy.js',
    ts: 'sdk/src/workstream-name-policy.ts',
  },
  {
    script: 'gen-validate.mjs',
    dist: 'sdk/dist/query/validate.js',
    ts: 'sdk/src/query/validate.ts',
  },
  {
    script: 'gen-configuration.mjs',
    dist: 'sdk/dist/config/index.js',
    ts: 'sdk/src/config/index.ts',
  },
];

/**
 * Run a gen script via spawnSync with an optional GSD_REPO_ROOT override.
 * Returns { status, stderr, stdout }.
 */
function runGen(scriptName, env = {}) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Create a minimal temp directory tree that mirrors the repo layout for
 * the given dist and ts paths. Returns { tmpRoot, distAbs, tsAbs, cleanup }.
 *
 * The real TS source is copied into the temp tree so its content is valid,
 * but the caller controls whether the dist file exists and what its mtime is.
 */
function makeTempTree(dist, ts) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-staleness-'));
  const distAbs = path.join(tmpRoot, dist);
  const tsAbs = path.join(tmpRoot, ts);

  // Always create the TS source (copy from real tree so content is valid)
  fs.mkdirSync(path.dirname(tsAbs), { recursive: true });
  const realTsAbs = path.join(REPO_ROOT, ts);
  fs.copyFileSync(realTsAbs, tsAbs);

  function cleanup() {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { tmpRoot, distAbs, tsAbs, cleanup };
}

// One describe block per generator — each block is { concurrency: false } so
// its three subtests run in order and don't race on the same files.
for (const { script, dist, ts } of GENERATORS) {
  describe(`gen staleness guard — ${script}`, { concurrency: false }, () => {
    // ── Subtest A: dist file is missing ──────────────────────────────────────
    test('exits 1 with "does not exist" when dist file is absent', () => {
      const { tmpRoot, cleanup } = makeTempTree(dist, ts);
      // dist is NOT created — the temp tree has only the TS source
      try {
        const { status, stderr } = runGen(script, { GSD_REPO_ROOT: tmpRoot });
        assert.strictEqual(status, 1, `Expected exit 1, got ${status}. stderr: ${stderr}`);
        assert.match(stderr, /does not exist/, `Expected "does not exist". Got: ${stderr}`);
        assert.match(stderr, /npm run build/, `Expected build hint. Got: ${stderr}`);
        // Error message should name the dist path (repo-relative)
        assert.ok(stderr.includes(dist), `Expected dist path in message. Got: ${stderr}`);
      } finally {
        cleanup();
      }
    });

    // ── Subtest B: TS source newer than dist ─────────────────────────────────
    test('exits 1 with stale-dist error when TS source is newer than dist', () => {
      const { tmpRoot, distAbs, tsAbs, cleanup } = makeTempTree(dist, ts);

      // Create a fake dist file
      fs.mkdirSync(path.dirname(distAbs), { recursive: true });
      fs.writeFileSync(distAbs, '// fake dist for staleness test\n', 'utf-8');

      // Set dist mtime 2s in the past, ts mtime to now → ts is newer
      const past = new Date(Date.now() - 2000);
      const now = new Date();
      fs.utimesSync(distAbs, past, past);
      fs.utimesSync(tsAbs, now, now);

      try {
        const { status, stderr } = runGen(script, { GSD_REPO_ROOT: tmpRoot });
        assert.strictEqual(status, 1, `Expected exit 1 for stale dist, got ${status}. stderr: ${stderr}`);
        assert.match(stderr, /is stale relative to/, `Expected "is stale relative to". Got: ${stderr}`);
        assert.match(stderr, /npm run build/, `Expected build hint. Got: ${stderr}`);
        // Error must name the TS source path
        assert.ok(stderr.includes(ts), `Expected TS path "${ts}" in message. Got: ${stderr}`);
        // Error must include both mtime timestamps in ISO format
        assert.match(stderr, /dist mtime \d{4}-\d{2}-\d{2}T/, `Expected dist mtime in message. Got: ${stderr}`);
        assert.match(stderr, /ts mtime \d{4}-\d{2}-\d{2}T/, `Expected ts mtime in message. Got: ${stderr}`);
      } finally {
        cleanup();
      }
    });

    // ── Subtest C: dist is fresh → exits 0 ───────────────────────────────────
    // This subtest requires a real built dist (the generator reads and transforms
    // its content), so it uses the actual sdk/dist tree rather than the temp dir.
    // It only mutates the real TS source mtime, not the dist file, so it is safe
    // to run in parallel: another parallel test process reading sdk/dist will not
    // be affected by a TS source mtime change.
    test('exits 0 when dist is newer than TS source', { skip: !fs.existsSync(path.join(REPO_ROOT, dist)) ? `${dist} not built` : false }, () => {
      const distAbs = path.join(REPO_ROOT, dist);
      const tsAbs = path.join(REPO_ROOT, ts);

      const distStat = fs.statSync(distAbs);
      const origTsStat = fs.statSync(tsAbs);

      // Set ts mtime to 2s before dist mtime so dist is definitely newer
      const tsOlderThanDist = new Date(distStat.mtimeMs - 2000);
      fs.utimesSync(tsAbs, tsOlderThanDist, tsOlderThanDist);

      try {
        const { status, stderr, stdout } = runGen(script);
        assert.strictEqual(
          status,
          0,
          `Expected exit 0 for fresh dist, got ${status}. stderr: ${stderr}\nstdout: ${stdout}`,
        );
      } finally {
        fs.utimesSync(tsAbs, origTsStat.atime, origTsStat.mtime);
      }
    });
  });
}

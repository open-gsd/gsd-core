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
 * Isolation: each describe block serializes its own subtests (concurrency: false)
 * and fully restores all file mtimes in finally{} so the blocks don't race.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    dist: 'sdk/dist/project-root/index.js',
    ts: 'sdk/src/project-root/index.ts',
  },
  {
    script: 'gen-workstream-inventory-builder.mjs',
    dist: 'sdk/dist/workstream-inventory/builder.js',
    ts: 'sdk/src/workstream-inventory/builder.ts',
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
    dist: 'sdk/dist/configuration/index.js',
    ts: 'sdk/src/configuration/index.ts',
  },
];

/**
 * Run a gen script via spawnSync. Returns { status, stderr, stdout }.
 */
function runGen(scriptName) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// One describe block per generator — each block is { concurrency: false } so
// its three subtests run in order and don't race on the same files.
for (const { script, dist, ts } of GENERATORS) {
  describe(`gen staleness guard — ${script}`, { concurrency: false }, () => {
    // ── Subtest A: dist file is missing ──────────────────────────────────────
    test('exits 1 with "does not exist" when dist file is absent', () => {
      const distAbs = path.join(REPO_ROOT, dist);
      const distExists = fs.existsSync(distAbs);
      const tempPath = distAbs + '.bak_missing';

      if (distExists) {
        fs.renameSync(distAbs, tempPath);
      }
      try {
        const { status, stderr } = runGen(script);
        assert.strictEqual(status, 1, `Expected exit 1, got ${status}. stderr: ${stderr}`);
        assert.match(stderr, /does not exist/, `Expected "does not exist". Got: ${stderr}`);
        assert.match(stderr, /npm run build/, `Expected build hint. Got: ${stderr}`);
        // Error message should name the dist path
        assert.ok(stderr.includes(dist), `Expected dist path in message. Got: ${stderr}`);
      } finally {
        if (distExists && fs.existsSync(tempPath)) {
          fs.renameSync(tempPath, distAbs);
        }
      }
    });

    // ── Subtest B: TS source newer than dist ─────────────────────────────────
    test('exits 1 with stale-dist error when TS source is newer than dist', () => {
      const distAbs = path.join(REPO_ROOT, dist);
      const tsAbs = path.join(REPO_ROOT, ts);

      const distCreatedForTest = !fs.existsSync(distAbs);
      if (distCreatedForTest) {
        fs.mkdirSync(path.dirname(distAbs), { recursive: true });
        fs.writeFileSync(distAbs, '// fake dist for staleness test\n', 'utf-8');
      }

      const origDistStat = fs.statSync(distAbs);
      const origTsStat = fs.statSync(tsAbs);

      // Set dist mtime 2s in the past, ts mtime to now → ts is newer
      const past = new Date(Date.now() - 2000);
      const now = new Date();
      fs.utimesSync(distAbs, past, past);
      fs.utimesSync(tsAbs, now, now);

      try {
        const { status, stderr } = runGen(script);
        assert.strictEqual(status, 1, `Expected exit 1 for stale dist, got ${status}. stderr: ${stderr}`);
        assert.match(stderr, /is stale relative to/, `Expected "is stale relative to". Got: ${stderr}`);
        assert.match(stderr, /npm run build/, `Expected build hint. Got: ${stderr}`);
        // Error must name the TS source path
        assert.ok(stderr.includes(ts), `Expected TS path "${ts}" in message. Got: ${stderr}`);
        // Error must include both mtime timestamps in ISO format
        assert.match(stderr, /dist mtime \d{4}-\d{2}-\d{2}T/, `Expected dist mtime in message. Got: ${stderr}`);
        assert.match(stderr, /ts mtime \d{4}-\d{2}-\d{2}T/, `Expected ts mtime in message. Got: ${stderr}`);
      } finally {
        // Restore original mtimes
        fs.utimesSync(distAbs, origDistStat.atime, origDistStat.mtime);
        fs.utimesSync(tsAbs, origTsStat.atime, origTsStat.mtime);
        if (distCreatedForTest) {
          try { fs.unlinkSync(distAbs); } catch (_) { /* ignore */ }
        }
      }
    });

    // ── Subtest C: dist is fresh → exits 0 ───────────────────────────────────
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

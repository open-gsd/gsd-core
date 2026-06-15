'use strict';

/**
 * Regression test for #315 — perf: repeated subrepo detection in loadConfig.
 *
 * Before the fix, loadConfig called detectSubRepos(cwd) up to 3 times per
 * invocation (all with the same cwd):
 *   Site 1 (~line 305): root-config requiresFilesystem migration (workstream path)
 *   Site 2 (~line 353): workstream-config requiresFilesystem migration
 *   Site 3 (~line 367): planning.sub_repos filesystem re-sync
 *
 * After the fix, a per-call lazy memo ensures detectSubRepos(cwd) is called
 * EXACTLY once regardless of how many sites trigger.
 *
 * Fixture triggers:
 *   - options.workstream set → loads root config (site 1 candidate)
 *   - root config has `multiRepo: true` → requiresFilesystem → site 1 fires
 *   - workstream config has `planning.sub_repos: [...]` → site 3 fires
 *   - workstream config also has `multiRepo: true` → requiresFilesystem → site 2 fires
 *   Combined: 3 distinct call sites attempted; memo should collapse to 1 scan.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

// Import loadConfig directly (sync, no CLI subprocess needed)
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function createProjectWithSubRepo(prefix = 'gsd-315-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  // Create a child dir that looks like a subrepo
  const subRepoDir = path.join(tmpDir, 'sub-service');
  fs.mkdirSync(path.join(subRepoDir, '.git'), { recursive: true });

  // Create .planning root layout
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });

  return tmpDir;
}

function writeRootConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function writeWorkstreamConfig(tmpDir, wsName, obj) {
  const wsDir = path.join(tmpDir, '.planning', 'workstreams', wsName, 'phases');
  fs.mkdirSync(wsDir, { recursive: true });
  const configPath = path.join(tmpDir, '.planning', 'workstreams', wsName, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

// ─── test ─────────────────────────────────────────────────────────────────────

describe('perf-315 — loadConfig calls detectSubRepos at most once per invocation', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      cleanup(tmpDir);
      tmpDir = null;
    }
  });

  test('detectSubRepos scan count is exactly 1 regardless of how many sites trigger', () => {
    tmpDir = createProjectWithSubRepo();

    const wsName = 'test-ws';

    // Root config: multiRepo: true triggers requiresFilesystem at site 1
    writeRootConfig(tmpDir, { multiRepo: true, model_profile: 'balanced' });

    // Workstream config:
    //   - planning.sub_repos set  → triggers site 3 (fs-resync)
    //   - multiRepo: true         → triggers site 2 (requiresFilesystem normalization)
    writeWorkstreamConfig(tmpDir, wsName, {
      multiRepo: true,
      planning: { sub_repos: ['sub-service'] },
      model_profile: 'balanced',
    });

    // Spy on fs.readdirSync — count only calls that match detectSubRepos' signature
    // (first arg === tmpDir, options object containing withFileTypes: true)
    let scanCount = 0;
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function spyReaddirSync(dirPath, opts) {
      if (dirPath === tmpDir && opts && opts.withFileTypes === true) {
        scanCount += 1;
      }
      return originalReaddirSync.call(this, dirPath, opts);
    };

    try {
      // Load config with workstream option so all three sites can be reached
      const config = loadConfig(tmpDir, { workstream: wsName });

      // Behavior lock: sub_repos is correctly resolved
      assert.ok(
        Array.isArray(config.sub_repos) || Array.isArray(config.planning?.sub_repos),
        'sub_repos should be an array in the returned config'
      );

      // Performance assertion: only one scan regardless of how many sites triggered
      assert.strictEqual(
        scanCount, 1,
        `Expected detectSubRepos to scan cwd exactly once, but fs.readdirSync was called ${scanCount} time(s) with the cwd + {withFileTypes:true} signature`
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });
});

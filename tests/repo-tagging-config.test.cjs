'use strict';

/**
 * git.repo_tagging config key and the `init complete-milestone` exposure
 * (#5706, phase 2 of epic #3628; design rows 1-5 and test-matrix rows 1-5, 21).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

const ROOT = path.join(__dirname, '..');

function configPath(dir) {
  return path.join(dir, '.planning', 'config.json');
}

function writeConfig(dir, value) {
  fs.writeFileSync(configPath(dir), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
}

function run(dir, args) {
  return runGsdTools(args, dir, homeSandboxEnv(dir));
}

function initCompleteMilestone(dir) {
  const result = run(dir, ['init', 'complete-milestone']);
  assert.ok(result.success, `init complete-milestone failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('git.repo_tagging config key', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('defaults to single (row 1)', () => {
    writeConfig(tmpDir, {});
    assert.equal(loadConfig(tmpDir).repo_tagging, 'single');
    const got = run(tmpDir, ['config-get', 'git.repo_tagging']);
    assert.ok(got.success, got.error);
    assert.equal(JSON.parse(got.output), 'single');
  });

  test('git.create_tag semantics are unchanged by the new key (row 1)', () => {
    for (const [config, expected] of [
      [{}, true],
      [{ git: { create_tag: true } }, true],
      [{ git: { create_tag: false } }, false],
      [{ git: { create_tag: false, repo_tagging: 'per_repo' } }, false],
      [{ git: { create_tag: true, repo_tagging: 'per_repo' } }, true],
    ]) {
      writeConfig(tmpDir, config);
      assert.equal(initCompleteMilestone(tmpDir).git_create_tag, expected, JSON.stringify(config));
    }
  });

  test('accepts per_repo and exposes it through loadConfig and init (row 2)', () => {
    writeConfig(tmpDir, {});
    const set = run(tmpDir, ['config-set', 'git.repo_tagging', 'per_repo']);
    assert.ok(set.success, set.error);
    assert.equal(readConfig(tmpDir).git.repo_tagging, 'per_repo');
    assert.equal(loadConfig(tmpDir).repo_tagging, 'per_repo');
    assert.equal(initCompleteMilestone(tmpDir).repo_tagging, 'per_repo');
    const back = run(tmpDir, ['config-set', 'git.repo_tagging', 'single']);
    assert.ok(back.success, back.error);
    assert.equal(readConfig(tmpDir).git.repo_tagging, 'single');
  });

  test('rejects invalid values and leaves the file untouched (row 3)', () => {
    writeConfig(tmpDir, { git: { create_tag: true } });
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    for (const bad of ['bogus', '', 'true', 'PER_REPO', 'per-repo', '7']) {
      const result = run(tmpDir, ['config-set', 'git.repo_tagging', bad]);
      assert.equal(result.success, false, `'${bad}' must be rejected`);
      assert.match(result.error, /single/, `'${bad}' error names the allowed values`);
      assert.match(result.error, /per_repo/, `'${bad}' error names the allowed values`);
      assert.equal(fs.readFileSync(configPath(tmpDir), 'utf8'), before, `'${bad}' must not be written`);
    }
  });

  test('hand edits are tolerated: valid survives, invalid reads as single, nothing throws (row 4)', () => {
    const cases = [
      [{ git: { repo_tagging: 'per_repo' } }, 'per_repo'],
      [{ git: { repo_tagging: 'single' } }, 'single'],
      [{ git: { repo_tagging: 7 } }, 'single'],
      [{ git: { repo_tagging: null } }, 'single'],
      [{ git: { repo_tagging: 'bogus' } }, 'single'],
      [{ git: { repo_tagging: ['per_repo'] } }, 'single'],
      [{ git: { repo_tagging: 'PER_REPO' } }, 'single'],
    ];
    for (const [config, expected] of cases) {
      writeConfig(tmpDir, config);
      assert.equal(loadConfig(tmpDir).repo_tagging, expected, JSON.stringify(config));
      assert.equal(initCompleteMilestone(tmpDir).repo_tagging, expected, JSON.stringify(config));
    }
  });
});

describe('init complete-milestone exposure (row 5)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('exposes sub_repos (empty by default) and repo_tagging next to git_create_tag', () => {
    writeConfig(tmpDir, {});
    const init = initCompleteMilestone(tmpDir);
    assert.equal(init.git_create_tag, true);
    assert.deepEqual(init.sub_repos, []);
    assert.equal(init.repo_tagging, 'single');
  });

  test('exposes the configured sub_repos', () => {
    writeConfig(tmpDir, { planning: { sub_repos: ['api', 'web'] }, git: { repo_tagging: 'per_repo' } });
    const init = initCompleteMilestone(tmpDir);
    assert.deepEqual(init.sub_repos, ['api', 'web']);
    assert.equal(init.repo_tagging, 'per_repo');
  });

  test('existing keys keep their order and the pre-change set is intact', () => {
    writeConfig(tmpDir, {});
    const keys = Object.keys(initCompleteMilestone(tmpDir));
    const existing = ['git_create_tag', 'state_path', 'roadmap_path', 'archive_dir', 'milestones_path', 'project_path', 'requirements_path', 'section_manifest', 'project_root'];
    assert.deepEqual(keys.filter((k) => existing.includes(k)), existing);
    assert.ok(keys.includes('sub_repos') && keys.includes('repo_tagging'));
  });
});

describe('key registered everywhere git.create_tag is (row 21)', () => {
  const readJson = (...segments) => JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), 'utf8'));

  test('schema manifest, defaults manifest and template agree on the key and default', () => {
    const schema = readJson('gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
    const keyLists = Object.values(schema).filter(Array.isArray);
    assert.ok(keyLists.some((list) => list.includes('git.create_tag') && list.includes('git.repo_tagging')),
      'git.repo_tagging must sit beside git.create_tag in the schema manifest key list');
    assert.equal(readJson('gsd-core', 'bin', 'shared', 'config-defaults.manifest.json').git.repo_tagging, 'single');
    assert.equal(readJson('gsd-core', 'templates', 'config.json').git.repo_tagging, 'single');
  });

  test('a freshly ensured project config carries the default', () => {
    const dir = createTempProject();
    try {
      const ensured = run(dir, ['config-ensure-section']);
      assert.ok(ensured.success, ensured.error);
      assert.equal(readConfig(dir).git.repo_tagging, 'single');
    } finally {
      cleanup(dir);
    }
  });

  test('config-set accepts both enum members on an empty config', () => {
    const dir = createTempProject();
    try {
      writeConfig(dir, {});
      for (const value of ['single', 'per_repo']) {
        assert.ok(run(dir, ['config-set', 'git.repo_tagging', value]).success, value);
      }
    } finally {
      cleanup(dir);
    }
  });
});

'use strict';

// allow-test-rule: source-text-is-the-product #2504
// The YAML structure of the auto-backmerge and release finalize invariants is the `release-backmerge-invariants`
// text contract (scripts/static-checks/text-contracts/release-backmerge-invariants.cjs, run by lint:ci). These two
// cases stay a test because their subject is the shell semantics of the step's embedded guard: each runs the
// guard's `run` text in bash and asserts its exit status and the annotation it prints.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// The step's `run` text up to (not including) the first line matching `stopRe`.
function runPrefix(run, stopRe) {
  const lines = run.split('\n');
  const idx = lines.findIndex((l) => stopRe.test(l));
  assert.notEqual(idx, -1, `no line matching ${stopRe} in the step's run`);
  return lines.slice(0, idx).join('\n') + '\n';
}

function runGuard(guard, token, extraEnv) {
  return spawnSync('bash', ['-c', guard], {
    env: { ...process.env, HAS_ADMIN_TOKEN: token, ...extraEnv },
    encoding: 'utf8',
    timeout: QUICK_SPAWN_TIMEOUT_MS,
  });
}

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

// Locate a step by a substring of its `name`.
function findStep(steps, nameSubstring) {
  return steps.find((s) => typeof s.name === 'string' && s.name.includes(nameSubstring));
}

describe('release backmerge guards (#5894) — the embedded shell, run in bash', () => {
  test('the back-merge guard exits 1 with ::error:: without the token and 0 with it', { skip: process.platform === 'win32' }, () => {
    const step = findStep(loadWorkflow('auto-backmerge.yml').jobs.backmerge.steps, 'Merge the back-merge PR as a merge commit');
    assert.ok(step);
    // Stop at the line that RUNS the script, not the echo that mentions it.
    const guard = runPrefix(step.run, /^\s*node scripts\/merge-commit-pr\.cjs\b/);
    const without = runGuard(guard, 'false', { PR: '77' });
    assert.equal(without.status, 1);
    assert.ok(without.stdout.includes('::error::'));
    const withToken = runGuard(guard, 'true', { PR: '77' });
    assert.equal(withToken.status, 0);
  });

  test('the auto-merge guard warns and exits 0 without the token, and stays silent with it', { skip: process.platform === 'win32' }, () => {
    const automerge = findStep(loadWorkflow('release.yml').jobs.finalize.steps, 'Auto-merge the release');
    assert.ok(automerge);
    const guard = runPrefix(automerge.run, /^\s*PR=\$\(gh pr list/);
    const without = runGuard(guard, 'false', {});
    assert.equal(without.status, 0);
    assert.ok(without.stdout.includes('::warning::'));
    const withToken = runGuard(guard, 'true', {});
    assert.equal(withToken.status, 0);
    assert.ok(!withToken.stdout.includes('GSD_BOT_PR_TOKEN is not set'));
  });
});

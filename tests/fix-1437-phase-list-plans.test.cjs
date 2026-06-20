'use strict';

/**
 * Regression tests for `gsd-tools query phase.list-plans <N>` (#1437).
 *
 * Prior to this fix, `phase.list-plans` was not registered in the
 * phase-command-router, so any invocation produced:
 *   "Error: Unknown phase subcommand. Available: uat-passed, next-decimal, ..."
 *
 * These tests exercise the full dispatch path:
 *   gsd-tools → phase-command-router → phase.cmdPhaseListPlans
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function setupProject(phaseSlug = '01-feature') {
  const tmpDir = createTempProject();
  // Minimal ROADMAP so findPhaseInternal can resolve the phase directory
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Feature',
      '',
      '### Phase 1: Feature',
      '**Goal:** Build feature',
      '**Plans:** 1 plans',
      '',
    ].join('\n'),
  );
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  return { tmpDir, phaseDir };
}

function touch(dir, ...files) {
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), '');
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let tmpDir;
let phaseDir;

beforeEach(() => {
  const proj = setupProject('01-feature');
  tmpDir = proj.tmpDir;
  phaseDir = proj.phaseDir;
});

afterEach(() => {
  cleanup(tmpDir);
});

describe('bug-1437 — phase.list-plans is wired in gsd-tools', () => {
  test('command no longer returns Unknown phase subcommand error', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1'], tmpDir);
    // Previously this would fail with "Unknown phase subcommand"
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    assert.ok(!result.error || !result.error.includes('Unknown phase subcommand'),
      `got unexpected error: ${result.error}`);
  });

  test('returns JSON with plan_count and plans array when plans exist', () => {
    touch(phaseDir, '01-01-PLAN.md', '01-02-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 2, 'plan_count should be 2');
    assert.equal(data.has_plans, true, 'has_plans should be true');
    assert.ok(Array.isArray(data.plans), 'plans should be an array');
    assert.equal(data.plans.length, 2, 'plans array should have 2 entries');
  });

  test('returns plan_count 0 and empty plans array when phase has no plan files', () => {
    // Phase directory exists but has no *-PLAN.md files
    touch(phaseDir, 'CONTEXT.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 0);
    assert.equal(data.has_plans, false);
    assert.deepEqual(data.plans, []);
  });

  test('returns has_plans false when phase number is not found', () => {
    // Phase 99 does not exist in the fixture
    const result = runGsdTools(['query', 'phase.list-plans', '99', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.has_plans, false);
    assert.equal(data.plan_count, 0);
  });

  test('plan paths are relative to project root and posix-style', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['query', 'phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plans.length, 1);
    // Paths must be forward-slash separated (posix) and relative (not absolute)
    const planPath = data.plans[0];
    assert.ok(!path.isAbsolute(planPath), `expected relative path, got: ${planPath}`);
    assert.ok(!planPath.includes('\\'), `expected posix path, got: ${planPath}`);
    assert.ok(planPath.includes('01-01-PLAN.md'), `expected plan filename in path: ${planPath}`);
  });

  test('dotted form phase.list-plans (without query prefix) also works', () => {
    touch(phaseDir, '01-01-PLAN.md');
    const result = runGsdTools(['phase.list-plans', '1', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);
    const data = JSON.parse(result.output);
    assert.equal(data.plan_count, 1);
  });
});

// docs-guard-exempt: docs/TESTING-SUITES.md is cited only in a placement-note comment; never read.
'use strict';

/**
 * GSD Tools Tests - Milestone Archive Layout and Phase Filter
 *
 * Covers:
 *   - bug #2684: milestone.complete forwards version to phases.archive
 *   - bug #2787: extractCurrentMilestone fenced code block boundary
 *   - bug #3164: validate consistency/health/find-phase with milestone-archive layout
 *   - bug #3600: getMilestonePhaseFilter with project-code-prefixed directories
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, createTempDir, cleanup, runGsdTools, toPosixPath, TOOLS_PATH } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { GATE_ROADMAP, writeGateCap, cleanEnv } = require('./helpers/ship-gate-fixture.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { openWorkStepFields } = require('./helpers/audit-milestone-step.cjs');
const { seedWorkstream } = require('./fixtures/index.cjs');
const { findTableBySchema } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { buildQuickArchiveIndex } = require('../gsd-core/bin/lib/milestone.cjs');

function runSdkQuery(args, cwd) {
  const result = runGsdTools(args, cwd);
  if (!result.success) return { success: false, error: result.error };
  try {
    return { success: true, data: JSON.parse(result.output || '{}') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bug #2684: milestone.complete forwards version to phases.archive
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2684: milestone.complete forwards version to phases.archive', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('milestone.complete v1.0 does not throw version required error', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete should succeed, got error: ${result.error}`);
    assert.ok(
      !result.error || !result.error.includes('version required'),
      `should not throw "version required" — got: ${result.error}`,
    );
  });

  test('milestone.complete returns version in response data', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    // #2946: the unstarted-phase guard now runs whenever --force is absent
    // (independent of STATE.md). This test exercises version-forwarding, not
    // the guard, so give Phase 1 a real directory so the scan is satisfied.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v2.5', '--confirm'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.data.version, 'v2.5');
  });

  test('milestone.complete with --archive-phases forwards version correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-phases', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete --archive-phases failed: ${result.error}`);
    assert.strictEqual(result.data.version, 'v1.0');
    assert.ok(result.data.archived.phases === true, 'phases should be archived');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases')));
  });

  test('phases.archive is no longer a direct public subcommand', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['phases.archive', 'v1.0'], tmpDir);
    assert.equal(result.success, false, 'phases.archive should not be callable directly');
    assert.match(result.error || '', /Unknown phases subcommand/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #2787: extractCurrentMilestone — fenced code block boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCurrentMilestone — fenced code block boundary (#2787)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('roadmap analyze returns all phases when a fenced block contains a heading-like line matching the milestone-end pattern', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## ✅ v1.0: Foundation',
      '',
      '<details>',
      '<summary>✅ v1.0 Foundation — SHIPPED</summary>',
      '',
      '### Phase 1: Bootstrap',
      '**Goal:** Bootstrap the project',
      '',
      '</details>',
      '',
      '## Roadmap v1.1: New Work',
      '',
      '### Phase 1: Setup',
      '**Goal:** Set up the environment',
      '',
      '### Phase 2: Core Logic',
      '**Goal:** Implement core logic',
      '',
      'Deployment notes:',
      '',
      '```bash',
      '# Ops runbook — v1.0 compat',
      'echo "deploy complete"',
      '```',
      '',
      '### Phase 3: Testing',
      '**Goal:** Write regression tests',
      '',
      '### Phase 4: Deploy',
      '**Goal:** Ship to production',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.1\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze should succeed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_count, 4, 'All 4 phases in v1.1 should be found');
  });

  test('roadmap analyze returns all phases when a fenced block contains a backtick-tilde fence with milestone-like heading', () => {
    const roadmap = [
      '## Roadmap v2.0: Feature Work',
      '',
      '### Phase 1: Alpha',
      '**Goal:** Alpha release',
      '',
      '~~~markdown',
      '## Prior art (v1.9 snapshot)',
      '~~~',
      '',
      '### Phase 2: Beta',
      '**Goal:** Beta release',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v2.0\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze should succeed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_count, 2, 'Both phases in v2.0 should be found');
  });

  test('fenced block with info string (e.g. ```js) is not closed by a nested info-string line', () => {
    const roadmap = [
      '## Roadmap v3.0: Info-String Edge Case',
      '',
      '### Phase 1: Setup',
      '**Goal:** First phase',
      '',
      '```text',
      '```js',
      '# This heading-like line (v3.0 compat) must NOT end the milestone',
      '```',
      '',
      '### Phase 2: Core',
      '**Goal:** Second phase',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v3.0\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).phase_count, 2, 'Both phases should be found; ```js line must not close fence');
  });

  test('roadmap get-phase finds a phase defined after a fenced code block', () => {
    const roadmap = [
      '## Roadmap v1.1: New Work',
      '',
      '### Phase 1: Setup',
      '**Goal:** Bootstrap',
      '',
      '```bash',
      '# Runbook for v1.0 deploy',
      '```',
      '',
      '### Phase 2: Core',
      '**Goal:** Core implementation',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.1\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap get-phase 2', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.ok(output.found, 'Phase 2 should be found even after a fenced code block');
    assert.strictEqual(output.phase_number, '2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #3164: milestone-archive layout support in validate/find-phase
// ─────────────────────────────────────────────────────────────────────────────

function setupMilestoneArchiveProject(tmpDir, options = {}) {
  const {
    milestone = 'v1.7',
    phases = ['64-secondary-grader-fix'],
    roadmapPhases = ['64'],
  } = options;

  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-fixture setup: removing subdirectory (not temp root teardown)
  fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

  const archiveDir = path.join(tmpDir, '.planning', 'milestones', `${milestone}-phases`);
  for (const phase of phases) {
    const phaseDir = path.join(archiveDir, phase);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), `# Plan\nPhase ${phase}\n`);
  }

  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `milestone: ${milestone}\n# Session State\n\nPhase: ${roadmapPhases[0]}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n## Core Value\nTest.\n## Requirements\nTest.\n',
  );
  const phaseLines = roadmapPhases.map(n => `### Phase ${n}: Description\n\nGoal: implement it.\n`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n## Roadmap ${milestone}: Current\n\n${phaseLines}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2),
  );
}

describe('#3164 — validate consistency: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no W006 warnings for phases that exist in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('Phase 64') && w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Got spurious W006: ${JSON.stringify(w006)}`);
  });

  test('no W006 when multiple phases exist in milestone-archive layout', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['48-feature-a', '51-feature-b', '64-feature-c'], roadmapPhases: ['48', '51', '64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Got spurious W006: ${JSON.stringify(w006)}`);
  });

  test('prefixed archive dir names (CK-64-...) are recognized as phase 64', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['CK-64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('Phase 64') && w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Prefixed phase dir should count as phase 64`);
  });

  test('consistency scans only active milestone archive and still validates plans/frontmatter', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test setup: removing subdirectory to establish milestone-archive layout
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const oldDir = path.join(tmpDir, '.planning', 'milestones', 'v1.6-phases', '64-legacy');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, '64-01-PLAN.md'), '# legacy plan\n');

    const activeDir = path.join(tmpDir, '.planning', 'milestones', 'v1.7-phases', '65-current');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '65-01-PLAN.md'), '# plan 1\n');
    fs.writeFileSync(path.join(activeDir, '65-03-PLAN.md'), '# plan 3\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n**Milestone:** v1.7 Current Milestone\nPhase: 65\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Roadmap v1.7: Current\n\n### Phase 65: Current work\n\nGoal: test.\n',
    );

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const out = JSON.parse(result.output);
    const warnings = out.warnings || [];
    const warningsPosix = warnings.map(w => toPosixPath(w.message));

    const phase64Warnings = warningsPosix.filter(w => w.includes('Phase 64 exists on disk but not in ROADMAP.md'));
    assert.deepStrictEqual(phase64Warnings, [], 'Old archived milestone phase 64 should not be treated as active');
    // Phase 12 (#3310) migration note: `validate consistency`'s C002
    // (plan-numbering-gap)/C004 (missing-wave) rules now read
    // `PlanningSnapshot`'s `perPhasePlanNumbering`/`perPhaseWaveMissingPlans`
    // fields, which enumerate ONLY the flat `.planning/phases/` root — a
    // disclosed, accepted scope reduction from the pre-migration inline scan
    // (which also walked the active milestone-archive phase root via
    // `collectPhaseRoots`). See `src/health-diagnostic-rules/consistency.cts`'s
    // fidelity-note comment on `checkC002` and
    // `src/planning-snapshot.cts`'s `buildPerPhasePlanScanFields` (called with
    // `paths.phases` only). With `.planning/phases/` removed by this fixture
    // (milestone-archive-only layout), NEITHER C002 nor C004 can fire for the
    // active-archive phase `65-current` anymore — this locks that known,
    // disclosed gap rather than asserting behavior the migration no longer
    // provides.
    assert.ok(
      !warningsPosix.some(w => /Gap in plan numbering in .*milestones\/v1\.7-phases\/65-current/.test(w)),
      `plan-numbering gap is out of scope for milestone-archive phases post-migration; got: ${JSON.stringify(warningsPosix)}`,
    );
    assert.ok(
      !warningsPosix.some(w => /milestones\/v1\.7-phases\/65-current\/65-0[13]-PLAN\.md: missing 'wave'/.test(w)),
      `missing-wave is out of scope for milestone-archive phases post-migration; got: ${JSON.stringify(warningsPosix)}`,
    );
  });
});

describe('#3164 — validate health: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no W006 warnings for phases that exist in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => {
      const msg = typeof w === 'string' ? w : w.message;
      return msg && msg.includes('Phase 64') && msg.includes('no directory');
    });
    assert.deepStrictEqual(w006, []);
  });
});

describe('#3164 — find-phase: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('find-phase 64 returns found:true for phase in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('find-phase 64', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).found, true);
  });

  test('find-phase searches milestone archives in deterministic sorted order', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test setup: removing phases subdirectory to establish milestone-archive layout
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    const v110 = path.join(milestonesDir, 'v1.10-phases', '64-from-110');
    const v12 = path.join(milestonesDir, 'v1.2-phases', '64-from-12');
    fs.mkdirSync(v110, { recursive: true });
    fs.mkdirSync(v12, { recursive: true });
    fs.writeFileSync(path.join(v110, 'PLAN.md'), '# v1.10 plan\n');
    fs.writeFileSync(path.join(v12, 'PLAN.md'), '# v1.2 plan\n');

    const result = runGsdTools('find-phase 64', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.directory, '.planning/milestones/v1.2-phases/64-from-12');
  });

  test('find-phase not-found payload includes searched_directories', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('find-phase 999', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.found, false);
    assert.ok(Array.isArray(out.searched_directories));
    assert.ok(
      out.searched_directories.includes('.planning/milestones/v1.7-phases'),
      `searched_directories should include active archive dir, got: ${JSON.stringify(out.searched_directories)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #3600: milestone phase filter understands project-code-prefixed directories
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #3600: milestone phase filter understands project-code-prefixed directories', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject('bug-3600-'); });
  afterEach(() => { cleanup(tmpDir); });

  function writeState(tmpDir, version) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), `---\nmilestone: ${version}\n---\n`);
  }
  function writeRoadmap(tmpDir, body) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), body);
  }
  function writeConfig(tmpDir, configObj) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(configObj, null, 2));
  }
  function ensurePhaseDir(tmpDir, name) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', name), { recursive: true });
  }

  // #3884 (ADR-3473 §8.4): `--json` was never a real flag for `init
  // new-milestone` — `init` subcommands always emit a JSON bundle regardless
  // of any flag (the machine-readable-output flag is `--raw`, documented at
  // docs/CLI-TOOLS.md:30, not `--json`). Under the pre-#3884 permissive
  // parser the unrecognized token was silently dropped and the assertions
  // below never actually depended on it; the strict parser now rejects it.
  // Removed across this describe block's four call sites.
  test('init.new-milestone counts CK-NN-name dirs against numeric `Phase N:` headings', () => {
    writeConfig(tmpDir, { project_code: 'CK' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: Discovery', '**Goal:** GoalOne', '',
      '### Phase 2: Build', '**Goal:** GoalTwo', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'CK-01-discovery');
    ensurePhaseDir(tmpDir, 'CK-02-build');

    const r = runGsdTools(['init', 'new-milestone'], tmpDir);
    assert.ok(r.success, `init new-milestone failed: ${r.error || r.output}`);
    const payload = JSON.parse(r.output);
    assert.strictEqual(payload.phase_dir_count, 2,
      `expected phase_dir_count=2, got ${payload.phase_dir_count}`);
  });

  test('unprefixed directories continue to count (#3537 / existing contract)', () => {
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: First', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, '01-first');

    const r = runGsdTools(['init', 'new-milestone'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1);
  });

  test('custom-ID match for PROJ-42 directory + Phase PROJ-42: heading still works', () => {
    writeConfig(tmpDir, { project_code: 'PROJ' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase PROJ-42: Custom', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'PROJ-42');

    const r = runGsdTools(['init', 'new-milestone'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1,
      'PROJ-42 directory must still match Phase PROJ-42: via the custom-ID path');
  });

  test('directories that do not match the milestone do NOT count (counter-test)', () => {
    writeConfig(tmpDir, { project_code: 'CK' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: First', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'CK-01-first');
    ensurePhaseDir(tmpDir, 'CK-99-backlog');
    ensurePhaseDir(tmpDir, 'CK-100-future');

    const r = runGsdTools(['init', 'new-milestone'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1,
      'only CK-01-first should match Phase 1; CK-99 and CK-100 must be excluded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2142: quick task archival at milestone close-out
// ─────────────────────────────────────────────────────────────────────────────

function setupQuickArchiveRoadmap(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
  );
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
}

function writeQuickTaskDir(tmpDir, name, files = {}) {
  const dir = path.join(tmpDir, '.planning', 'quick', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), content);
  }
  return dir;
}

function quickTasksStateWithRows(count) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`| ${i} | quick task ${i} | 2026-01-0${i} | abc000${i} | — |`);
  }
  return [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    ...rows,
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');
}

describe('#2142: quick task archival at milestone close-out', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('leavesQuickTasksInPlaceWhenFlagAbsent', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const quickDir = writeQuickTaskDir(tmpDir, '2026-01-01-fix-typo', {
      '2026-01-01-fix-typo-SUMMARY.md': '# Summary\n',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), quickTasksStateWithRows(1));

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false, 'archived.quick must be false when --archive-quick is absent');
    assert.ok(fs.existsSync(quickDir), 'quick task directory must remain in place');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no quick archive dir should be created',
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const table = findTableBySchema(stateContent, 'QuickTasks');
    assert.ok(table, 'Quick Tasks table must still be present');
    assert.strictEqual(table.rows.length, 1, 'quick task row must remain untouched');
  });

  test('archivesQuickTasksAndResetsTableWhenFlagPassed', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const names = ['2026-01-01-a', '2026-01-02-b', '2026-01-03-c'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), quickTasksStateWithRows(3));

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete --archive-quick failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true);

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    for (const name of names) {
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must be moved out of .planning/quick`,
      );
      assert.ok(fs.existsSync(path.join(archiveDir, name)), `${name} must exist in the archive dir`);
    }
    const readmeStat = fs.statSync(path.join(archiveDir, 'README.md'));
    assert.ok(readmeStat.isFile(), 'README.md index must be generated');
    assert.ok(readmeStat.size > 0, 'README.md index must be non-empty');
    const index = buildQuickArchiveIndex(archiveDir);
    const indexedNames = index.entries.map((e) => e.name);
    for (const name of names) {
      assert.ok(indexedNames.includes(name), `index entries must name ${name}`);
    }

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const table = findTableBySchema(stateContent, 'QuickTasks');
    assert.ok(table, 'Quick Tasks table header must survive the reset');
    assert.strictEqual(table.rows.length, 0, 'all quick task rows must be cleared');
  });

  test('noOpsWhenQuickDirectoryAbsent', () => {
    setupQuickArchiveRoadmap(tmpDir);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')));
  });

  test('doesNotCreateArchiveDirForEmptyQuickDir', () => {
    setupQuickArchiveRoadmap(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false, 'boundary 0: an empty quick dir must not count as archived');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no archive dir for zero entries',
    );
  });

  test('archivesSingleQuickTaskDirectory', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-02-01-only-one');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true, 'boundary 1: a single quick task dir must archive');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-02-01-only-one')));
  });

  test('archivesMultipleQuickTaskDirectories', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-02-01-first');
    writeQuickTaskDir(tmpDir, '2026-02-02-second');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true, 'boundary 2: multiple quick task dirs must archive');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.existsSync(path.join(archiveDir, '2026-02-01-first')));
    assert.ok(fs.existsSync(path.join(archiveDir, '2026-02-02-second')));
  });

  test('archivesWhenStateHasNoQuickTasksSection', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-03-01-no-section');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# STATE\n\n### Blockers/Concerns\nNone\n');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete must succeed even without a Quick Tasks Completed section: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-03-01-no-section')));
    // #2142 design doc §40 behavior table row 5: an absent "Quick Tasks
    // Completed" section is the common, silent no-op path (the section is
    // created lazily by quick.md, not by templates/state.md) — it must
    // never be surfaced as a preservation_warnings entry.
    assert.ok(
      !(result.data.preservation_warnings || []).some((w) => w.field === 'quick_tasks_table'),
      `an absent Quick Tasks Completed section must not produce a quick_tasks_table warning, got: ${JSON.stringify(result.data.preservation_warnings)}`,
    );
  });

  test('refusesResetAndWarnsWhenQuickTasksTableHasNonCanonicalHeader', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-03-02-noncanonical');
    const nonCanonicalState = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Thing | When |',
      '|---|-------|------|',
      '| 1 | custom thing | 2026-03-02 |',
      '',
      '### Blockers/Concerns',
      'None',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), nonCanonicalState);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete must succeed even when the reset is refused: ${result.error}`);
    // The quick directories still move — only the STATE.md table reset is refused.
    assert.strictEqual(result.data.archived.quick, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-03-02-noncanonical')));

    assert.ok(
      (result.data.preservation_warnings || []).some((w) => w.field === 'quick_tasks_table'),
      `a non-canonical Quick Tasks table header must produce a quick_tasks_table warning, got: ${JSON.stringify(result.data.preservation_warnings)}`,
    );

    // allow-test-rule: source-text-is-the-product (#2142)
    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      stateContent.includes('| # | Thing | When |'),
      'the non-canonical header must survive byte-exact since the reset was refused',
    );
    assert.ok(
      stateContent.includes('| 1 | custom thing | 2026-03-02 |'),
      'the original data row must remain on disk — a refused reset must not drop rows',
    );
  });

  test('suffixesCollidingQuickTaskDirectoryOnRerun', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-04-01-rerun';
    writeQuickTaskDir(tmpDir, name, { 'new-marker.txt': 'new run\n' });

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    fs.mkdirSync(path.join(archiveDir, name), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, name, 'existing-marker.txt'), 'prior run\n');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(fs.existsSync(path.join(archiveDir, name, 'existing-marker.txt')), 'prior archive entry must survive');
    assert.strictEqual(
      fs.readFileSync(path.join(archiveDir, name, 'existing-marker.txt'), 'utf-8'),
      'prior run\n',
      'prior archive entry contents must be untouched',
    );
    assert.ok(fs.existsSync(path.join(archiveDir, `${name}.1`)), 'the newly-archived dir must be suffixed .1');
    assert.ok(
      fs.existsSync(path.join(archiveDir, `${name}.1`, 'new-marker.txt')),
      "the suffixed dir must carry this run's content",
    );
  });

  test('indexLinksPerTaskSummaryFile', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-01-per-task-summary';
    writeQuickTaskDir(tmpDir, name, { [`${name}-SUMMARY.md`]: '# Summary\nDid the thing.\n' });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.statSync(path.join(archiveDir, 'README.md')).isFile(), 'README.md index must be generated');
    const index = buildQuickArchiveIndex(archiveDir);
    const entry = index.entries.find((e) => e.name === name);
    assert.ok(entry, 'index entries must list the task directory');
    assert.strictEqual(
      entry.summary,
      `${name}/${name}-SUMMARY.md`,
      'index entry must link the per-task summary file via its archive-dir-relative path (name/name-SUMMARY.md), not a bare filename',
    );
    const rendered = index.render();
    const linkMatch = rendered.match(new RegExp(`\\[${name}\\]\\(([^)]+)\\)`));
    assert.ok(linkMatch, 'rendered index must contain a markdown link for the task');
    assert.strictEqual(
      linkMatch[1],
      `${name}/${name}-SUMMARY.md`,
      'rendered link target must resolve into the task subdirectory, not the archive root',
    );
  });

  test('indexLinksLegacyBareSummaryFile', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-02-bare-summary';
    writeQuickTaskDir(tmpDir, name, { 'SUMMARY.md': '# Summary\nDid the other thing.\n' });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.statSync(path.join(archiveDir, 'README.md')).isFile(), 'README.md index must be generated');
    const index = buildQuickArchiveIndex(archiveDir);
    const entry = index.entries.find((e) => e.name === name);
    assert.ok(entry, 'index entries must list the task directory');
    assert.strictEqual(
      entry.summary,
      `${name}/SUMMARY.md`,
      'index entry must link the legacy bare summary file via its archive-dir-relative path (name/SUMMARY.md), not a bare filename',
    );
  });

  test('indexListsTaskWithoutSummaryWithoutLink', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-03-no-summary';
    writeQuickTaskDir(tmpDir, name); // no files at all

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.statSync(path.join(archiveDir, 'README.md')).isFile(), 'README.md index must be generated');
    const index = buildQuickArchiveIndex(archiveDir);
    const entry = index.entries.find((e) => e.name === name);
    assert.ok(entry, 'index entries must still list a task directory with no summary');
    assert.strictEqual(entry.summary, null, 'index entry must not link into a directory that has no summary file to point at');
  });

  test('skipsNonDirectoryEntriesInQuickDir', () => {
    setupQuickArchiveRoadmap(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'quick', 'stray-notes.txt'), 'not a task dir\n');
    writeQuickTaskDir(tmpDir, '2026-06-01-real-task');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', 'stray-notes.txt')),
      'a loose file must not be archived',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', 'stray-notes.txt')),
      'loose file must not appear under the archive dir',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-06-01-real-task')),
      'the real task directory must still archive',
    );
  });

  test('dryRunPreviewsQuickArchivalWithoutMutating', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const names = ['2026-07-01-preview-a', '2026-07-02-preview-b'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--dry-run', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete --dry-run failed: ${result.error}`);
    assert.ok(Array.isArray(result.data.would_archive.quick), 'would_archive.quick must be an array');
    for (const name of names) {
      assert.ok(result.data.would_archive.quick.includes(name), `would_archive.quick must name ${name}`);
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must remain on disk after a dry run`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'dry run must not create the archive dir',
    );
  });

  test('rejectsVersionWithPathSeparator', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-08-01-evil-version');

    const result = runSdkQuery(['milestone.complete', '../evil', '--archive-quick', '--confirm'], tmpDir);
    assert.strictEqual(result.success, false, 'a version containing a path separator must be rejected');
    assert.ok(!fs.existsSync(path.join(tmpDir, '..', 'evil')), 'nothing must be created outside the temp fixture root');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    if (fs.existsSync(milestonesDir)) {
      for (const entry of fs.readdirSync(milestonesDir)) {
        assert.ok(!entry.includes('..'), `no traversal-shaped entry may exist under milestones/: ${entry}`);
      }
    }
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', '2026-08-01-evil-version')),
      'quick task dir must remain untouched on refusal',
    );
  });

  test('archivesQuickTaskWithUnicodeAndSpaces', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-01-01-café report';
    writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', name)),
      'a unicode/space-containing quick task directory name must archive correctly',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2142 escalation: `milestone.archive-quick` — narrow archival entry point
//
// `milestone.complete --archive-quick` cannot be reused by cleanup.md: it
// hard-errors via `missingExplicitVersion` for an already-completed milestone
// (no `### Phase N:` headings left in its ROADMAP window), re-archives
// ROADMAP.md over the very snapshot cleanup depends on, and would append a
// duplicate MILESTONES.md entry on every re-run. `milestone.archive-quick` is the
// narrow replacement — see `cmdQuickArchive` in src/milestone.cts.
// ─────────────────────────────────────────────────────────────────────────────

describe('#2142 escalation: milestone.archive-quick — narrow archival entry point', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('quickArchiveMovesDirectoriesWithoutTouchingRoadmap', () => {
    // Already-completed-milestone shape: v1.0 was archived by a PRIOR
    // milestone.complete run (its ROADMAP snapshot lives at
    // milestones/v1.0-ROADMAP.md), and the LIVE ROADMAP.md has moved on to
    // v1.1 — it carries no `### Phase N:` heading for v1.0 at all. This is
    // exactly the shape that makes `milestone.complete v1.0 --archive-quick`
    // fail with `missingExplicitVersion`.
    const liveRoadmap = '# Roadmap\n\n## v1.1: Next\n\n### Phase 1: New Work\n**Goal:** Ship more.\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), liveRoadmap);
    const archivedRoadmap = '# Roadmap\n\n## v1.0: First\n\n### Phase 1: Foundation\n**Goal:** Setup.\n';
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md'), archivedRoadmap);

    // Confirm the premise this command exists to fix.
    const milestoneCompleteResult = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.strictEqual(
      milestoneCompleteResult.success,
      false,
      'milestone.complete v1.0 --archive-quick must still fail against an already-archived milestone',
    );

    writeQuickTaskDir(tmpDir, '2026-09-01-fix-typo');

    const result = runSdkQuery(['milestone.archive-quick', 'v1.0'], tmpDir);
    assert.ok(result.success, `milestone.archive-quick should succeed where milestone.complete fails: ${result.error}`);
    assert.strictEqual(result.data.archived, 1);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-09-01-fix-typo')),
      'quick task dir must be moved into the v1.0-quick archive',
    );

    const liveRoadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.strictEqual(liveRoadmapAfter, liveRoadmap, '.planning/ROADMAP.md must be byte-identical after milestone.archive-quick');
    const archivedRoadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md'), 'utf-8');
    assert.strictEqual(
      archivedRoadmapAfter,
      archivedRoadmap,
      'the archived v1.0-ROADMAP.md snapshot must be byte-identical after milestone.archive-quick',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'milestone.archive-quick must never write a MILESTONES.md entry',
    );
  });

  test('quickArchiveRejectsVersionWithPathSeparator', () => {
    writeQuickTaskDir(tmpDir, '2026-09-02-evil-version');

    const result = runSdkQuery(['milestone.archive-quick', '../evil'], tmpDir);
    assert.strictEqual(result.success, false, 'a version containing a path separator must be rejected');
    assert.ok(!fs.existsSync(path.join(tmpDir, '..', 'evil')), 'nothing must be created outside the temp fixture root');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    if (fs.existsSync(milestonesDir)) {
      for (const entry of fs.readdirSync(milestonesDir)) {
        assert.ok(!entry.includes('..'), `no traversal-shaped entry may exist under milestones/: ${entry}`);
      }
    }
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', '2026-09-02-evil-version')),
      'quick task dir must remain untouched on refusal',
    );
  });

  test('quickArchiveDryRunMutatesNothing', () => {
    const names = ['2026-09-03-preview-a', '2026-09-03-preview-b'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['milestone.archive-quick', 'v1.0', '--dry-run'], tmpDir);
    assert.ok(result.success, `milestone.archive-quick --dry-run failed: ${result.error}`);
    assert.ok(Array.isArray(result.data.would_archive), 'would_archive must be an array');
    for (const name of names) {
      assert.ok(result.data.would_archive.includes(name), `would_archive must name ${name}`);
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must remain on disk after a dry run`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'dry run must not create the archive dir',
    );
  });

  test('quickArchiveIsNoOpWhenQuickDirAbsent', () => {
    const result = runSdkQuery(['milestone.archive-quick', 'v1.0'], tmpDir);
    assert.ok(result.success, `milestone.archive-quick should succeed with no .planning/quick: ${result.error}`);
    assert.strictEqual(result.data.archived, 0);
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no archive dir should be created when .planning/quick is absent',
    );
  });

  // MAJOR 6 (#2142 review): `milestone.archive-quick`'s STATE.md write now routes
  // through `readModifyWriteStateMd` (src/milestone.cts cmdQuickArchive)
  // instead of a bare `platformWriteSync`. Behavioral proof that the reset
  // still applies correctly and `state_updated` still reports `true`.
  test('quickArchiveResetsStateTableThroughOwnedCompositionAndReportsStateUpdated', () => {
    writeQuickTaskDir(tmpDir, '2026-09-04-a');
    writeQuickTaskDir(tmpDir, '2026-09-04-b');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), quickTasksStateWithRows(2));

    const result = runSdkQuery(['milestone.archive-quick', 'v1.0'], tmpDir);
    assert.ok(result.success, `milestone.archive-quick failed: ${result.error}`);
    assert.strictEqual(result.data.archived, 2);
    assert.strictEqual(result.data.state_updated, true, 'state_updated must be true when the table reset actually applied');
    assert.deepStrictEqual(result.data.warnings, []);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const table = findTableBySchema(stateContent, 'QuickTasks');
    assert.ok(table, 'Quick Tasks table header must survive the reset');
    assert.strictEqual(table.rows.length, 0, 'all quick task rows must be cleared');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2142 review — BLOCKER 1, MAJOR 3, MAJOR 5 regression coverage
// ─────────────────────────────────────────────────────────────────────────────

// Placement note (code-review FIX 3): per docs/TESTING-SUITES.md this
// adversarial/prompt-injection + path-escape coverage belongs in a
// `*.security.test.cjs` file, not this unsuffixed unit lane. It stays here
// instead: `scripts/lint-test-file-count.allowlist.json`'s `milestone` entry
// is an IDENTITY ratchet (an exact, already-over-cap list of 8 known
// filenames) — a new `milestone-archive.security.test.cjs` buckets into the
// same `milestone` module (`testEffectivePrefix` strips `.test.cjs`, and
// `milestone-archive.security` still starts with `milestone-`) and is a
// NOVEL file the ratchet has never seen, so `node scripts/lint-test-file-count.cjs`
// fails it outright (verified empirically: FAIL_NOVEL_FILES, exit 1).
// Splitting this describe block out is blocked by that ratchet, not by
// oversight; revisit if the `milestone` module's test files are ever
// consolidated below the cap.
describe('#2142 review: README injection, symlink escape, dry-run/real-run parity', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // BLOCKER 1: a quick-task directory name containing an embedded newline
  // plus markdown heading syntax must never let that heading land verbatim
  // in the generated README.md (indirect prompt-injection vector).
  test('embeddedNewlineInDirNameCannotInjectAHeadingIntoTheGeneratedReadme', (t) => {
    setupQuickArchiveRoadmap(tmpDir);
    const maliciousName = '2026-10-01-evil\n\n## Injected';
    // Windows forbids control characters (0x00-0x1F, which includes \n) in
    // path names outright, so `fs.mkdirSync` below cannot even create this
    // fixture there — it fails during SETUP, not as a defect in the escaping
    // under test. Skip deterministically by platform rather than by error
    // code: Windows reports this specific failure as the generic ENOENT
    // (verified in CI, errno -4058), and ENOENT is also the code a genuine
    // POSIX fixture-setup bug (e.g. a missing parent directory) would throw.
    // Adding ENOENT to the catch below would blanket-skip that real failure
    // on POSIX too, silently turning a defect into a pass — do not
    // "simplify" this back to a single try/catch.
    if (process.platform === 'win32') {
      t.skip('Windows forbids control characters (including newline) in path names, so this fixture cannot be created here; the escaping it guards is exercised on POSIX');
      return;
    }
    try {
      writeQuickTaskDir(tmpDir, maliciousName);
    } catch (err) {
      if (err && ['EINVAL', 'ENAMETOOLONG'].includes(err.code)) {
        t.skip(`this platform's filesystem rejects a newline in a directory name (${err.code})`);
        return;
      }
      throw err;
    }

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.statSync(path.join(archiveDir, 'README.md')).isFile(), 'README.md index must be generated');
    const index = buildQuickArchiveIndex(archiveDir);
    assert.strictEqual(index.entries.length, 1, 'exactly one archived quick-task directory');
    assert.ok(
      !index.entries[0].name.includes('\n'),
      `escaped entry name must not contain a raw newline — a newline surviving escaping is what would let ` +
        `an embedded "## Injected" become a standalone markdown heading line; got: ${JSON.stringify(index.entries[0].name)}`,
    );
  });

  // MAJOR 3: a symlink under `.planning/quick/` — even one targeting a real
  // directory OUTSIDE the planning root — must never be archived (moved) and
  // its target must never be altered, for BOTH archival entry points.
  function setupSymlinkEscape(t) {
    const outsideDir = createTempProject('gsd-quick-escape-target-');
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'do not touch\n');
    const symlinkPath = path.join(tmpDir, '.planning', 'quick', '2026-10-02-escape-symlink');
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    try {
      fs.symlinkSync(outsideDir, symlinkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      cleanup(outsideDir);
      if (err && ['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
        t.skip(`symlink creation is not available on this platform (${err.code})`);
        return null;
      }
      throw err;
    }
    return { outsideDir, symlinkPath };
  }

  test('symlinkEscapeIsNeverArchivedByMilestoneComplete', (t) => {
    setupQuickArchiveRoadmap(tmpDir);
    const escape = setupSymlinkEscape(t);
    if (!escape) return; // t.skip already recorded above
    const { outsideDir, symlinkPath } = escape;
    try {
      writeQuickTaskDir(tmpDir, '2026-10-02-real-task');

      const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
      assert.ok(result.success, `milestone.complete failed: ${result.error}`);
      assert.strictEqual(result.data.archived.quick, true, 'the real task dir must still archive');

      assert.ok(fs.existsSync(symlinkPath), 'the symlink must remain in .planning/quick, never moved');
      assert.ok(fs.lstatSync(symlinkPath).isSymbolicLink(), 'the entry must still be a symlink, untouched');
      assert.ok(
        fs.existsSync(path.join(outsideDir, 'marker.txt')),
        "the symlink's external target must never be moved or altered",
      );
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-10-02-escape-symlink')),
        'the symlink must never appear inside the archive directory',
      );
    } finally {
      cleanup(outsideDir);
    }
  });

  test('symlinkEscapeIsNeverArchivedByQuickArchive', (t) => {
    const escape = setupSymlinkEscape(t);
    if (!escape) return; // t.skip already recorded above
    const { outsideDir, symlinkPath } = escape;
    try {
      writeQuickTaskDir(tmpDir, '2026-10-03-real-task');

      const result = runSdkQuery(['milestone.archive-quick', 'v1.0'], tmpDir);
      assert.ok(result.success, `milestone.archive-quick failed: ${result.error}`);
      assert.strictEqual(result.data.archived, 1, 'only the real task dir must archive');

      assert.ok(fs.existsSync(symlinkPath), 'the symlink must remain in .planning/quick, never moved');
      assert.ok(fs.lstatSync(symlinkPath).isSymbolicLink(), 'the entry must still be a symlink, untouched');
      assert.ok(
        fs.existsSync(path.join(outsideDir, 'marker.txt')),
        "the symlink's external target must never be moved or altered",
      );
    } finally {
      cleanup(outsideDir);
    }
  });

  // MAJOR 5: dry-run preview must be produced by the SAME selection rule
  // (`listQuickTaskDirsForArchive`) as the real archive pass, so a fixture
  // containing an entry the real run would skip (a symlink) is ALSO absent
  // from the dry-run preview — they cannot disagree.
  test('dryRunPreviewMatchesRealArchiveWhenAnEntryIsSkipped', (t) => {
    setupQuickArchiveRoadmap(tmpDir);
    const escape = setupSymlinkEscape(t);
    if (!escape) return; // t.skip already recorded above
    const { outsideDir } = escape;
    try {
      writeQuickTaskDir(tmpDir, '2026-10-04-keep');

      const dryRun = runSdkQuery(['milestone.complete', 'v1.0', '--dry-run', '--archive-quick'], tmpDir);
      assert.ok(dryRun.success, `dry-run failed: ${dryRun.error}`);
      assert.deepStrictEqual(
        dryRun.data.would_archive.quick,
        ['2026-10-04-keep'],
        'the skipped symlink entry must not appear in the dry-run preview',
      );

      const real = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick', '--confirm'], tmpDir);
      assert.ok(real.success, `real run failed: ${real.error}`);
      const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
      const archivedNames = fs
        .readdirSync(archiveDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      assert.deepStrictEqual(
        archivedNames,
        dryRun.data.would_archive.quick,
        'the real run must archive exactly what the dry-run preview reported',
      );
    } finally {
      cleanup(outsideDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3597: milestone complete refuses to archive phase directories when the
// milestone window's scope is not SCOPE.COMPLETE (ADR-3180 "a non-answer must
// not be acted on"). Regression coverage for the specific widening #3597
// introduced when listMilestonePhaseDirs stopped forcing `ws: null` — a
// workstream with phase directories but NO workstream-local ROADMAP.md now
// resolves its milestone window against the ACTIVE workstream (fixing --ws
// progress), but getMilestonePhaseFilter throws internally when it cannot
// read that workstream's ROADMAP.md, degrading scope to SCOPE.UNREADABLE with
// a pass-all directory fallback. Before this guard, `milestone complete`
// archived every phase directory on disk in that shape; after it, the archive
// step refuses and reports why, while the surrounding command (ROADMAP/
// REQUIREMENTS archival, STATE.md closure) still completes — matching the
// pre-existing UNREADABLE/UNSCOPED "legitimately handled" posture documented
// at the TRUNCATED-only whole-command refusal above it in src/milestone.cts.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3597: milestone complete refuses to archive on a non-COMPLETE window scope', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function seedUnreadableWorkstream(cwd) {
    // Root ROADMAP.md declares only phase 1 — irrelevant to the workstream's
    // OWN window once the workstream is active, but included to mirror the
    // exact reproduction shape (a root ROADMAP that could otherwise mislead a
    // naive root-scoped read).
    fs.writeFileSync(
      path.join(cwd, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Root\n\n**Goal:** Root-only work.\n',
    );
    // Workstream `alpha`: STATE.md declares milestone v1.0, but NO
    // ROADMAP.md of its own — this is what makes getMilestonePhaseFilter
    // throw internally and degrade to SCOPE.UNREADABLE for this workstream's
    // window.
    seedWorkstream(cwd, {
      name: 'alpha',
      state: '---\nmilestone: v1.0\n---\n\n# GSD State\n',
      active: true,
    });
    const alphaPhases = path.join(cwd, '.planning', 'workstreams', 'alpha', 'phases');
    for (const dir of ['01-a', '02-b', '03-c']) {
      fs.mkdirSync(path.join(alphaPhases, dir), { recursive: true });
    }
    return alphaPhases;
  }

  test('archives NOTHING and leaves every phase dir on disk when the workstream has no ROADMAP.md', () => {
    const alphaPhases = seedUnreadableWorkstream(tmpDir);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete should still succeed (UNREADABLE is not a whole-command refusal): ${result.error}`);

    assert.strictEqual(result.data.archived.phases, false, 'phases must NOT be reported as archived');
    assert.strictEqual(result.data.archived.phases_archive_skipped, true, 'the refusal must be surfaced as machine-readable');
    assert.ok(
      typeof result.data.archived.phases_archive_skip_reason === 'string'
        && result.data.archived.phases_archive_skip_reason.length > 0,
      `expected a non-empty skip reason, got: ${JSON.stringify(result.data.archived.phases_archive_skip_reason)}`,
    );

    const onDisk = fs.readdirSync(alphaPhases, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.deepStrictEqual(onDisk, ['01-a', '02-b', '03-c'], 'all three phase directories must still be on disk, untouched');

    // Negative proof: no phase-archive directory was even created.
    assert.strictEqual(
      fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'milestones', 'v1.0-phases')),
      false,
      'the archive destination must never be created on a refused archive pass',
    );
  });

  test('--dry-run previews an empty archive list and the same refusal on the unreadable-window workstream', () => {
    seedUnreadableWorkstream(tmpDir);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--dry-run'], tmpDir);
    assert.ok(result.success, `milestone.complete --dry-run should succeed: ${result.error}`);
    assert.deepStrictEqual(result.data.would_archive.phases, [], 'dry-run must preview an EMPTY archive list');
    assert.strictEqual(result.data.would_archive.phases_archive_skipped, true);
    assert.ok(
      typeof result.data.would_archive.phases_archive_skip_reason === 'string'
        && result.data.would_archive.phases_archive_skip_reason.length > 0,
    );
  });

  test('the guard is not a blanket refusal — a normal COMPLETE-scope workstream still archives exactly its in-window phase dirs', () => {
    // Workstream `beta` HAS its own ROADMAP.md declaring phase 1 only — a
    // real, resolvable (SCOPE.COMPLETE) window. `02-out-of-window` has no
    // matching ROADMAP entry and must NOT be archived, proving this exercises
    // real window scoping and not merely "archive everything present".
    seedWorkstream(tmpDir, {
      name: 'beta',
      state: '---\nmilestone: v1.0\n---\n\n# GSD State\n',
      // #3597: a versioned `## v1.0 ...` heading is required for the window
      // to resolve SCOPE.COMPLETE against the explicit `version` argument —
      // a free-form roadmap (no versioned heading at all) resolves UNSCOPED
      // instead once an explicit version is requested (verified empirically
      // against the built CLI), which would silently defeat this "guard is
      // not a blanket refusal" proof.
      roadmap: '# Roadmap\n\n## v1.0 Current\n\n### Phase 1: Foo\n\n**Goal:** Do foo.\n',
      active: true,
    });
    const betaPhases = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases');
    fs.mkdirSync(path.join(betaPhases, '01-foo'), { recursive: true });
    fs.mkdirSync(path.join(betaPhases, '02-out-of-window'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete should succeed: ${result.error}`);

    assert.strictEqual(result.data.archived.phases, true, 'phases must be reported as archived');
    assert.strictEqual(result.data.archived.phases_archive_skipped, false, 'a resolvable (COMPLETE) window must not be reported as skipped');
    assert.strictEqual(result.data.archived.phases_archive_skip_reason, null);

    const archiveDir = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'milestones', 'v1.0-phases');
    assert.ok(fs.existsSync(path.join(archiveDir, '01-foo')), 'the in-window phase dir must be archived');
    assert.ok(!fs.existsSync(path.join(archiveDir, '02-out-of-window')), 'the out-of-window phase dir must NOT be archived');
    assert.ok(fs.existsSync(path.join(betaPhases, '02-out-of-window')), 'the out-of-window phase dir must remain on disk, untouched');
  });

  // #3597 regression: the guard originally shipped as "refuse whenever scope
  // !== SCOPE.COMPLETE", which also caught SCOPE.UNSCOPED — a DIFFERENT,
  // pre-existing classification whose archive behavior predates this branch.
  // A root project (no active workstream) with a free-form ROADMAP.md (no
  // versioned `## vX.Y` heading) resolves UNSCOPED once an explicit version
  // is requested — exactly the `milestone-rollover` QA scenario shape
  // (tests/qa/scenarios/milestone-rollover.json, fixture "greenfield":
  // .planning/ROADMAP.md from @roadmap/three-phase, no workstreams at all).
  // Under the too-broad guard, `milestone complete 1.0 --force` refused to
  // archive `01-parser`, leaving it on disk and causing the QA walk's
  // following `phases clear --confirm` step to abort on the #1447
  // uncommitted-change safety check. Narrowing the guard to UNREADABLE-only
  // must restore this exact rollover: the phase directories archive.
  test('a root project with an unscoped (non-versioned) roadmap still archives phase dirs like before the guard', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Parser\n**Goal:** Parse input.\n\n### Phase 2: Printable Output\n**Goal:** Render output.\n',
    );
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-parser'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '02-printable-output'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--force', '--confirm'], tmpDir);
    assert.ok(result.success, `milestone.complete should succeed: ${result.error}`);

    assert.strictEqual(result.data.archived.phases, true, 'phases must still be archived for an UNSCOPED (not UNREADABLE) window');
    assert.strictEqual(result.data.archived.phases_archive_skipped, false, 'UNSCOPED must not trigger the refusal — only UNREADABLE does');
    assert.strictEqual(result.data.archived.phases_archive_skip_reason, null);

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');
    assert.ok(fs.existsSync(path.join(archiveDir, '01-parser')), '01-parser must be archived');
    assert.ok(fs.existsSync(path.join(archiveDir, '02-printable-output')), '02-printable-output must be archived');
    assert.ok(!fs.existsSync(path.join(phasesDir, '01-parser')), '01-parser must no longer be on disk at its original location');
    assert.ok(!fs.existsSync(path.join(phasesDir, '02-printable-output')), '02-printable-output must no longer be on disk at its original location');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5482: `milestone complete --confirm` is the one-way door, so the engine
// re-checks every blocking `ship:pre` predicate gate against each milestone
// phase directory and refuses. Fixture capability is an ACTIVE overlay cap (no
// consent gate, no activation key) under a clean HOME/XDG so the user's real
// capabilities cannot leak in.
// ─────────────────────────────────────────────────────────────────────────────

const EXIT3 = { kind: 'command-exit-zero', exitCode: 3, signal: null };

describe('milestone complete re-checks blocking ship:pre predicate gates per milestone phase (#5482)', () => {
  let tmpDir;
  let home;
  const env = () => cleanEnv(home);
  const complete = (extra = '') =>
    runGsdTools(`--json-errors milestone complete v1.0 --name MVP --confirm ${extra}`, tmpDir, env());
  const archived = () => fs.existsSync(path.join(tmpDir, '.planning', 'milestones'));
  const parseErr = (r) => JSON.parse(r.error.trim().split('\n').pop());
  // A refused close: typed reason, raw output in the failure message so a red run is diagnosable.
  const refusal = (r) => {
    assert.equal(r.success, false, `expected refusal, got: ${r.output}`);
    const err = parseErr(r);
    assert.equal(err.reason, ERROR_REASON.MILESTONE_GATE_BLOCKED, r.error);
    return err;
  };
  const wouldRefuse = () => gateResult().blocked;
  // Raw spawn (stderr visible on success) for the warning assertions.
  const completeRaw = (cwd = tmpDir) => runNode(
    [TOOLS_PATH, 'milestone', 'complete', 'v1.0', '--name', 'MVP', '--confirm'],
    { cwd, env: { ...process.env, ...env() }, timeoutMs: PROBE_TIMEOUT_MS },
  );
  const phaseDir = (name) => path.join(tmpDir, '.planning', 'phases', name);
  // Public boundary: the dry-run JSON carries the blocks (would_refuse) and the typed warnings (gate_warnings).
  const gateResult = (extra = '', cwd = tmpDir) => {
    const r = runGsdTools(`milestone complete v1.0 --name MVP --dry-run ${extra}`, cwd, env());
    assert.equal(r.success, true, r.error);
    let out;
    try {
      out = JSON.parse(r.output);
    } catch {
      assert.fail(`dry-run stdout is not JSON: ${r.output}`);
    }
    assert.ok(Array.isArray(out.would_refuse) && Array.isArray(out.gate_warnings), `dry-run JSON lacks would_refuse/gate_warnings arrays: ${r.output}`);
    return { blocked: out.would_refuse, warnings: out.gate_warnings };
  };
  const snapshot = () => fs.readdirSync(tmpDir, { recursive: true }).sort()
    .map((p) => [p, fs.statSync(path.join(tmpDir, p)).isFile() ? fs.readFileSync(path.join(tmpDir, p), 'utf-8') : null]);

  beforeEach(() => {
    tmpDir = createTempProject();
    home = createTempDir('gsd-5482-home-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), GATE_ROADMAP);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\n**Status:** In progress\n');
    fs.mkdirSync(phaseDir('01-foundation'), { recursive: true });
    fs.mkdirSync(phaseDir('02-build'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); cleanup(home); });

  test('G1 blocking predicate exit 3 refuses with typed reason and mutates nothing', () => {
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 01 || { echo 2 open items >&2; exit 3; }' });
    const before = snapshot();
    const err = refusal(complete());
    assert.deepEqual(err.blocked, [{ cap_id: 'open-work', phase: '01', gate_message: 'command exited 3: 2 open items', details: EXIT3 }]);
    assert.match(err.message, /Nothing has been changed\. Resolve or waive in that capability; --force does not bypass it\.$/);
    assert.deepEqual(snapshot(), before, 'a refused close must leave the project tree byte-identical');
  });

  for (const [title, cap] of [['passing', { command: 'exit 0' }], ['non-blocking failing', { command: 'exit 1', blocking: false }]]) {
    test(`G2 ${title} gate archives`, () => {
      writeGateCap(home, cap);
      assert.equal(complete().success, true);
      assert.equal(archived(), true);
    });
  }

  test('G3 malformed predicate: onError halt refuses, skip archives with warning', () => {
    writeGateCap(home, { predicate: { kind: 'command-exit-zero' } });
    const err = refusal(complete());
    assert.equal(err.blocked[0].gate_message, 'gate predicate evaluation failed: command-exit-zero predicate requires a non-empty string "command"');
    assert.equal(archived(), false);

    writeGateCap(home, { predicate: { kind: 'command-exit-zero' }, onError: 'skip' });
    const { blocked, warnings } = gateResult();
    assert.deepEqual(blocked, []);
    assert.deepEqual(warnings.map((w) => [w.kind, w.capId, w.phase]), [['skipped_phase', 'open-work', '01'], ['skipped_phase', 'open-work', '02']]);
    const skipped = completeRaw();
    assert.equal(skipped.exitCode, 0, skipped.stderr);
    assert.match(skipped.stderr, /warning: ship:pre gate of "open-work" skipped for phase "01": /);
    assert.equal(archived(), true);
  });

  test('G4 --dry-run with failing gate exits 0, mutates nothing, and previews the refusal', () => {
    writeGateCap(home, { command: 'exit 3' });
    const preview = wouldRefuse();
    assert.equal(archived(), false);
    assert.deepEqual(preview, [
      { cap_id: 'open-work', phase: '01', gate_message: 'command exited 3', details: EXIT3 },
      { cap_id: 'open-work', phase: '02', gate_message: 'command exited 3', details: EXIT3 },
    ]);
  });

  test('G5 --dry-run with passing gate previews no refusal', () => {
    writeGateCap(home, { command: 'exit 0' });
    assert.deepEqual(wouldRefuse(), []);
  });

  test('G6 --force never bypasses a blocking gate (#3726 AC4)', () => {
    writeGateCap(home, { command: 'exit 3' });
    refusal(complete('--force'));
    assert.equal(archived(), false);
  });

  test('G7 control characters in gate output are escaped in the refusal', () => {
    writeGateCap(home, { command: "printf '\\033[31mred\\nError: forged' >&2; exit 1" });
    const r = runGsdTools('milestone complete v1.0 --name MVP --confirm', tmpDir, env());
    assert.equal(r.success, false);
    assert.ok(!r.error.includes('\x1b'), 'raw ESC must not reach stderr');
    assert.equal(r.error.trim().split('\n').length, 1, 'newline in gate output must not forge a second line');
  });

  test('G8 query-kind blocking gate is prose-only: the engine skips it with a warning', () => {
    writeGateCap(home, { gates: [{ check: { query: 'status' }, blocking: true, onError: 'halt' }] });
    assert.deepEqual(gateResult(), { blocked: [], warnings: [{ kind: 'not_check_predicate', capId: 'open-work' }] });
    const r = completeRaw();
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(archived(), true);
    assert.match(r.stderr, /warning: ship:pre gate of "open-work" is not a check\.predicate/);
  });

  test('G9 several gates: an advisory pass then a blocking failure still refuses', () => {
    writeGateCap(home, { gates: [
      { check: { predicate: { kind: 'command-exit-zero', command: 'exit 0' } }, blocking: false, onError: 'skip' },
      { check: { predicate: { kind: 'command-exit-zero', command: 'exit 3' } }, blocking: true, onError: 'halt' },
    ] });
    refusal(complete());
    assert.equal(archived(), false);
  });

  test('G10 artifact-frontmatter-equals resolves against each phase dir', () => {
    fs.writeFileSync(path.join(phaseDir('01-foundation'), '01-OPEN-WORK.md'), '---\nstatus: open\n---\n');
    fs.writeFileSync(path.join(phaseDir('02-build'), '02-OPEN-WORK.md'), '---\nstatus: closed\n---\n');
    writeGateCap(home, { predicate: { kind: 'artifact-frontmatter-equals', artifact: 'OPEN-WORK.md', field: 'status', equals: 'closed' } });
    assert.deepEqual(refusal(complete()).blocked.map((b) => b.phase), ['01']);
    fs.writeFileSync(path.join(phaseDir('01-foundation'), '01-OPEN-WORK.md'), '---\nstatus: closed\n---\n');
    assert.equal(complete().success, true);
  });

  test('G11 default security_enforcement + enabled broken-windows without artifacts do not refuse (ship.md step 6 owns them)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ workflow: { windows_enforce: true } }));
    assert.deepEqual(gateResult(), { blocked: [], warnings: [] });
    assert.equal(complete().success, true);
    assert.equal(archived(), true);
  });

  test('G11b ship.md step 6 hand-enforces exactly security and broken-windows, the two caps the engine skips (G11)', () => {
    const ship = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md'), 'utf-8');
    const named = [...ship.matchAll(/capId == "([a-z-]{1,40})"/g)].map((m) => m[1]).sort();
    assert.deepEqual(named, ['broken-windows', 'security']);
  });

  test('G12 a phase directory outside the milestone is not evaluated', () => {
    fs.mkdirSync(phaseDir('05-later'), { recursive: true });
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 05' });
    assert.deepEqual(wouldRefuse(), []);
    assert.equal(complete().success, true);
  });

  test('G13 two blocked phases both appear in the error details and in would_refuse', () => {
    writeGateCap(home, { command: 'echo open >&2; exit 3' });
    const expected = ['01', '02'].map((phase) => ({ cap_id: 'open-work', phase, gate_message: 'command exited 3: open', details: EXIT3 }));
    assert.deepEqual(wouldRefuse(), expected);
    const err = refusal(complete());
    assert.deepEqual(err.blocked, expected);
    assert.match(err.message, /"open-work" \(phase "01"\): .*; "open-work" \(phase "02"\): /);
  });

  // The audit-milestone step 5.6 prose consumes this JSON; it cannot be executed, so pin the
  // contract it reads: its named entry fields must be exactly the CLI's would_refuse entry keys.
  test('G13b audit-milestone step 5.6 names exactly the fields would_refuse entries carry', () => {
    const named = openWorkStepFields();
    assert.deepEqual(wouldRefuse(), []);
    writeGateCap(home, { command: 'exit 3' });
    const entries = wouldRefuse();
    assert.ok(Array.isArray(entries) && entries.length > 0);
    for (const e of entries) assert.deepEqual(Object.keys(e).sort(), [...named].sort());
  });

  test('G14 ${PHASE_NUMBER} and ${PHASE_DIR} interpolate per phase', () => {
    writeGateCap(home, { command: 'echo "${PHASE_NUMBER}|${PHASE_DIR}" >&2; exit 3' });
    const blocked = wouldRefuse();
    assert.deepEqual(blocked.map((b) => b.phase), ['01', '02']);
    for (const [b, dir] of [[blocked[0], '01-foundation'], [blocked[1], '02-build']]) {
      const [num, dirArg] = b.gate_message.replace(/^command exited 3: /, '').split('|');
      assert.equal(num, b.phase);
      assert.ok(path.isAbsolute(dirArg), dirArg);
      assert.ok(dirArg.endsWith(path.join('.planning', 'phases', dir)), dirArg);
    }
  });

  test('G15 TRUNCATED window with --force widens the gated set to every phase dir on disk', () => {
    // Heading found but its section ends before the phase entries (#3166): --force overrides the
    // scope refusal and the filter degrades to pass-all, so the backstop gates every directory.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.0 MVP\n\nNotes.\n\n## v2.0 Next\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Build\n**Goal:** Build\n');
    fs.mkdirSync(phaseDir('05-later'), { recursive: true });
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 05' });
    assert.match(complete().error, /the ROADMAP window for .*v1\.0.* is truncated/, 'fixture must be TRUNCATED');
    assert.deepEqual(refusal(complete('--force')).blocked.map((b) => b.phase), ['05']);
  });

  const UNREADABLE_MSG = 'milestone window scope is "unreadable": the phase set cannot be resolved, so this gate was not run';
  // Workstream with phase dirs but no ROADMAP of its own (#3597): scope UNREADABLE, archive skipped.
  const seedUnreadable = () => {
    seedWorkstream(tmpDir, { name: 'alpha', state: '---\nmilestone: v1.0\n---\n\n# GSD State\n', active: true });
    for (const d of ['01-a', '02-b']) fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'phases', d), { recursive: true });
  };

  test('G16 UNREADABLE window scope: a blocking halt gate that cannot run refuses the close, --force does not bypass it', () => {
    seedUnreadable();
    writeGateCap(home, { command: 'exit 3' });
    assert.deepEqual(gateResult(), { blocked: [{ cap_id: 'open-work', phase: '*', gate_message: UNREADABLE_MSG, details: null }], warnings: [] });
    const before = snapshot();
    assert.deepEqual(refusal(complete()).blocked.map((b) => b.phase), ['*']);
    assert.deepEqual(refusal(complete('--force')).blocked.map((b) => b.phase), ['*']);
    assert.deepEqual(snapshot(), before, 'a refused close must leave the project tree byte-identical');
  });

  test('G16e UNREADABLE window scope with an onError skip gate: a warning says so and the close proceeds', () => {
    seedUnreadable();
    writeGateCap(home, { command: 'exit 3', onError: 'skip' });
    assert.deepEqual(gateResult(), { blocked: [], warnings: [{ kind: 'scope_unreadable' }] });
    const r = completeRaw();
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /warning: ship:pre gates not re-checked: milestone window scope is "unreadable"/);
  });

  test('G16d UNREADABLE window scope without a gate-declaring capability: no warning', () => {
    seedWorkstream(tmpDir, { name: 'alpha', state: '---\nmilestone: v1.0\n---\n\n# GSD State\n', active: true });
    for (const d of ['01-a', '02-b']) fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'phases', d), { recursive: true });
    assert.deepEqual(gateResult(), { blocked: [], warnings: [] });
    const r = completeRaw();
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ship:pre gates not re-checked/);
  });

  test('G16c a capability that failed to load is reported in gate_warnings, so would_refuse [] is not read as clean', () => {
    writeGateCap(home, { command: 'exit 3' });
    const manifest = path.join(home, '.gsd', 'capabilities', 'open-work', 'capability.json');
    const cap = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    cap.engines = { gsd: '>=999.0.0' };
    fs.writeFileSync(manifest, JSON.stringify(cap));
    const { blocked, warnings } = gateResult();
    assert.deepEqual(blocked, []);
    assert.deepEqual(warnings, [{ kind: 'capability_load_failed', capId: 'open-work' }]);
    // The loop-resolver owns the stderr line; the engine adds none for the same capability.
    const r = completeRaw();
    assert.equal(r.exitCode, 0, r.stderr);
    const lines = r.stderr.split('\n');
    assert.equal(lines.filter((l) => /open-work/.test(l) && /failed to load/.test(l)).length, 1, r.stderr);
    assert.ok(!lines.some((l) => /not re-checked: the capability failed to load/.test(l)), r.stderr);
  });

  test('G17 --no-archive-phases still gates the milestone phases', () => {
    writeGateCap(home, { command: 'exit 3' });
    assert.deepEqual(refusal(complete('--no-archive-phases')).blocked.map((b) => b.phase), ['01', '02']);
  });

  test('G18 no phase directories: no gate runs and the close proceeds', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap v1.0 MVP\n');
    cleanup(phaseDir('01-foundation'));
    cleanup(phaseDir('02-build'));
    writeGateCap(home, { command: 'exit 3' });
    assert.deepEqual(wouldRefuse(), []);
    const r = complete();
    assert.equal(r.success, true, r.error);
  });

  test('G19 stdout-only failure surfaces stdout in the refusal', () => {
    writeGateCap(home, { command: 'echo only-stdout; exit 2' });
    assert.equal(refusal(complete()).blocked[0].gate_message, 'command exited 2: only-stdout');
  });

  test('G21 a decimal phase dir yields the token init hands ship.md', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** a\n\n### Phase 1.1: Hotfix\n**Goal:** b\n');
    cleanup(phaseDir('02-build'));
    fs.mkdirSync(phaseDir('01.1-hotfix'), { recursive: true });
    writeGateCap(home, { command: 'echo "${PHASE_NUMBER}" >&2; exit 3' });
    assert.deepEqual(wouldRefuse().map((b) => b.phase), ['01', '01.1']);
  });

  test('G22 a shell-hostile phase dir name never reaches sh -c: halt gate blocks, skip gate warns', () => {
    const marker = path.join(tmpDir, 'pwned');
    // relative marker: a path separator or ':' in a dir name is invalid on Windows
    fs.mkdirSync(phaseDir('03-$(touch pwned)'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), `${GATE_ROADMAP}\n### Phase 3: Hostile\n**Goal:** c\n`);
    writeGateCap(home, { command: 'true ${PHASE_NUMBER}' });
    const halted = gateResult();
    assert.equal(halted.blocked.length, 1);
    assert.match(halted.blocked[0].gate_message, /gate not run/);
    writeGateCap(home, { command: 'true ${PHASE_NUMBER}', onError: 'skip' });
    const skipped = gateResult();
    assert.deepEqual(skipped.blocked, []);
    assert.equal(skipped.warnings[0].kind, 'skipped_phase');
    assert.equal(fs.existsSync(marker), false);
  });

  test('G21b each gated dir carries the phase_number init.phase-op reports for its roadmap phase', () => {
    const scenarios = [
      { ids: ['1', '1.1'], dirs: ['01-foundation', '01.1-hotfix'], phases: '### Phase 1: Foundation\n**Goal:** a\n\n### Phase 1.1: Hotfix\n**Goal:** b\n' },
      { ids: ['1'], dirs: ['CK-01-foundation'], phases: '### Phase 1: Foundation\n**Goal:** a\n' },
      { ids: ['1', '2'], dirs: ['01-foundation', '02-24-7-autonomy'], phases: '### Phase 1: Foundation\n**Goal:** a\n\n### Phase 2: Build\n**Goal:** b\n' },
    ];
    writeGateCap(home, { command: 'echo "${PHASE_NUMBER}" >&2; exit 3' });
    for (const { ids, dirs, phases } of scenarios) {
      for (const d of fs.readdirSync(path.join(tmpDir, '.planning', 'phases'))) cleanup(phaseDir(d));
      for (const d of dirs) fs.mkdirSync(phaseDir(d), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), `# Roadmap v1.0 MVP\n\n${phases}`);
      const expected = ids.map((id) => {
        const r = runGsdTools(['query', 'init.phase-op', id], tmpDir, env());
        assert.equal(r.success, true, r.error);
        const init = JSON.parse(r.output);
        assert.equal(init.phase_found, true, r.output);
        return init.phase_number;
      });
      assert.deepEqual(wouldRefuse().map((b) => b.phase).sort(), expected.sort(), dirs.join(','));
    }
  });

  test('G21c a bracket-convention dir resolves to the roadmap id, the token init.phase-op hands ship.md', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ phase_id_convention: 'bracket' }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## [GSD.02] v1.0\n\n### [GSD.02] 01: Setup\n**Goal:** a\n');
    cleanup(phaseDir('01-foundation'));
    cleanup(phaseDir('02-build'));
    fs.mkdirSync(phaseDir('GSD.02-01-setup'), { recursive: true });
    writeGateCap(home, { command: 'exit 3' });
    const r = runGsdTools(['query', 'init.phase-op', '01'], tmpDir, env());
    assert.equal(r.success, true, r.error);
    assert.deepEqual(wouldRefuse().map((b) => b.phase), [JSON.parse(r.output).phase_number]);
  });

  // A copy of the fixture project under a root named `name` (a parent dir keeps the name verbatim).
  const projectAt = (t, name) => {
    const parent = createTempDir('gsd-5482-root-');
    t.after(() => cleanup(parent));
    const root = path.join(parent, name);
    fs.cpSync(tmpDir, root, { recursive: true });
    return root;
  };

  test('G22b a shell-hostile project root never reaches sh -c: every phase reads gate not run', (t) => {
    const root = projectAt(t, 'r$(touch pwned)');
    writeGateCap(home, { command: 'true "${PHASE_DIR}"' });
    const { blocked } = gateResult('', root);
    assert.deepEqual(blocked.map((b) => b.phase), ['01', '02']);
    for (const b of blocked) assert.match(b.gate_message, /gate not run/);
    assert.equal(fs.existsSync(path.join(root, 'pwned')), false);
  });

  test('G22c ordinary roots still run command gates; hostile roots and dirs read gate not run, never a pass', (t) => {
    writeGateCap(home, { command: 'test ! -f "${PHASE_DIR}/OPEN_WORK" || exit 3' });
    for (const d of ['01-foundation', '02-build']) fs.writeFileSync(path.join(phaseDir(d), 'OPEN_WORK'), '');
    for (const name of ['r with space', 'ré café', "o'brien"]) {
      for (const b of gateResult('', projectAt(t, name)).blocked) assert.match(b.gate_message, /^command exited 3/, name);
    }
    for (const b of gateResult('', projectAt(t, 'r#1')).blocked) assert.match(b.gate_message, /gate not run/);

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), `${GATE_ROADMAP}\n### Phase 3: Hostile\n**Goal:** c\n`);
    fs.mkdirSync(phaseDir('03-x #y'), { recursive: true });
    const byPhase = Object.fromEntries(wouldRefuse().map((b) => [b.phase, b.gate_message]));
    assert.match(byPhase['03'], /gate not run/);
    assert.match(byPhase['01'], /^command exited 3/);

    // Other predicate kinds are not shell-interpolated: a root with parentheses still evaluates.
    fs.writeFileSync(path.join(phaseDir('01-foundation'), '01-OPEN-WORK.md'), '---\nstatus: open\n---\n');
    writeGateCap(home, { predicate: { kind: 'artifact-frontmatter-equals', artifact: 'OPEN-WORK.md', field: 'status', equals: 'closed' } });
    const blocked = gateResult('', projectAt(t, 'r (x)')).blocked;
    assert.ok(blocked.length > 0);
    for (const b of blocked) assert.doesNotMatch(b.gate_message, /gate not run/);
  });

  test('G28 the workflow previews the close and stops on would_refuse before PROJECT.md, tags or archive', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md'), 'utf-8');
    const lines = splitLines(md);
    const pre = lines.findIndex((l) => /milestone\.complete "v\[X\.Y\]" --dry-run(?!.*--release-map)/.test(l));
    assert.ok(pre >= 0, 'a milestone.complete --dry-run preflight line must exist');
    const before = (needle) => lines.findIndex((l) => l.includes(needle));
    assert.ok(pre < before('PROJECT_MD_REVIEW'), 'preflight precedes the PROJECT.md review');
    assert.ok(pre < before('complete-milestone/steps/release-map.md'), 'preflight precedes the release-map tags');
    assert.ok(lines.slice(pre, before('PROJECT_MD_REVIEW')).some((l) => l.includes('would_refuse')), 'the preflight reads would_refuse');
  });

  test('G29 the refusal the workflow matches is the one the command prints', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md'), 'utf-8');
    const para = splitLines(md).find((l) => l.includes('milestone complete refused'));
    assert.ok(para, 'the close step must describe the refusal');
    assert.doesNotMatch(para, /starting/);
    const phrase = para.match(/error contains `([^`]{1,200})`/);
    assert.ok(phrase, 'the paragraph must quote the phrase the error contains');
    writeGateCap(home, { command: 'exit 3' });
    const r = runGsdTools('milestone complete v1.0 --name MVP --confirm', tmpDir, env());
    assert.equal(r.success, false);
    assert.ok(r.error.includes(phrase[1]), r.error);
  });

  test('G30 the unstarted-phase guard and the gate token map read the same milestone window', () => {
    // Free-form ROADMAP (no versioned milestone): the window comes from extractCurrentMilestone for both.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** a\n\n### Phase 2: B\n**Goal:** b\n\n### Phase 3: C\n**Goal:** c\n');
    cleanup(phaseDir('01-foundation'));
    cleanup(phaseDir('02-build'));
    fs.mkdirSync(phaseDir('01-a'), { recursive: true });
    fs.mkdirSync(phaseDir('02-24-7-autonomy'), { recursive: true });
    writeGateCap(home, { command: 'exit 3' });
    assert.deepEqual(refusal(complete('--force')).blocked.map((b) => b.phase), ['01', '02']);
  });

  test('G23 a project-code-prefixed phase dir yields the prefixed token', () => {
    cleanup(phaseDir('01-foundation'));
    fs.mkdirSync(phaseDir('CK-01-foundation'), { recursive: true });
    writeGateCap(home, { command: 'echo "${PHASE_NUMBER}" >&2; exit 3' });
    assert.deepEqual(wouldRefuse().map((b) => b.phase), ['CK-01', '02']);
  });

  test('G24 a dir with no phase token falls back to its whole name as the token', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.0 MVP\n\nNotes.\n\n## v2.0 Next\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    fs.mkdirSync(phaseDir('notes'), { recursive: true });
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != notes' });
    assert.ok(refusal(complete('--force')).blocked.some((b) => b.phase === 'notes'));
  });

  test('G25 --archive-quick with a refusal leaves quick tasks and the planning tree untouched', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick', '260101-abc-task'), { recursive: true });
    writeGateCap(home, { command: 'exit 3' });
    const before = snapshot();
    refusal(complete('--archive-quick'));
    assert.deepEqual(snapshot(), before);
  });

  test('G26 workstream mode: the gate runs over the workstream phase dirs and refuses', () => {
    const ws = seedWorkstream(tmpDir, { name: 'alpha', state: '---\nmilestone: v1.0\n---\n\n# GSD State\n', roadmap: GATE_ROADMAP, active: true });
    for (const d of ['01-foundation', '02-build']) fs.mkdirSync(path.join(ws, 'phases', d), { recursive: true });
    writeGateCap(home, { command: 'exit 3' });
    const err = refusal(complete());
    assert.deepEqual(err.blocked.map((b) => b.phase), ['01', '02']);
    assert.ok(fs.existsSync(path.join(ws, 'phases', '01-foundation')), 'workstream phase dir must not move on refusal');
  });

  test('G27 a phase dir that is a symlink is not enumerated, so no gate runs on it', (t) => {
    const outside = createTempDir('gsd-5482-outside-');
    t.after(() => cleanup(outside));
    cleanup(phaseDir('02-build'));
    fs.symlinkSync(outside, phaseDir('02-build'), 'dir');
    writeGateCap(home, { command: 'exit 3' });
    assert.deepEqual(refusal(complete('--force')).blocked.map((b) => b.phase), ['01']);
    assert.ok(fs.existsSync(outside));
  });
});

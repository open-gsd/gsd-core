// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Milestone
 *
 * Covers: milestone complete command, phases clear command,
 * requirements mark-complete command (regex-global fix), new-milestone
 * workflow verification gate, milestone complete version scoping (#3043).
 */

'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeState(tmpDir, extra = '') {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n${extra}`,
  );
}

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function mkPhaseDir(tmpDir, name, opts = {}) {
  const p = path.join(tmpDir, '.planning', 'phases', name);
  fs.mkdirSync(p, { recursive: true });
  if (opts.plan) fs.writeFileSync(path.join(p, `${name.split('-')[0]}-01-PLAN.md`), '# Plan\n');
  if (opts.oneLiner) {
    fs.writeFileSync(
      path.join(p, `${name.split('-')[0]}-01-SUMMARY.md`),
      `---\none-liner: ${opts.oneLiner}\n---\n# Summary\n`,
    );
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('preserves current_phase frontmatter through milestone complete (#2111)', () => {
    // Seed STATE.md mid-phase-19: the real current_phase lives in frontmatter
    // and the only body phase source is the `Phase:` prose line (no explicit
    // `Current Phase:` field — matching what milestoneCompleteCore writes).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ncurrent_phase: "19"\n---\n# State\n\n**Status:** In progress\n` +
      `**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n\n` +
      `## Current Position\n\nPhase: 19 — EXECUTING\nPlan: 1 of 1\n` +
      `Status: Executing\nLast activity: 2025-01-01 — Running phase\n`,
    );
    // No ROADMAP.md — mirrors 'handles missing ROADMAP.md gracefully' so the
    // milestone-phase-filter guard never fires.

    const result = runGsdTools('milestone complete v0.5 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = parseFrontmatter(state);
    // Fails pre-migration: the unanchored parser mined "5" from
    // "Phase: Milestone v0.5 complete" and clobbered current_phase.
    assert.strictEqual(
      fm.current_phase, '19',
      `current_phase must be preserved across milestone complete, not mined from ` +
      `the version string (#2111); got ${JSON.stringify(fm.current_phase)}`,
    );
  });

  test('archives roadmap, requirements, creates MILESTONES.md', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] User auth\n- [ ] Dashboard\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    const result = runGsdTools('milestone complete v1.0 --name MVP Foundation', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    assert.strictEqual(output.phases, 1);
    assert.ok(output.archived.roadmap, 'roadmap should be archived');
    assert.ok(output.archived.requirements, 'requirements should be archived');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md')),
      'archived roadmap should exist',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md')),
      'archived requirements should exist',
    );
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')));
    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v1.0 MVP Foundation'));
    assert.ok(milestones.includes('Set up project infrastructure'));
  });

  test('prepends to existing MILESTONES.md (reverse chronological)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v0.9 Alpha (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Beta', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v0.9 Alpha'));
    assert.ok(milestones.includes('v1.0 Beta'));
    assert.ok(milestones.indexOf('v1.0 Beta') < milestones.indexOf('v0.9 Alpha'), 'new entry before old');
  });

  test('three sequential completions maintain reverse-chronological order', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v1.0 First (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.1\n`);
    writeState(tmpDir);

    assert.ok(runGsdTools('milestone complete v1.1 --name Second', tmpDir).success);
    writeRoadmap(tmpDir, `# Roadmap v1.2\n`);
    assert.ok(runGsdTools('milestone complete v1.2 --name Third', tmpDir).success);

    const m = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    const [i10, i11, i12] = ['v1.0 First', 'v1.1 Second', 'v1.2 Third'].map(s => m.indexOf(s));
    assert.ok(i10 !== -1 && i11 !== -1 && i12 !== -1);
    assert.ok(i12 < i11, 'v1.2 before v1.1');
    assert.ok(i11 < i10, 'v1.1 before v1.0');
  });

  test('archives phase directories with --archive-phases flag', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    const result = runGsdTools('milestone complete v1.0 --name MVP --archive-phases', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archived.phases, true, 'phases should be archived');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')));
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation')));
  });

  test('archived REQUIREMENTS.md contains archive header', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] **TEST-01**: core.cjs has tests\n- [ ] **TEST-02**: more tests\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    assert.ok(runGsdTools('milestone complete v1.0 --name MVP', tmpDir).success);

    const archivedReq = fs.readFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md'), 'utf-8',
    );
    assert.ok(archivedReq.includes('Requirements Archive: v1.0'));
    assert.ok(archivedReq.includes('SHIPPED'));
    assert.ok(archivedReq.includes('Archived:'));
    assert.ok(archivedReq.includes('# Requirements'));
    assert.ok(archivedReq.includes('**TEST-01**'));
  });

  test('STATE.md gets updated during milestone complete', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_updated, true);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('v1.0 milestone complete'));
    assert.ok(state.includes('v1.0 milestone completed and archived'));
  });

  test('normalizes stale STATE.md narrative tails after milestone complete (#3088)', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n\n## Current Position\n\nPhase: 03 — EXECUTING\nPlan: 03-02\nStatus: Executing\nLast activity: 2025-01-01 — Running phase\n\n## Operator Next Steps\n\n- Re-run /gsd:complete-milestone v1.0\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('Phase: Milestone v1.0 complete'));
    assert.ok(state.includes('Status: Awaiting next milestone'));
    assert.ok(!state.includes('Re-run /gsd:complete-milestone'));
    assert.ok(state.includes('/gsd-new-milestone'));
  });

  test('appends canonical narrative sections when STATE.md headings are missing (#3088)', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('## Current Position'));
    assert.ok(state.includes('Phase: Milestone v1.0 complete'));
    assert.ok(state.includes('## Operator Next Steps'));
    assert.ok(state.includes('/gsd-new-milestone'));
  });

  test('handles missing ROADMAP.md gracefully', () => {
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name NoRoadmap', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archived.roadmap, false);
    assert.strictEqual(output.archived.requirements, false);
    assert.strictEqual(output.milestones_updated, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')));
  });

  test('scopes stats to current milestone phases only', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.1\n\n### Phase 3: New Feature\n**Goal:** Build it\n\n### Phase 4: Polish\n**Goal:** Ship it\n`,
    );
    writeState(tmpDir);

    // Previous milestone phases — must be excluded
    mkPhaseDir(tmpDir, '01-old-setup', { plan: true, oneLiner: 'Old setup work' });
    mkPhaseDir(tmpDir, '02-old-core', { plan: true, oneLiner: 'Old core work' });
    // Current milestone phases
    mkPhaseDir(tmpDir, '03-new-feature', { plan: true, oneLiner: 'Built new feature' });
    const p4 = path.join(tmpDir, '.planning', 'phases', '04-polish');
    fs.mkdirSync(p4, { recursive: true });
    fs.writeFileSync(path.join(p4, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(p4, '04-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(p4, '04-01-SUMMARY.md'), '---\none-liner: Polished UI\n---\n# Summary\n');

    const result = runGsdTools('milestone complete v1.1 --name "Second Release"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 2, 'should count only phases 3 and 4');
    assert.strictEqual(output.plans, 3, 'should count only plans from phases 3 and 4');
    assert.ok(output.accomplishments.includes('Built new feature'));
    assert.ok(output.accomplishments.includes('Polished UI'));
    assert.ok(!output.accomplishments.includes('Old setup work'));
    assert.ok(!output.accomplishments.includes('Old core work'));
  });

  test('archive-phases only archives current milestone phases', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.1\n\n### Phase 2: Current Work\n**Goal:** Do it\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-old', { plan: true });
    mkPhaseDir(tmpDir, '02-current', { plan: true });

    assert.ok(runGsdTools('milestone complete v1.1 --name Test --archive-phases', tmpDir).success);

    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.1-phases', '02-current')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-old')));
  });

  test('phase 1 in roadmap does NOT match directory 10-something (no prefix collision)', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { plan: true, oneLiner: 'Foundation work' });
    mkPhaseDir(tmpDir, '10-scaling', { plan: true, oneLiner: 'Scaling work' });

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 1, 'should count only phase 1, not phase 10');
    assert.strictEqual(output.plans, 1);
    assert.ok(output.accomplishments.includes('Foundation work'));
    assert.ok(!output.accomplishments.includes('Scaling work'));
  });

  test('non-numeric directory is excluded when milestone scoping is active', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Core\n**Goal:** Build core\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-core', { plan: true });
    const misc = path.join(tmpDir, '.planning', 'phases', 'notes');
    fs.mkdirSync(misc, { recursive: true });
    fs.writeFileSync(path.join(misc, 'PLAN.md'), '# Not a phase\n');

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 1);
    assert.strictEqual(output.plans, 1);
  });

  test('large phase numbers (456, 457) scope correctly', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.49\n\n### Phase 456: DACP\n**Goal:** Ship DACP\n\n### Phase 457: Integration\n**Goal:** Integrate\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '456-dacp', { plan: true });
    mkPhaseDir(tmpDir, '457-integration', { plan: true });
    mkPhaseDir(tmpDir, '45-old', { plan: true });

    const result = runGsdTools('milestone complete v1.49 --name DACP', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).phases, 2);
  });

  test('counts tasks from **Tasks:** N in summary body', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Built the foundation\n---\n\n# Phase 1: Foundation Summary\n\n**Built the foundation**\n\n## Performance\n\n- **Duration:** 28 min\n- **Tasks:** 7\n- **Files modified:** 12\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).tasks, 7);
  });

  test('extracts one-liner from body when not in frontmatter', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\nphase: "01"\n---\n\n# Phase 1: Foundation Summary\n\n**JWT auth with refresh rotation using jose library**\n\n## Performance\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success);
    assert.ok(JSON.parse(result.output).accomplishments.includes('JWT auth with refresh rotation using jose library'));
  });

  test('updates STATE.md with plain format fields', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\nStatus: In progress\nLast Activity: 2025-01-01\nLast Activity Description: Working\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success);
    assert.ok(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8').includes('v1.0 milestone complete'));
  });

  test('handles empty phases directory', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name EmptyPhases', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 0);
    assert.strictEqual(output.plans, 0);
    assert.strictEqual(output.tasks, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phases clear command
// ─────────────────────────────────────────────────────────────────────────────

describe('phases clear command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('deletes normal phase directories when --confirm is passed', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 1);
    assert.ok(!fs.existsSync(p1));
  });

  test('requires --confirm when phase directories exist', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    assert.ok(!runGsdTools('phases clear', tmpDir).success);
  });

  test('preserves 999.x backlog phase directories during clear (#1853)', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const p999a = path.join(tmpDir, '.planning', 'phases', '999.1-some-idea');
    const p999b = path.join(tmpDir, '.planning', 'phases', '999.2-another-idea');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p999a, { recursive: true });
    fs.mkdirSync(p999b, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(p999a, 'PLAN.md'), '# Backlog\n');
    fs.writeFileSync(path.join(p999b, 'PLAN.md'), '# Backlog 2\n');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 1);
    assert.ok(!fs.existsSync(p1));
    assert.ok(fs.existsSync(p999a));
    assert.ok(fs.existsSync(p999b));
  });

  test('reports 0 cleared when only backlog phases exist', () => {
    const p999a = path.join(tmpDir, '.planning', 'phases', '999.1-idea');
    fs.mkdirSync(p999a, { recursive: true });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 0);
    assert.ok(fs.existsSync(p999a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements mark-complete command — regex global-state fix (#milestone-regex-global)
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements mark-complete command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content, 'utf-8');
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  const STANDARD_REQUIREMENTS = `# Requirements

## Test Coverage
- [ ] **TEST-01**: core.cjs has tests for loadConfig
- [ ] **TEST-02**: core.cjs has tests for resolveModelInternal
- [x] **TEST-03**: core.cjs has tests for escapeRegex (already complete)

## Bug Regressions
- [ ] **REG-01**: Test confirms loadConfig returns model_overrides

## Infrastructure
- [ ] **INFRA-01**: GitHub Actions workflow runs tests

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEST-01 | Phase 1 | Pending |
| TEST-02 | Phase 1 | Pending |
| TEST-03 | Phase 1 | Complete |
| REG-01 | Phase 1 | Pending |
| INFRA-01 | Phase 6 | Pending |
`;

  // #2140: a traceability table EXISTS but has no row for the ID being completed.
  // Only the checkbox can reconcile; the table surface is unsynced. The CLI must
  // not report this as a payload indistinguishable from a full reconcile.
  const TABLE_WITHOUT_FOO = `# Requirements

## Coverage
- [ ] **FOO-01**: feature one
- [ ] **BAR-01**: feature two

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BAR-01 | Phase 1 | Pending |
`;

  test('#2140 checkbox-only reconcile surfaces table_unmatched (not silent success)', () => {
    writeRequirements(tmpDir, TABLE_WITHOUT_FOO);

    const result = runGsdTools('requirements mark-complete FOO-01', tmpDir);
    assert.ok(result.success);

    const out = JSON.parse(result.output);
    // The checkbox WAS written, so it is in marked_complete...
    assert.ok(out.marked_complete.includes('FOO-01'), 'checkbox reconcile is reported');
    // ...but the traceability table had no FOO-01 row, which must be surfaced.
    assert.ok(Array.isArray(out.table_unmatched), 'table_unmatched bucket must exist');
    assert.ok(out.table_unmatched.includes('FOO-01'),
      'an ID with a checkbox but no table row must be surfaced as table_unmatched');

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **FOO-01**'), 'checkbox should be checked');
    // The table is untouched (no FOO-01 row synthesized).
    assert.ok(!content.includes('FOO-01 | Phase'), 'no FOO-01 row should be invented');
  });

  test('#2140 re-run on the half-written file does NOT mask the drift as already_complete', () => {
    writeRequirements(tmpDir, TABLE_WITHOUT_FOO);
    // First run: flips the checkbox, surfaces table_unmatched.
    runGsdTools('requirements mark-complete FOO-01', tmpDir);
    // Second run on the now-[x]-checkbox-with-no-row file.
    const result = runGsdTools('requirements mark-complete FOO-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);

    assert.ok(!out.already_complete.includes('FOO-01'),
      'a [x] checkbox with no table row is PARTIALLY reconciled, not already_complete');
    assert.ok(!out.marked_complete.includes('FOO-01'),
      'nothing flipped on re-run, so not marked_complete');
    assert.ok(out.table_unmatched.includes('FOO-01'),
      'the drift must still be surfaced as table_unmatched on re-run');
  });

  test('#2140 no traceability table at all → still a clean success (no table_unmatched)', () => {
    // A REQUIREMENTS.md with no traceability table is legitimate; a checkbox-only
    // reconcile must remain an unqualified success with no table_unmatched entry.
    writeRequirements(tmpDir, '# Requirements\n\n- [ ] **NO-TABLE-01**: thing\n');
    const result = runGsdTools('requirements mark-complete NO-TABLE-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.ok(out.marked_complete.includes('NO-TABLE-01'));
    assert.ok(!out.table_unmatched || !out.table_unmatched.includes('NO-TABLE-01'),
      'no table_unmatched when there is no traceability table');
  });

  test('marks single requirement complete (checkbox + table)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.ok(output.marked_complete.includes('TEST-01'));

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'), 'checkbox should be checked');
    assert.ok(content.includes('| TEST-01 | Phase 1 | Complete |'), 'table row should be Complete');
    assert.ok(content.includes('- [ ] **TEST-02**'), 'TEST-02 should remain unchecked');
  });

  test('handles mixed prefixes in single call (TEST-XX, REG-XX, INFRA-XX)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01,REG-01,INFRA-01', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.marked_complete.length, 3);
    assert.ok(output.marked_complete.includes('TEST-01'));
    assert.ok(output.marked_complete.includes('REG-01'));
    assert.ok(output.marked_complete.includes('INFRA-01'));

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **REG-01**'));
    assert.ok(content.includes('- [x] **INFRA-01**'));
    assert.ok(content.includes('| TEST-01 | Phase 1 | Complete |'));
    assert.ok(content.includes('| REG-01 | Phase 1 | Complete |'));
    assert.ok(content.includes('| INFRA-01 | Phase 6 | Complete |'));
  });

  test('accepts space-separated IDs', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01 TEST-02', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).marked_complete.length, 2);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **TEST-02**'));
  });

  test('accepts bracket-wrapped IDs [REQ-01, REQ-02]', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete [TEST-01,TEST-02]', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).marked_complete.length, 2);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **TEST-02**'));
  });

  test('returns not_found for invalid IDs while updating valid ones', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01,FAKE-99', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.ok(output.marked_complete.includes('TEST-01'));
    assert.ok(output.not_found.includes('FAKE-99'));
    assert.strictEqual(output.total, 2);
  });

  test('idempotent — re-marking already-complete requirement does not corrupt', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-03', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.ok(output.already_complete.includes('TEST-03'));
    assert.deepStrictEqual(output.not_found, []);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-03**'));
    assert.ok(!content.includes('[xx]'));
    assert.ok(!content.includes('- [x] [x]'));
  });

  test('returns already_complete for idempotent calls on completed requirements', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const output = JSON.parse(runGsdTools('requirements mark-complete TEST-03', tmpDir).output);
    assert.deepStrictEqual(output.already_complete, ['TEST-03']);
    assert.deepStrictEqual(output.not_found, []);
  });

  test('mixed: updates pending, reports already-complete, and flags missing', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const output = JSON.parse(
      runGsdTools('requirements mark-complete TEST-01,TEST-03,FAKE-99', tmpDir).output,
    );
    assert.deepStrictEqual(output.marked_complete, ['TEST-01']);
    assert.deepStrictEqual(output.already_complete, ['TEST-03']);
    assert.deepStrictEqual(output.not_found, ['FAKE-99']);
  });

  test('missing REQUIREMENTS.md returns expected error structure', () => {
    const output = JSON.parse(runGsdTools('requirements mark-complete TEST-01', tmpDir).output);
    assert.strictEqual(output.updated, false);
    assert.strictEqual(output.reason, 'REQUIREMENTS.md not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone.cjs regex global-state fix (structural regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone.cjs regex global state fix', () => {
  // allow-test-rule: structural-regression-guard
  // milestone.cjs must use replace()+compare, not test()+replace(), to avoid
  // regex lastIndex corruption with global flags.
  const MILESTONE_SRC = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'milestone.cjs');
  let src;

  before(() => { src = fs.readFileSync(MILESTONE_SRC, 'utf-8'); });

  test('checkbox update uses replace() + compare, not test() + replace()', () => {
    const funcBody = src.slice(
      src.indexOf('function cmdRequirementsMarkComplete'),
      src.indexOf('function cmdMilestoneComplete'),
    );
    assert.ok(!funcBody.includes('checkboxPattern.test(reqContent)'));
    assert.ok(
      funcBody.includes('afterCheckbox !== reqContent') ||
      funcBody.includes('afterCheckbox!==reqContent'),
    );
  });

  test('table update uses replace() + compare, not test() + replace()', () => {
    const funcBody = src.slice(
      src.indexOf('function cmdRequirementsMarkComplete'),
      src.indexOf('function cmdMilestoneComplete'),
    );
    assert.ok(!funcBody.includes('tablePattern.test(reqContent)'));
    assert.ok(
      funcBody.includes('afterTable !== reqContent') ||
      funcBody.includes('afterTable!==reqContent'),
    );
  });

  test('done-check regexes use non-global flag (only need existence check)', () => {
    const funcBody = src.slice(
      src.indexOf('function cmdRequirementsMarkComplete'),
      src.indexOf('function cmdMilestoneComplete'),
    );
    const doneCheckboxMatch = funcBody.match(/doneCheckbox\s*=\s*new RegExp\([^)]+,\s*'([^']+)'\)/);
    const doneTableMatch = funcBody.match(/doneTable\s*=\s*new RegExp\([^)]+,\s*'([^']+)'\)/);
    assert.ok(doneCheckboxMatch, 'doneCheckbox regex should exist');
    assert.ok(doneTableMatch, 'doneTable regex should exist');
    assert.ok(!doneCheckboxMatch[1].includes('g'));
    assert.ok(!doneTableMatch[1].includes('g'));
  });

  test('no duplicate regex construction for the same pattern', () => {
    const funcBody = src.slice(
      src.indexOf('function cmdRequirementsMarkComplete'),
      src.indexOf('function cmdMilestoneComplete'),
    );
    const tableConstructions = funcBody.split('\n').filter(
      line => line.includes('tablePattern') && line.includes('new RegExp'),
    );
    assert.ok(tableConstructions.length <= 1, `Expected ≤1 tablePattern construction, got ${tableConstructions.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// new-milestone workflow verification gate (#1269)
// ─────────────────────────────────────────────────────────────────────────────

describe('new-milestone workflow verification gate', () => {
  test('new-milestone workflow has verification step before writing PROJECT.md', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    assert.ok(content.includes('Verify Milestone Understanding'));
    const verifyIdx = content.indexOf('Verify Milestone Understanding');
    const updateIdx = content.indexOf('## 4. Update PROJECT.md');
    assert.ok(verifyIdx > 0);
    assert.ok(updateIdx > 0);
    assert.ok(verifyIdx < updateIdx);
  });

  test('verification step uses AskUserQuestion with adjust loop', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    const section = content.slice(content.indexOf('## 3.5'), content.indexOf('## 4.'));
    assert.ok(section.includes('AskUserQuestion'));
    assert.ok(section.includes('Adjust'));
    assert.ok(section.includes('Looks good'));
    assert.ok(
      section.includes('Loop until') || section.includes('loop until') || section.includes('re-present'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete respects explicit version scope (#3043)
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete explicit version scope (#3043)', () => {
  test('milestone.complete v3.6 uses v3.6 phases even when STATE milestone is v3.5', () => {
    const tmpDir = createTempProject('gsd-bug-3043-');
    try {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v3.5\n---\n');
      writeRoadmap(
        tmpDir,
        '# Roadmap\n\n## 🚧 v3.5 Paused\n### Phase 103: old\n### Phase 104: old2\n\n## 🚧 v3.6 Current\n### Phase 108: new\n',
      );
      fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

      for (const [dir, liner] of [['103.old', 'old milestone A'], ['104.old', 'old milestone B'], ['108.new', 'new milestone']]) {
        const p = path.join(tmpDir, '.planning', 'phases', dir);
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'SUMMARY.md'), `one-liner: ${liner}\n\n## Summary\n${liner.split(' ')[0]}\n`);
      }

      const result = runGsdTools(['milestone', 'complete', 'v3.6', '--raw'], tmpDir);
      assert.equal(result.success, true, result.error || result.output);
      const payload = JSON.parse(result.output);
      assert.equal(payload.version, 'v3.6');
      assert.equal(payload.phases, 1, `expected 1 phase for v3.6, got ${payload.phases}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('milestone.complete fails when explicit milestone version resolves no phases', () => {
    const tmpDir = createTempProject('gsd-bug-3043-empty-');
    try {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.0\n---\n');
      writeRoadmap(tmpDir, '# Roadmap\n\n## 🚧 v1.0\n### Phase 1: foundation\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

      const result = runGsdTools(['milestone', 'complete', 'v9.9', '--raw'], tmpDir);
      assert.equal(result.success, false, 'expected command to fail when no phases match explicit version');
      assert.match(result.error || '', /no phases|phase/i);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1911: milestone complete --ws must archive to the workstream, not root
// ─────────────────────────────────────────────────────────────────────────────

describe('#1911 — milestone complete --ws archives to the workstream', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => cleanup(tmpDir));

  test('--ws archives roadmap/requirements into the workstream milestones dir, not root', () => {
    const wsBase = path.join(tmpDir, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(path.join(wsBase, 'phases', '01-foo'), { recursive: true });
    fs.writeFileSync(path.join(wsBase, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(
      path.join(wsBase, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n- v2.0 Test (Phases 1) — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n',
    );
    fs.writeFileSync(path.join(wsBase, 'REQUIREMENTS.md'), '# Requirements\n- [ ] REQ-01\n');
    fs.writeFileSync(path.join(wsBase, 'phases', '01-foo', '01-SUMMARY.md'), '---\none-liner: foo done\n---\n# Summary\n');
    // Root milestones dir pre-exists; it must NOT receive the workstream archive.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });

    const result = runGsdTools('milestone complete v2.0 --ws ws1 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Archive lands inside the workstream.
    assert.ok(
      fs.existsSync(path.join(wsBase, 'milestones', 'v2.0-ROADMAP.md')),
      'v2.0-ROADMAP.md should be archived into the workstream milestones dir',
    );
    assert.ok(
      fs.existsSync(path.join(wsBase, 'milestones', 'v2.0-REQUIREMENTS.md')),
      'v2.0-REQUIREMENTS.md should be archived into the workstream milestones dir',
    );
    // And NOT in root.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-ROADMAP.md')),
      'must not archive to root .planning/milestones/ in workstream mode',
    );
  });

  test('#1993 — --ws requirements archive header points at the workstream REQUIREMENTS.md, not root', () => {
    const wsBase = path.join(tmpDir, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(path.join(wsBase, 'phases', '01-foo'), { recursive: true });
    fs.writeFileSync(path.join(wsBase, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(
      path.join(wsBase, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n- v2.0 Test (Phases 1) — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n',
    );
    fs.writeFileSync(path.join(wsBase, 'REQUIREMENTS.md'), '# Requirements\n- [ ] REQ-01\n');
    fs.writeFileSync(path.join(wsBase, 'phases', '01-foo', '01-SUMMARY.md'), '---\none-liner: foo done\n---\n# Summary\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });

    const result = runGsdTools('milestone complete v2.0 --ws ws1 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const archivedReq = fs.readFileSync(
      path.join(wsBase, 'milestones', 'v2.0-REQUIREMENTS.md'), 'utf-8',
    );
    // Header must point readers at the WORKSTREAM requirements file...
    assert.ok(
      archivedReq.includes('see `.planning/workstreams/ws1/REQUIREMENTS.md`'),
      `workstream archive header must reference the workstream path; got:\n${archivedReq.split(/\r?\n/).slice(0, 6).join('\n')}`,
    );
    // ...and must NOT point at the root path (the #1993 bug).
    assert.ok(
      !/\bsee\s+`\.planning\/REQUIREMENTS\.md`\b/.test(archivedReq),
      'workstream archive header must not hardcode the root REQUIREMENTS.md path',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1871: milestone complete archives phase dirs by default
// ─────────────────────────────────────────────────────────────────────────────

describe('#1871 — milestone complete archives phase dirs by default', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => cleanup(tmpDir));

  function seedCompletableMilestone() {
    writeRoadmap(tmpDir, '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n- [ ] x\n');
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });
  }

  test('archives phase dirs by default (no --archive-phases flag needed)', () => {
    seedCompletableMilestone();
    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.archived.phases, 'phases should be archived by default');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'phase dir should be archived under milestones/v1.0-phases/',
    );
  });

  test('--no-archive-phases opts out of default archiving', () => {
    seedCompletableMilestone();
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const result = runGsdTools('milestone complete v1.0 --name MVP --no-archive-phases', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(!out.archived.phases, 'phases should NOT be archived with --no-archive-phases');
    assert.ok(fs.existsSync(phaseDir), 'phase dir should remain in place with --no-archive-phases');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-978-milestone-complete-force.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-978-milestone-complete-force (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for bug #978: `gsd-tools milestone complete --force` was a
 * dead flag.  The milestone source (src/milestone.cts) has a guard that checks
 * `options.force` and tells users to "Re-run with --force to override", but the
 * CLI dispatcher (gsd-core/bin/gsd-tools.cjs) never parsed `--force` and never
 * passed it into the options object.  So `options.force` was always `undefined`
 * and the guard could never be overridden regardless of what the user typed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Build a fixture where the guard will fire:
 *  - STATE.md has `milestone: <version>` so the guard's version-match check is
 *    satisfied.
 *  - ROADMAP.md lists a `### Phase 2: Real Work` heading for that milestone, but
 *    there is NO on-disk phase directory for it.
 *
 * This guarantees "unstarted phase" detection without touching any real phases.
 * NOTE: the unstarted phase must be a REAL phase number — Phase 0 and Phase 999
 * are backlog/pre-milestone sentinels that are intentionally excluded from this
 * guard (#1580), so they would not fire it.
 */
function makeGuardFixture(tmpDir, version) {
  // STATE.md with frontmatter milestone field matching the version
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nmilestone: ${version}\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
  );

  // ROADMAP.md — the heading must include the version so getMilestonePhaseFilter
  // does not return missingExplicitVersion.  Phase 2 has no on-disk dir.
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap ${version}\n\n### Phase 2: Real Work\n**Goal:** Not started\n`,
  );
}

describe('bug-978: milestone complete --force overrides unstarted-phase guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-978-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('without --force the guard fires and emits the documented error message', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test'],
      tmpDir,
    );

    assert.strictEqual(result.success, false, 'command should fail without --force');
    assert.ok(
      result.error.includes('Re-run with --force to override'),
      `expected guard error message; got: ${result.error}`,
    );
  });

  test('with --force the guard is bypassed and the command succeeds', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test', '--force'],
      tmpDir,
    );

    assert.ok(
      result.success,
      `command should succeed with --force but failed: ${result.error}`,
    );

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    // Milestone entry should have been created even though phase 2 has no dir
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should have been created',
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2660-one-liner-extraction.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2660-one-liner-extraction (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #2660: `gsd-tools milestone complete <version>` writes MILESTONES.md
 * bullets that read "- One-liner:" (the literal label) instead of the prose
 * after the label.
 *
 * Root cause: extractOneLinerFromBody() matches the first **...** span. In
 * `**One-liner:** prose`, the first span contains only `One-liner:` so the
 * function returns the label instead of the prose after it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { extractOneLinerFromBody } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'core-utils.cjs')
);

describe('bug #2660: extractOneLinerFromBody', () => {
  test('a) body-style **One-liner:** label returns prose after the label', () => {
    const content =
      '# Phase 2 Plan 01: Foundation Summary\n\n**One-liner:** Real prose here.\n';
    assert.strictEqual(extractOneLinerFromBody(content), 'Real prose here.');
  });

  test('b) frontmatter-only one-liner returns null (caller handles frontmatter)', () => {
    const content =
      '---\none-liner: Set up project\n---\n\n# Phase 1: Foundation Summary\n\nBody prose with no bold line.\n';
    assert.strictEqual(extractOneLinerFromBody(content), null);
  });

  test('c) no one-liner at all returns null', () => {
    const content =
      '# Phase 1: Foundation Summary\n\nJust some narrative, no bold line.\n';
    assert.strictEqual(extractOneLinerFromBody(content), null);
  });

  test('d) bold spans inside the prose are preserved', () => {
    const content =
      '# Phase 1: Foundation Summary\n\n**One-liner:** This is **important** stuff.\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'This is **important** stuff.'
    );
  });

  test('e) empty prose after label returns null (no bogus bullet)', () => {
    const empty =
      '# Phase 1: Foundation Summary\n\n**One-liner:**\n\nRest of body.\n';
    const whitespace =
      '# Phase 1: Foundation Summary\n\n**One-liner:**   \n\nRest of body.\n';
    assert.strictEqual(extractOneLinerFromBody(empty), null);
    assert.strictEqual(extractOneLinerFromBody(whitespace), null);
  });

  test('f) legacy bare **prose** format still works (no label, no colon)', () => {
    // Preserve pre-existing behavior: SUMMARY files historically used
    // `**bold prose**` with no label. See tests/commands.test.cjs:366 and
    // tests/milestone.test.cjs:451 — both assert this form.
    const content =
      '---\nphase: "01"\n---\n\n# Phase 1: Foundation Summary\n\n**JWT auth with refresh rotation using jose library**\n\n## Performance\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'JWT auth with refresh rotation using jose library'
    );
  });

  test('g) other **Label:** prefixes (e.g. Summary:) also capture prose after label', () => {
    const content =
      '# Phase 1: Foundation Summary\n\n**Summary:** Built the thing.\n';
    assert.strictEqual(extractOneLinerFromBody(content), 'Built the thing.');
  });

  test('h) CRLF line endings (Windows) are handled', () => {
    const content =
      '---\r\nphase: "01"\r\n---\r\n\r\n# Phase 1: Foundation Summary\r\n\r\n**One-liner:** Windows-authored prose.\r\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'Windows-authored prose.'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-72-business-context.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-72-business-context (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product (see #72)
// The PROJECT.md template + complete-milestone workflow .md ARE the product surface
// the runtime loads; asserting on their text tests the deployed contract directly.
/**
 * Enhancement #72 — optional Business Context section in the PROJECT.md template.
 *
 * Contract tests over the product-text surfaces (template + milestone workflow .md):
 * the template offers a Business Context section that is explicitly OPTIONAL, capped
 * at the four approved one-line fields, and the milestone evolution review treats it
 * as conditional so non-business projects that deleted it are never forced to review it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'gsd-core', 'templates', 'project.md');
const COMPLETE_MILESTONE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md');

function parseTemplateContract(content) {
  const lines = content.split(/\r?\n/);
  const lower = content.toLowerCase();
  // The Business Context block lives between its heading and the next "## " heading.
  const startIdx = lines.findIndex(l => l.trim() === '## Business Context');
  let sectionBody = '';
  if (startIdx !== -1) {
    const rest = lines.slice(startIdx + 1);
    const endOffset = rest.findIndex(l => l.startsWith('## '));
    sectionBody = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
  }
  const fieldOf = (label) => new RegExp(`^- \\*\\*${label}\\*\\*:`, 'm').test(sectionBody);
  return {
    hasSection: startIdx !== -1,
    // Optional-by-default: an HTML comment tells non-business projects to delete it.
    hasOptionalMarker: /<!--\s*OPTIONAL/i.test(sectionBody) && /delete this section/i.test(sectionBody),
    fields: {
      customer: fieldOf('Customer'),
      revenueModel: fieldOf('Revenue model'),
      successMetric: fieldOf('Success metric'),
      strategyNotes: fieldOf('Strategy notes'),
    },
    fieldCount: (sectionBody.match(/^- \*\*/gm) || []).length,
    // Positioned between Core Value and Requirements.
    orderedBetweenCoreValueAndRequirements:
      lower.indexOf('## core value') < lower.indexOf('## business context') &&
      lower.indexOf('## business context') < lower.indexOf('## requirements'),
    hasGuidelinesEntry: /\*\*Business Context:\*\*/.test(content),
  };
}

function parseMilestoneContract(content) {
  const lower = content.toLowerCase();
  const lines = content.split(/\r?\n/);
  const reviewLine = lines.find(l =>
    l.toLowerCase().includes('business context') &&
    (l.toLowerCase().includes('if present') || l.toLowerCase().includes('only if')),
  );
  return {
    mentionsBusinessContext: lower.includes('business context'),
    hasConditionalReview: Boolean(reviewLine),
  };
}

describe('enhancement #72 — Business Context template section', () => {
  const tpl = parseTemplateContract(fs.readFileSync(TEMPLATE, 'utf-8'));

  test('template includes a Business Context section', () => {
    assert.ok(tpl.hasSection, 'template must contain a "## Business Context" section');
  });

  test('section is marked OPTIONAL with delete-for-non-business guidance', () => {
    assert.ok(tpl.hasOptionalMarker, 'section must carry an OPTIONAL HTML comment telling non-business projects to delete it');
  });

  test('section carries exactly the four approved one-line fields', () => {
    assert.ok(tpl.fields.customer, 'missing **Customer** field');
    assert.ok(tpl.fields.revenueModel, 'missing **Revenue model** field');
    assert.ok(tpl.fields.successMetric, 'missing **Success metric** field');
    assert.ok(tpl.fields.strategyNotes, 'missing **Strategy notes** field');
    assert.strictEqual(tpl.fieldCount, 4, 'section is capped at four fields (constraint reference, not a business plan)');
  });

  test('section is positioned between Core Value and Requirements', () => {
    assert.ok(tpl.orderedBetweenCoreValueAndRequirements, 'Business Context must sit between Core Value and Requirements');
  });

  test('guidelines document the Business Context section', () => {
    assert.ok(tpl.hasGuidelinesEntry, 'guidelines block must include a **Business Context:** entry');
  });

  test('milestone evolution reviews Business Context only when present', () => {
    const ms = parseMilestoneContract(fs.readFileSync(COMPLETE_MILESTONE, 'utf-8'));
    assert.ok(ms.mentionsBusinessContext, 'complete-milestone must mention Business Context in its review');
    assert.ok(ms.hasConditionalReview, 'the Business Context milestone review must be conditional on the section being present');
  });
});
  });
}

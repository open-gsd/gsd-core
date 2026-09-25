'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup, toPosixPath } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { extractCurrentMilestone } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const projects = new Set();

afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function project(prefix = 'adr-612-write-') {
  const dir = createTempProject(prefix);
  projects.add(dir);
  return dir;
}

function gitProject(prefix) {
  const dir = createFixture({ prefix, git: true });
  projects.add(dir);
  return dir;
}

function planning(dir, ...parts) {
  return path.join(dir, '.planning', ...parts);
}

function writeConfig(dir, phaseIdConvention) {
  fs.writeFileSync(
    planning(dir, 'config.json'),
    JSON.stringify({ project_code: 'CK', phase_id_convention: phaseIdConvention }, null, 2) + '\n',
  );
}

function writeBracketFixture(dir) {
  writeConfig(dir, 'bracket');
  fs.writeFileSync(
    planning(dir, 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.0',
      'milestone_name: Foundation',
      'status: planning',
      'last_activity_desc: Roadmap created',
      '---',
      '',
      '# Project State',
      '',
      '**Current focus:** Pending',
      '**Status:** Planning',
      '**Current Phase:** 01',
      '**Current Phase Name:** Foundation',
      '**Current Plan:** 1',
      '**Total Plans in Phase:** 1',
      '**Last Activity:** 2026-09-01',
      '**Last Activity Description:** Roadmap created',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foundation) — READY TO PLAN',
      'Plan: 1 of 1',
      'Status: Planning',
      'Last activity: 2026-09-01 — Roadmap created',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    planning(dir, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## [CK.02] v2.0 — Foundation',
      '',
      '### [CK.02] 01: Foundation',
      '',
      '**Goal:** Existing',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-foundation'), { recursive: true });
}

function writeEmptyBracketFixture(dir) {
  writeConfig(dir, 'bracket');
  fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
  fs.writeFileSync(planning(dir, 'ROADMAP.md'), '# Roadmap\n\n## [CK.02] v2.0 — Foundation\n');
}

function markBracketPhaseComplete(dir, token, slug) {
  const phaseDir = planning(dir, 'phases', `CK.02-${token}-${slug}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, `${token}-01-PLAN.md`), '# Plan\n');
  fs.writeFileSync(path.join(phaseDir, `${token}-01-SUMMARY.md`), '# Summary\n');
  fs.writeFileSync(
    path.join(phaseDir, `${token}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
}

function managerPhase(dir, phaseNumber) {
  const manager = run(['init', 'manager'], dir);
  const phase = manager.phases.find((row) => row.number === phaseNumber);
  assert.ok(phase, `manager must report phase ${phaseNumber}`);
  return phase;
}

function run(args, cwd) {
  const result = runGsdTools(args, cwd);
  assert.equal(result.success, true, `${args.join(' ')} failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

describe('#4304 / ADR-612 PR-4 bracket writers', () => {
  test('add, add-batch, and insert dependencies remain discussable through init manager', () => {
    const addDir = project('adr-612-bracket-manager-add-');
    writeBracketFixture(addDir);
    markBracketPhaseComplete(addDir, '01', 'foundation');
    run(['phase', 'add', 'Second'], addDir);
    const added = managerPhase(addDir, '02');
    assert.deepEqual(added.dep_phases, ['[CK.02] 01']);
    assert.equal(added.deps_satisfied, true);
    assert.equal(added.is_next_to_discuss, true);

    const batchDir = project('adr-612-bracket-manager-batch-');
    writeBracketFixture(batchDir);
    markBracketPhaseComplete(batchDir, '01', 'foundation');
    run(['phase', 'add-batch', '--descriptions', '["Second","Third"]'], batchDir);
    markBracketPhaseComplete(batchDir, '02', 'second');
    const batchSecond = managerPhase(batchDir, '02');
    const batchThird = managerPhase(batchDir, '03');
    assert.deepEqual(batchSecond.dep_phases, ['[CK.02] 01']);
    assert.deepEqual(batchThird.dep_phases, ['[CK.02] 02']);
    assert.equal(batchThird.deps_satisfied, true);
    assert.equal(batchThird.is_next_to_discuss, true);

    const insertDir = project('adr-612-bracket-manager-insert-');
    writeBracketFixture(insertDir);
    markBracketPhaseComplete(insertDir, '01', 'foundation');
    run(['phase', 'insert', '01', 'Hotfix'], insertDir);
    const inserted = managerPhase(insertDir, '01.01');
    assert.deepEqual(inserted.dep_phases, ['[CK.02] 01']);
    assert.equal(inserted.deps_satisfied, true);
    assert.equal(inserted.is_next_to_discuss, true);
  });

  test('init manager keeps qualified dependency identity and leaves bare dependencies unchanged', () => {
    for (const [label, dependency, expected] of [
      ['display', '[CK.02] 01', '[CK.02] 01'],
      ['dash', 'CK.02-01', '[CK.02] 01'],
      ['labeled display', '[CK.02] Phase 01', '[CK.02] 01'],
      ['bare', '01', '01'],
    ]) {
      const dir = project(`adr-612-bracket-manager-${label.replaceAll(' ', '-')}-`);
      writeBracketFixture(dir);
      markBracketPhaseComplete(dir, '01', 'foundation');
      fs.appendFileSync(
        planning(dir, 'ROADMAP.md'),
        [
          '',
          '### [CK.02] 02: Second',
          '',
          '**Goal:** Next',
          `**Depends on:** ${dependency}`,
          '',
        ].join('\n'),
      );
      fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-second'), { recursive: true });

      const phase = managerPhase(dir, '02');
      assert.deepEqual(phase.dep_phases, [expected], label);
      assert.equal(phase.deps_satisfied, true, label);
      assert.equal(phase.is_next_to_discuss, true, label);
    }
  });

  test('init manager resolves a qualified historical dependency against that milestone checklist', () => {
    const dir = project('adr-612-bracket-manager-historical-dependency-');
    writeBracketFixture(dir);
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 - Historical (Shipped)</summary>',
        '',
        '## [CK.01] v1.0 - Historical',
        '',
        '- [x] **[CK.01] 01: Historical foundation**',
        '',
        '### [CK.01] 01: Historical foundation',
        '',
        '**Goal:** Shipped work',
        '',
        '</details>',
        '',
        '## [CK.02] v2.0 - Current',
        '',
        '- [ ] **[CK.02] 01: Current foundation**',
        '- [ ] **[CK.02] 02: Follow-up**',
        '',
        '### [CK.02] 01: Current foundation',
        '',
        '**Goal:** Current work',
        '',
        '### [CK.02] 02: Follow-up',
        '',
        '**Goal:** Next work',
        '**Depends on:** [CK.01] 01',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-current-foundation'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-follow-up'), { recursive: true });

    const phase = managerPhase(dir, '02');
    assert.deepEqual(phase.dep_phases, ['[CK.01] 01']);
    assert.equal(phase.deps_satisfied, true);
    assert.equal(phase.is_next_to_discuss, true);
  });

  test('init manager does not satisfy a current dependency from a historical same-number checkbox', () => {
    for (const dependency of ['[CK.02] 01', '01']) {
      const dir = project('adr-612-bracket-manager-current-dependency-');
      writeBracketFixture(dir);
      fs.writeFileSync(
        planning(dir, 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '<details>',
          '<summary>v1.0 - Historical (Shipped)</summary>',
          '',
          '## [CK.01] v1.0 - Historical',
          '',
          '- [x] **[CK.01] 01: Historical foundation**',
          '',
          '### [CK.01] 01: Historical foundation',
          '',
          '**Goal:** Shipped work',
          '',
          '</details>',
          '',
          '## [CK.02] v2.0 - Current',
          '',
          '- [ ] **[CK.02] 01: Current foundation**',
          '- [ ] **[CK.02] 02: Follow-up**',
          '',
          '### [CK.02] 01: Current foundation',
          '',
          '**Goal:** Current work',
          '',
          '### [CK.02] 02: Follow-up',
          '',
          '**Goal:** Next work',
          `**Depends on:** ${dependency}`,
          '',
        ].join('\n'),
      );
      fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-current-foundation'), { recursive: true });
      fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-follow-up'), { recursive: true });

      const phase = managerPhase(dir, '02');
      assert.deepEqual(phase.dep_phases, [dependency]);
      assert.equal(phase.deps_satisfied, false, dependency);
      assert.equal(phase.is_next_to_discuss, false, dependency);
    }
  });

  test('init manager waits for every phase in a qualified dependency list', () => {
    const dir = project('adr-612-bracket-manager-qualified-list-');
    writeBracketFixture(dir);
    markBracketPhaseComplete(dir, '01', 'foundation');
    fs.appendFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '',
        '### [CK.02] 02: Incomplete prerequisite',
        '',
        '**Goal:** Remains incomplete',
        '',
        '### [CK.02] 03: Blocked follow-up',
        '',
        '**Goal:** Must wait',
        '**Depends on:** [CK.02] Phase 1 and 2',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-incomplete-prerequisite'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-03-blocked-follow-up'), { recursive: true });

    const phase = managerPhase(dir, '03');
    assert.deepEqual(phase.dep_phases, ['[CK.02] 01', '[CK.02] 02']);
    assert.equal(phase.deps_satisfied, false);
    assert.equal(phase.is_next_to_discuss, false);
  });

  test('phase add emits a canonical bracket heading and directory', () => {
    const dir = project();
    writeBracketFixture(dir);

    const out = run(['phase', 'add', 'User Dashboard'], dir);

    assert.equal(out.phase_number, 2);
    assert.equal(out.directory, '.planning/phases/CK.02-02-user-dashboard');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-02-user-dashboard')), true);
    assert.equal(
      fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8').includes('### [CK.02] 02: User Dashboard'),
      true,
    );
  });

  test('phase add output resolves through every current-checkout phase-directory lookup', () => {
    const dir = project('adr-612-bracket-find-added-');
    writeBracketFixture(dir);

    run(['phase', 'add', 'User Dashboard'], dir);
    const phaseDir = planning(dir, 'phases', 'CK.02-02-user-dashboard');
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), [
      '---',
      'wave: 1',
      'depends_on: []',
      'autonomous: true',
      '---',
      '',
      '# Plan',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n\nSTATUS: failed\n');
    fs.writeFileSync(path.join(phaseDir, '02-CONTEXT.md'), '# Context\n');
    const priorMilestoneDecoy = planning(dir, 'phases', 'CK.01-02-prior-decoy');
    fs.mkdirSync(priorMilestoneDecoy, { recursive: true });
    fs.writeFileSync(path.join(priorMilestoneDecoy, '02-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(
      planning(dir, 'STATE.md'),
      fs.readFileSync(planning(dir, 'STATE.md'), 'utf8')
        .replace('**Current Phase:** 01', '**Current Phase:** 02')
        .replace('Phase: 01 (Foundation)', 'Phase: 02 (User Dashboard)'),
    );

    for (const query of ['02', '2', 'CK.02-02']) {
      const found = run(['find-phase', query], dir);
      assert.equal(found.found, true, query);
      assert.equal(found.directory, '.planning/phases/CK.02-02-user-dashboard', query);
      assert.deepEqual(found.plans, ['02-01-PLAN.md'], query);
    }

    const listed = run(['phase', 'list-plans', '02'], dir);
    assert.equal(listed.phase_dir, '.planning/phases/CK.02-02-user-dashboard');
    assert.deepEqual(
      listed.plans,
      ['.planning/phases/CK.02-02-user-dashboard/02-01-PLAN.md'],
    );

    const index = run(['phase-plan-index', '02'], dir);
    assert.equal(index.error, undefined);
    assert.equal(index.plans.length, 1);
    assert.equal(index.plans[0].id, '02-01');

    const phasesListed = run(['phases', 'list', '--phase', '02', '--type', 'plans'], dir);
    assert.equal(phasesListed.error, undefined);
    assert.deepEqual(phasesListed.files, ['02-01-PLAN.md']);

    const nextDecimal = run(['phase', 'next-decimal', '02'], dir);
    assert.equal(nextDecimal.found, true);

    const execute = run(['init', 'execute-phase', '02'], dir);
    assert.equal(execute.phase_found, true);
    // init emits phase_dir POSIX-normalized (#2376); compare in that shape on Windows too.
    assert.equal(execute.phase_dir, toPosixPath(fs.realpathSync(phaseDir)));
    assert.equal(execute.plan_count, 1);

    const smartEntry = run(['smart-entry', '--json'], dir);
    assert.equal(smartEntry.signals.verify_failed, true);

    const updated = run(['roadmap', 'update-plan-progress', '02'], dir);
    assert.equal(updated.plan_count, 1);

    const drift = run(['verify', 'context-drift', '02'], dir);
    assert.notEqual(drift.reason, 'phase-not-found');

    const manager = run(['init', 'manager'], dir);
    const managed = manager.phases.find((phase) => phase.number === '02');
    assert.ok(managed);
    assert.notEqual(managed.disk_status, 'no_directory');
    assert.equal(managed.plan_count, 1);

    const analyzed = run(['roadmap', 'analyze'], dir);
    const analyzedPhase = analyzed.phases.find((phase) => phase.number === '02');
    assert.ok(analyzedPhase);
    assert.notEqual(analyzedPhase.disk_status, 'no_directory');
    assert.equal(analyzedPhase.plan_count, 1);
  });

  test('smart-entry verify-failed remains true with only the active bracket directory', () => {
    const dir = project('adr-612-bracket-smart-entry-active-only-');
    writeBracketFixture(dir);
    run(['phase', 'add', 'User Dashboard'], dir);
    const phaseDir = planning(dir, 'phases', 'CK.02-02-user-dashboard');
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), 'STATUS: failed\n');
    fs.writeFileSync(
      planning(dir, 'STATE.md'),
      fs.readFileSync(planning(dir, 'STATE.md'), 'utf8')
        .replace('**Current Phase:** 01', '**Current Phase:** 02')
        .replace('Phase: 01 (Foundation)', 'Phase: 02 (User Dashboard)'),
    );

    const smartEntry = run(['smart-entry', '--json'], dir);

    assert.equal(smartEntry.signals.verify_failed, true);
  });

  test('unpadded bracket subphase queries resolve the canonical emitted directory through every shared locator consumer', () => {
    const dir = project('adr-612-bracket-subphase-query-');
    writeBracketFixture(dir);
    const phaseDir = planning(dir, 'phases', 'CK.02-01.01-hotfix');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01.01-01-PLAN.md'), '---\nwave: 1\n---\n');

    const found = run(['find-phase', '1.1'], dir);
    assert.equal(found.directory, '.planning/phases/CK.02-01.01-hotfix');

    const index = run(['phase-plan-index', '1.1'], dir);
    assert.equal(index.error, undefined);
    assert.deepEqual(index.plans.map((plan) => plan.id), ['01.01-01']);

    const listed = run(['phase', 'list-plans', '1.1'], dir);
    assert.equal(listed.phase_dir, '.planning/phases/CK.02-01.01-hotfix');
    assert.deepEqual(listed.plans, ['.planning/phases/CK.02-01.01-hotfix/01.01-01-PLAN.md']);
  });

  test('legacy subphase query normalization remains unchanged', () => {
    const dir = project('adr-612-legacy-subphase-query-');
    writeConfig(dir, 'sequential');
    const phaseDir = planning(dir, 'phases', 'CK-01.1-hotfix');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01.1-01-PLAN.md'), '---\nwave: 1\n---\n');

    const found = run(['find-phase', '1.1'], dir);

    assert.equal(found.directory, '.planning/phases/CK-01.1-hotfix');
  });

  // #4304 round 17 (W1): next-decimal's base lookup was bracket-aware, but
  // its child inventory still used the legacy directory/heading patterns.
  // That split answer proposed the already-occupied 02.01 slot as "02.1".
  test('phase next-decimal inventories canonical bracket subphases from directories and headings', () => {
    const dir = project('adr-612-bracket-next-decimal-occupied-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Parent',
        '**Goal:** parent',
        '',
        '### [CK.02] 02.01: Child',
        '**Goal:** occupied',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-parent'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02.01-child'), { recursive: true });

    const out = run(['phase', 'next-decimal', '02'], dir);

    assert.equal(out.found, true);
    assert.equal(out.base_phase, '02');
    assert.equal(out.next, '02.02');
    assert.deepEqual(out.existing, ['02.01']);
  });

  test('phase next-decimal preserves the legacy 999 backlog inventory under bracket configuration', () => {
    const dir = project('adr-612-bracket-next-decimal-backlog-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n## [CK.02] v2.0 — Current\n\n### Phase 999.1: First\n\n### Phase 999.3: Third\n',
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK-999.01-first'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK-999.03-third'), { recursive: true });

    const out = run(['phase', 'next-decimal', '999'], dir);

    assert.equal(out.next, '999.4');
    assert.deepEqual(out.existing, ['999.1', '999.3']);
  });

  test('phase next-decimal unions bracket and legacy directory spellings for a bracket parent', () => {
    const dir = project('adr-612-bracket-next-decimal-mixed-dirs-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n## [CK.02] v2.0 — Current\n\n### [CK.02] 02: Parent\n',
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-parent'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK-02.1-old'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02.02-new'), { recursive: true });

    const out = run(['phase', 'next-decimal', '02'], dir);

    assert.equal(out.next, '02.03');
    assert.deepEqual(out.existing, ['02.01', '02.02']);
  });

  test('phase next-decimal unions bracket and legacy ROADMAP-only children for a bracket parent', () => {
    const dir = project('adr-612-bracket-next-decimal-mixed-roadmap-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Parent',
        '',
        '### Phase 02.1: Legacy child',
        '',
        '- [ ] **[CK.02] 02.02: Bracket child**',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-parent'), { recursive: true });

    const out = run(['phase', 'next-decimal', '02'], dir);

    assert.equal(out.next, '02.03');
    assert.deepEqual(out.existing, ['02.01', '02.02']);
  });

  test('phase next-decimal returns canonical 02.01 for a bracket parent with no children', () => {
    const dir = project('adr-612-bracket-next-decimal-empty-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n## [CK.02] v2.0 — Current\n\n### [CK.02] 02: Parent\n**Goal:** parent\n',
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-parent'), { recursive: true });

    const out = run(['phase', 'next-decimal', '02'], dir);

    assert.equal(out.found, true);
    assert.equal(out.next, '02.01');
    assert.deepEqual(out.existing, []);
  });

  test('phase next-decimal preserves legacy decimal spelling and inventory', () => {
    const dir = project('adr-612-legacy-next-decimal-control-');
    writeConfig(dir, 'sequential');
    fs.mkdirSync(planning(dir, 'phases', 'CK-02-parent'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK-02.1-directory-child'), { recursive: true });
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 02: Parent\n\n### Phase 02.2: Heading child\n',
    );

    const out = run(['phase', 'next-decimal', '02'], dir);

    assert.deepEqual(out, {
      found: true,
      base_phase: '02',
      next: '02.3',
      existing: ['02.1', '02.2'],
    });
  });

  test('milestone completion recognizes bracket phase directories as started', () => {
    const dir = project('adr-612-bracket-milestone-complete-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(
      planning(dir, 'STATE.md'),
      '---\nstatus: executing\nmilestone: v2.0\ncurrent_phase: 02\n---\n',
    );
    // The milestone guard's existing reader recognizes legacy headings even
    // during migration. Its disk lookup must still find the canonical bracket
    // directory produced by the current checkout.
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone v2.0\n\n### Phase 2: New Work\n\n**Goal:** Existing\n',
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-new-work'), { recursive: true });

    const result = runGsdTools(['milestone', 'complete', 'v2.0', '--confirm'], dir);

    assert.equal(result.success, true, result.error);
  });

  test('roadmap analyze enriches a bracket phase declared only in a phase table', () => {
    const dir = project('adr-612-bracket-table-lookup-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Foundation',
        '',
        '| Phase | Name |',
        '| --- | --- |',
        '| 02 | New Work |',
        '',
      ].join('\n'),
    );
    const phaseDir = planning(dir, 'phases', 'CK.02-02-new-work');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');

    const analyzed = run(['roadmap', 'analyze'], dir);
    const phase = analyzed.phases.find((row) => row.number === '02');

    assert.ok(phase);
    assert.notEqual(phase.disk_status, 'no_directory');
    assert.equal(phase.plan_count, 1);
  });

  test('bracket mode preserves legacy result shaping for active and archived legacy directories', () => {
    const dir = project('adr-612-bracket-legacy-read-');
    writeBracketFixture(dir);
    run(['phase', 'add', 'New Work'], dir);
    cleanup(planning(dir, 'phases', 'CK.02-01-foundation'));
    fs.writeFileSync(
      planning(dir, 'phases', 'CK.02-02-new-work', '02-01-PLAN.md'),
      '---\nwave: 1\n---\n',
    );

    const activeLegacy = planning(dir, 'phases', '01-legacy');
    fs.mkdirSync(activeLegacy, { recursive: true });
    fs.writeFileSync(path.join(activeLegacy, '01-01-PLAN.md'), '---\nwave: 1\n---\n');

    const archivedLegacy = planning(dir, 'milestones', 'v1.0-phases', '03-archived-legacy');
    fs.mkdirSync(archivedLegacy, { recursive: true });
    fs.writeFileSync(path.join(archivedLegacy, '03-01-PLAN.md'), '---\nwave: 1\n---\n');

    for (const [query, expectedDir, expectedNumber, expectedName] of [
      ['01', '.planning/phases/01-legacy', '01', 'legacy'],
      ['02', '.planning/phases/CK.02-02-new-work', '02', 'new-work'],
    ]) {
      const found = run(['find-phase', query], dir);
      assert.equal(found.found, true, query);
      assert.equal(found.directory, expectedDir, query);
      assert.equal(found.phase_number, expectedNumber, query);
      assert.equal(found.phase_name, expectedName, query);

      const listed = run(['phase', 'list-plans', query], dir);
      assert.equal(listed.phase_dir, expectedDir, query);
      assert.equal(listed.plans.length, 1, query);

      const indexed = run(['phase-plan-index', query], dir);
      assert.equal(indexed.error, undefined, query);
      assert.equal(indexed.plans.length, 1, query);
    }

    const archivedFound = run(['find-phase', '03'], dir);
    assert.equal(archivedFound.found, true);
    assert.equal(archivedFound.directory, '.planning/milestones/v1.0-phases/03-archived-legacy');
    assert.equal(archivedFound.phase_number, '03');
    assert.equal(archivedFound.phase_name, 'archived-legacy');

    const archivedListed = run(['phase', 'list-plans', '03'], dir);
    assert.equal(archivedListed.phase_dir, '.planning/milestones/v1.0-phases/03-archived-legacy');
    assert.equal(archivedListed.plans.length, 1);
  });

  test('phase add allocates above a reader-resolvable legacy directory', () => {
    const dir = project('adr-612-bracket-add-legacy-reservation-');
    writeEmptyBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK-01-existing'), { recursive: true });

    const before = run(['find-phase', '01'], dir);
    assert.equal(before.directory, '.planning/phases/CK-01-existing');

    const out = run(['phase', 'add', 'New'], dir);

    assert.equal(out.phase_number, 2);
    assert.equal(out.directory, '.planning/phases/CK.02-02-new');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-02-new')), true);
  });

  test('phase add-batch allocates above a reader-resolvable legacy directory', () => {
    const dir = project('adr-612-bracket-batch-legacy-reservation-');
    writeEmptyBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK-01-existing'), { recursive: true });

    const out = run(['phase', 'add-batch', '--descriptions', '["Alpha","Beta"]'], dir);

    assert.deepEqual(out.phases.map((phase) => phase.phase_number), [2, 3]);
    assert.deepEqual(
      out.phases.map((phase) => phase.directory),
      ['.planning/phases/CK.02-02-alpha', '.planning/phases/CK.02-03-beta'],
    );
  });

  test('a prior milestone qualified directory does not reserve the active milestone number', () => {
    const dir = project('adr-612-bracket-add-prior-milestone-control-');
    writeEmptyBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK.01-09-prior'), { recursive: true });

    const out = run(['phase', 'add', 'First Current'], dir);

    assert.equal(out.phase_number, 1);
    assert.equal(out.directory, '.planning/phases/CK.02-01-first-current');
  });

  // #4304 round 12 (W1): readSubdirectories intentionally ignores symlinks,
  // so a planted link at the next allocated bracket directory used to be
  // invisible to allocation and then followed by the .gitkeep write.
  test('phase add refuses a symlink planted at the allocated bracket directory without writing through it', () => {
    const dir = project('adr-612-bracket-add-symlink-');
    writeBracketFixture(dir);
    const outside = path.join(dir, 'outside-phase-target');
    fs.mkdirSync(outside);
    const link = planning(dir, 'phases', 'CK.02-02-escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const roadmapBefore = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(['phase', 'add', 'Escape'], dir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /symbolic link|outside the planning phases directory/i);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), roadmapBefore);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  test('phase add can mint the first bracket phase in an empty milestone', () => {
    const dir = project('adr-612-first-bracket-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), '# Roadmap\n\n## [CK.02] v2.0 — Foundation\n');

    const out = run(['phase', 'add', 'Foundation'], dir);

    assert.equal(out.phase_number, 1);
    assert.equal(out.directory, '.planning/phases/CK.02-01-foundation');
    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 01: Foundation'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] 00'), true);
  });

  test('bracket convention without a project code refuses instead of falling back to legacy emit', () => {
    const dir = project('adr-612-bracket-gate-');
    fs.writeFileSync(
      planning(dir, 'config.json'),
      JSON.stringify({ project_code: null, phase_id_convention: 'bracket' }, null, 2) + '\n',
    );
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), '# Roadmap\n');
    const before = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(['phase', 'add', 'Must Refuse'], dir);

    assert.equal(result.success, false);
    assert.match(result.error, /project_code is missing/);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(planning(dir, 'phases')), []);
  });

  test('a bracket ROADMAP with only bullet-style phase rows refuses phase insert instead of falling back to legacy bullet insertion', () => {
    // #4304 review fix (Minor 3): bracket identities live in headings only
    // (cmdPhaseInsert forces isBulletStyle=false whenever bracketContext is
    // set), so a bracket ROADMAP whose only phase row is bullet-style must
    // take the checklist-only refusal path, not the legacy bullet-insertion
    // path — even though the bullet line itself matches the bracket-aware
    // bullet pattern.
    const dir = project('adr-612-bracket-bullet-only-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Foundation',
        '',
        '- [ ] [CK.02] 01: Foundation',
        '',
      ].join('\n'),
    );
    const before = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(['phase', 'insert', '01', 'Second Hotfix'], dir);

    assert.equal(result.success, false, result.error || result.output);
    assert.match(result.error, /active milestone window/);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(planning(dir, 'phases')), []);
  });

  // #4304 round-5 Blocker 3: the pre-flight headingMatch check ran against
  // extractCurrentMilestone's content, which merges the primary section with
  // a later "(Phase Details)" section sharing the same milestone identity —
  // so it passed even when the target's own detail heading lives ONLY in
  // that Phase Details section, separated from primary by an unrelated
  // sibling milestone. The actual header search that followed was scoped to
  // bracketSectionRanges.primary alone, so it failed AFTER platformEnsureDir
  // had already created the new phase's directory: a partial write. The
  // header search must check both ranges the round-3 remove fix already
  // discovers (primary and Phase Details), and every validation — locating
  // the header and computing the ROADMAP edit — must happen before any
  // directory is created.
  function snapshotTree(root) {
    const snapshot = [];
    (function visit(dir, rel) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = path.join(rel, entry.name);
        const absPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          snapshot.push({ type: 'directory', path: relPath });
          visit(absPath, relPath);
        } else {
          snapshot.push({ type: 'file', path: relPath, bytes: fs.readFileSync(absPath).toString('base64') });
        }
      }
    })(root, '');
    return snapshot;
  }

  test('phase insert finds the target heading in the Phase Details range across an intervening sibling milestone', () => {
    const dir = project('adr-612-bracket-insert-details-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '### [CK.03] 01: Future',
        '**Goal:** untouched',
        '',
        '## [CK.02] v2.0 — Current (Phase Details)',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** keep',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-two'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.03-01-future'), { recursive: true });

    const result = runGsdTools(['phase', 'insert', '1', 'Urgent fix'], dir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.phase_number, '01.01');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.01-urgent-fix')), true);

    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 01.01: Urgent fix (INSERTED)'), true);
    const detailsSection = roadmap.slice(roadmap.indexOf('(Phase Details)'));
    assert.equal(
      detailsSection.indexOf('### [CK.02] 01.01: Urgent fix')
        < detailsSection.indexOf('### [CK.02] 02: Two'),
      true,
    );
  });

  // #4304 round 6 (B1): currentMilestoneRawRanges' details-range end
  // (roadmap-parser.cts:2298) called computeMilestoneSectionEnd WITHOUT the
  // bracketBoundary the SAME function already applies to the primary range
  // (bracketAwareMilestoneSection, consumed a few lines above) — so on a
  // version-less bracket milestone heading (no v\d+.\d+ / emoji marker) the
  // active details window ran through the NEXT sibling milestone's OWN
  // "(Phase Details)" section instead of stopping at it. Insert's header
  // search (which walks this SAME details range, discovered by round 5's
  // B3 fix) then planted the new section inside the wrong milestone.
  test('phase insert locates its Phase Details heading correctly when milestone headings carry no version token', () => {
    const dir = project('adr-612-bracket-insert-versionless-details-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '## [CK.03] Future',
        '',
        '- [ ] [CK.03] 03: Future Three',
        '',
        '## [CK.02] Current (Phase Details)',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## [CK.03] Future (Phase Details)',
        '',
        '### [CK.03] 03: Future Three',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-03-three'), { recursive: true });
    fs.writeFileSync(planning(dir, 'phases', 'CK.02-03-three', '03-01-PLAN.md'), '# artifact\n');
    fs.mkdirSync(planning(dir, 'phases', 'CK.03-03-future-three'), { recursive: true });
    fs.writeFileSync(planning(dir, 'phases', 'CK.03-03-future-three', '03-01-PLAN.md'), '# artifact\n');

    const result = runGsdTools(['phase', 'insert', '3', 'Urgent fix'], dir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.phase_number, '03.01');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-03.01-urgent-fix')), true);
    // The sibling milestone's own Phase Details section is byte-identical:
    // the leaked window used to insert the new section INSIDE it, before
    // its own '### [CK.03] 03: Future Three' heading.
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.03-03.01-urgent-fix')), false);

    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const ck03Details = roadmap.slice(roadmap.indexOf('## [CK.03] Future (Phase Details)'));
    assert.equal(ck03Details.includes('[CK.02] 03.01'), false);
    assert.equal(
      ck03Details,
      [
        '## [CK.03] Future (Phase Details)',
        '',
        '### [CK.03] 03: Future Three',
        '',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ].join('\n'),
    );
    const ck02Details = roadmap.slice(
      roadmap.indexOf('## [CK.02] Current (Phase Details)'),
      roadmap.indexOf('## [CK.03] Future (Phase Details)'),
    );
    assert.equal(ck02Details.includes('### [CK.02] 03.01: Urgent fix (INSERTED)'), true);
  });

  // #4304 round 16 (B1): the raw active ranges may still contain a shipped
  // <details> archive. Searching those bytes for the first matching NUMBER
  // selected [CK.01] 01 before the live [CK.02] 01 and wrote the new CK.02
  // subphase inside history, where extractCurrentMilestone then hid it.
  test('phase insert selects the live active-identity heading after an archived different-identity heading with the same number', () => {
    const dir = project('adr-612-bracket-insert-live-identity-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.1\n---\n');
    const archive = [
      '<details>',
      '<summary>✅ [CK.01] v1.0 — SHIPPED 2026-01-01</summary>',
      '',
      '### [CK.01] 01: Archived One',
      '',
      '**Goal:** preserve',
      '',
      '### [CK.01] 02: Archived Two',
      '',
      '**Goal:** preserve',
      '',
      '</details>',
    ].join('\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current',
        '',
        archive,
        '',
        '### [CK.02] 01: Live One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Live Two',
        '**Goal:** keep',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-live-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-live-two'), { recursive: true });

    const result = runGsdTools(['phase', 'insert', '1', 'Hotfix'], dir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const archiveStart = roadmap.indexOf('<details>');
    const archiveEnd = roadmap.indexOf('</details>', archiveStart);
    assert.equal(
      roadmap.slice(archiveStart, archiveEnd + '</details>'.length),
      archive,
      'shipped archive must remain byte-identical',
    );
    const liveOne = roadmap.indexOf('### [CK.02] 01: Live One');
    const inserted = roadmap.indexOf('### [CK.02] 01.01: Hotfix (INSERTED)');
    const liveTwo = roadmap.indexOf('### [CK.02] 02: Live Two');
    assert.equal(liveOne < inserted && inserted < liveTwo, true, 'insert must follow the live target heading');
    const current = extractCurrentMilestone(roadmap, dir);
    assert.equal(current.includes('### [CK.02] 01.01: Hotfix (INSERTED)'), true);
  });

  // #4304 round 17 (B1): round 16 made target selection fence-aware, but the
  // subsequent next-heading boundary still searched raw bytes. A phase-shaped
  // heading inside a fenced example therefore became the splice boundary and
  // placed the new live phase inside documentation, where roadmap readers
  // could not see it.
  test('phase insert bounds the new bracket subphase before a fenced phase-heading example', () => {
    const dir = project('adr-612-bracket-insert-fenced-boundary-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.1\n---\n');
    const fence = [
      '```md',
      '### [CK.02] 09: Example only',
      '',
      '**Goal:** documentation',
      '```',
    ].join('\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current',
        '',
        '### [CK.02] 01: Live One',
        '**Goal:** keep',
        '',
        fence,
        '',
        '### [CK.02] 02: Live Two',
        '**Goal:** keep',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-live-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-live-two'), { recursive: true });

    const result = runGsdTools(['phase', 'insert', '01', 'Hotfix'], dir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const persistedFenceStart = roadmap.indexOf('```md');
    const persistedFenceEnd = roadmap.indexOf('```', persistedFenceStart + '```md'.length);
    const persistedFence = roadmap.slice(persistedFenceStart, persistedFenceEnd + '```'.length);
    assert.equal(persistedFence, fence, 'fenced example must remain byte-identical');
    const liveOne = roadmap.indexOf('### [CK.02] 01: Live One');
    const inserted = roadmap.indexOf('### [CK.02] 01.01: Hotfix (INSERTED)');
    const fenceStart = roadmap.indexOf('```md');
    assert.equal(liveOne < inserted && inserted < fenceStart, true, 'insert must land before the fence');

    const current = extractCurrentMilestone(roadmap, dir);
    const headingTexts = tokenizeHeadings(current).map((heading) => heading.text);
    assert.equal(headingTexts.some((text) => text.startsWith('[CK.02] 01.01: Hotfix')), true);
  });

  test('phase insert refuses byte-identically when its only matching active-identity heading is archived', () => {
    const dir = project('adr-612-bracket-insert-archive-only-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.1\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current',
        '',
        '<details>',
        '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
        '',
        '### [CK.02] 01: Archived One',
        '**Goal:** preserve',
        '',
        '</details>',
        '',
        '### [CK.02] 02: Live Two',
        '**Goal:** keep',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-archived-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-02-live-two'), { recursive: true });
    const before = snapshotTree(planning(dir));

    const result = runGsdTools(['phase', 'insert', '1', 'Hotfix'], dir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /active milestone window/i);
    assert.deepEqual(snapshotTree(planning(dir)), before);
  });

  test('an insert that fails to locate its header leaves the planning tree byte-identical', () => {
    const dir = project('adr-612-bracket-insert-refuse-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 09: Nine',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-09-nine'), { recursive: true });
    const before = snapshotTree(planning(dir));

    const result = runGsdTools(['phase', 'insert', '9', 'Urgent fix'], dir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /active milestone window/);
    assert.deepEqual(snapshotTree(planning(dir)), before);
  });

  test('phase add-batch allocates consecutive bracket ids', () => {
    const dir = project();
    writeBracketFixture(dir);

    const out = run(['phase', 'add-batch', '--descriptions', '["Alpha","Beta"]'], dir);

    assert.deepEqual(out.phases.map((phase) => phase.phase_number), [2, 3]);
    assert.deepEqual(
      out.phases.map((phase) => phase.directory),
      ['.planning/phases/CK.02-02-alpha', '.planning/phases/CK.02-03-beta'],
    );
    assert.deepEqual(
      fs.readdirSync(planning(dir, 'phases')).sort(),
      ['CK.02-01-foundation', 'CK.02-02-alpha', 'CK.02-03-beta'],
    );
    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Alpha'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Beta'), true);
  });

  // #4304 round-5 Blocker 4: the per-description loop computed a phase
  // number, called toDir (which THROWS "slug sanitizes to empty" for a
  // description that transliterates to nothing), and immediately created
  // that item's directory — all inside one loop iteration. An item further
  // down the batch whose description sanitizes to empty therefore left
  // every EARLIER item's directory already created on disk with no ROADMAP
  // write at all, contradicting the function's own "all-or-nothing, ...
  // no phase directories created" comment.
  test('phase add-batch validates every item before the first directory is created', () => {
    const dir = project('adr-612-bracket-addbatch-partial-');
    writeBracketFixture(dir);
    const dirsBefore = fs.readdirSync(planning(dir, 'phases')).sort();
    const roadmapBefore = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(
      [
        'phase',
        'add-batch',
        '--descriptions',
        JSON.stringify(['Alpha work', 'Beta work', '日本語のみ', 'Delta work', 'Epsilon work']),
      ],
      dir,
    );

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /slug sanitizes to empty|Cannot create a phase directory/);
    assert.deepEqual(fs.readdirSync(planning(dir, 'phases')).sort(), dirsBefore);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), roadmapBefore);
  });

  test('phase add-batch refuses every destination before a later allocated path can follow a symlink', () => {
    const dir = project('adr-612-bracket-batch-symlink-');
    writeBracketFixture(dir);
    const outside = path.join(dir, 'outside-batch-target');
    fs.mkdirSync(outside);
    const link = planning(dir, 'phases', 'CK.02-03-beta');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const roadmapBefore = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(
      ['phase', 'add-batch', '--descriptions', JSON.stringify(['Alpha', 'Beta'])],
      dir,
    );

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /symbolic link|outside the planning phases directory/i);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), roadmapBefore);
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-02-alpha')), false);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  test('phase add-batch still creates all five directories with one ROADMAP write when every item validates', () => {
    const dir = project('adr-612-bracket-addbatch-full-');
    writeBracketFixture(dir);

    const out = run(
      ['phase', 'add-batch', '--descriptions', JSON.stringify(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])],
      dir,
    );

    assert.deepEqual(out.phases.map((phase) => phase.phase_number), [2, 3, 4, 5, 6]);
    assert.deepEqual(
      fs.readdirSync(planning(dir, 'phases')).sort(),
      [
        'CK.02-01-foundation',
        'CK.02-02-alpha',
        'CK.02-03-beta',
        'CK.02-04-gamma',
        'CK.02-05-delta',
        'CK.02-06-epsilon',
      ],
    );
    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
      assert.equal(roadmap.includes(`: ${name}`), true);
    }
  });

  test('phase insert emits the next canonical bracket subphase', () => {
    const dir = project();
    writeBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01.01-first'), { recursive: true });
    fs.appendFileSync(
      planning(dir, 'ROADMAP.md'),
      '### [CK.02] 01.01: First (INSERTED)\n\n**Goal:** Existing\n',
    );

    const out = run(['phase', 'insert', '01', 'Second Hotfix'], dir);

    assert.equal(out.phase_number, '01.02');
    assert.equal(out.directory, '.planning/phases/CK.02-01.02-second-hotfix');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.02-second-hotfix')), true);
    assert.equal(
      fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8').includes('### [CK.02] 01.02: Second Hotfix (INSERTED)'),
      true,
    );
  });

  test('phase insert refuses a symlink planted at its bracket subphase destination', () => {
    const dir = project('adr-612-bracket-insert-symlink-');
    writeBracketFixture(dir);
    const outside = path.join(dir, 'outside-insert-target');
    fs.mkdirSync(outside);
    const link = planning(dir, 'phases', 'CK.02-01.01-urgent-fix');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const roadmapBefore = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

    const result = runGsdTools(['phase', 'insert', '01', 'Urgent fix'], dir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /symbolic link|outside the planning phases directory/i);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), roadmapBefore);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  // #4304 Blocker 2: the bracket branch validated the parent heading against
  // extractCurrentMilestone (correctly scoped to the active milestone) but
  // then located the insertion point with headerPattern against the WHOLE
  // rawContent. rawContent.match found CK.01's OWN "01:" heading first (an
  // earlier milestone sharing the same phase number), and the "next phase"
  // boundary search from there found CK.01's OWN later phase heading before
  // ever reaching CK.02 — landing the new phase BETWEEN CK.01's own phase
  // headings, so the active milestone (CK.02) never received it at all.
  test('phase insert scopes the insertion point to the active milestone when an earlier milestone shares the same phase number', () => {
    const dir = project('adr-612-bracket-cross-milestone-insert-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    const roadmapBefore = [
      '# Roadmap',
      '',
      '## [CK.01] v1.0 — Prior',
      '',
      '### [CK.01] 01: Old One',
      '',
      '**Goal:** untouched',
      '',
      '### [CK.01] 02: Old Two',
      '',
      '**Goal:** also untouched',
      '',
      '## [CK.02] v2.0 — Current',
      '',
      '### [CK.02] 01: One',
      '',
      '**Goal:** keep',
      '',
    ].join('\n');
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), roadmapBefore);
    fs.mkdirSync(planning(dir, 'phases', 'CK.01-01-old-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.01-02-old-two'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });

    const ck01SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.01]'),
      roadmapBefore.indexOf('## [CK.02]'),
    );

    const out = run(['phase', 'insert', '01', 'Hotfix'], dir);

    assert.equal(out.phase_number, '01.01');
    assert.equal(out.directory, '.planning/phases/CK.02-01.01-hotfix');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.01-hotfix')), true);

    const roadmapAfter = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const ck01SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.01]'),
      roadmapAfter.indexOf('## [CK.02]'),
    );
    assert.equal(ck01SectionAfter, ck01SectionBefore);

    const ck02SectionAfter = roadmapAfter.slice(roadmapAfter.indexOf('## [CK.02]'));
    assert.equal(ck02SectionAfter.includes('### [CK.02] 01.01: Hotfix (INSERTED)'), true);
    assert.equal(roadmapAfter.includes('### [CK.01] 01.01'), false);
  });

  // #4304 follow-up: the ADR-612 canonical milestone heading carries no vX.Y
  // token at all (`## [GSD.09] Hidden`) — currentMilestoneRawRanges must
  // scope the insertion point for this shape too, not only the vX.Y-bearing
  // shape every other fixture in this file uses.
  test('phase insert scopes the insertion point to the active milestone when milestone headings carry no version token', () => {
    const dir = project('adr-612-bracket-versionless-insert-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    const roadmapBefore = [
      '# Roadmap',
      '',
      '## [CK.01] Prior',
      '',
      '### [CK.01] 01: Old One',
      '',
      '**Goal:** untouched',
      '',
      '### [CK.01] 02: Old Two',
      '',
      '**Goal:** also untouched',
      '',
      '## [CK.02] Current',
      '',
      '### [CK.02] 01: One',
      '',
      '**Goal:** keep',
      '',
    ].join('\n');
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), roadmapBefore);
    fs.mkdirSync(planning(dir, 'phases', 'CK.01-01-old-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.01-02-old-two'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });

    const ck01SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.01]'),
      roadmapBefore.indexOf('## [CK.02]'),
    );

    const out = run(['phase', 'insert', '01', 'Hotfix'], dir);

    assert.equal(out.phase_number, '01.01');
    assert.equal(out.directory, '.planning/phases/CK.02-01.01-hotfix');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.01-hotfix')), true);

    const roadmapAfter = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const ck01SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.01]'),
      roadmapAfter.indexOf('## [CK.02]'),
    );
    assert.equal(ck01SectionAfter, ck01SectionBefore);

    const ck02SectionAfter = roadmapAfter.slice(roadmapAfter.indexOf('## [CK.02]'));
    assert.equal(ck02SectionAfter.includes('### [CK.02] 01.01: Hotfix (INSERTED)'), true);
    assert.equal(roadmapAfter.includes('### [CK.01] 01.01'), false);
  });

  test('phase insert --sibling allocates the next bracket subphase at the parent level', () => {
    const dir = project('adr-612-bracket-sibling-insert-');
    writeBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01.01-first'), { recursive: true });
    fs.appendFileSync(
      planning(dir, 'ROADMAP.md'),
      '### [CK.02] 01.02: Second (INSERTED)\n\n**Goal:** Existing\n',
    );

    const out = run(['phase', 'insert', '01.02', 'Sibling Hotfix', '--sibling'], dir);

    assert.equal(out.phase_number, '01.03');
    assert.equal(out.directory, '.planning/phases/CK.02-01.03-sibling-hotfix');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.03-sibling-hotfix')), true);
    assert.equal(
      fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8')
        .includes('### [CK.02] 01.03: Sibling Hotfix (INSERTED)'),
      true,
    );
  });

  // #4304 round-5 W4 (fix): `phase insert 1.1` normalized its bare argument
  // through the legacy normalizePhaseName, which pads only the FIRST
  // segment ("1.1" -> "01.1") and never matches the bracket-canonical
  // "01.01" heading, so it errored "Phase 1.1 not found" even though
  // `phase remove 1.1` (via phaseToken) resolves the very same phase.
  // `phase insert 01.01` (default nested) died with an uncaught
  // "toDir: invalid phase" throw instead of a clean refusal, because
  // nesting one level under an already-decimal phase produces a
  // three-level id bracket cannot represent. Both spellings now
  // canonicalize identically (through phaseToken, like remove) and both
  // refuse cleanly with the SAME message naming the correctly-resolved
  // "01.01" — proving canonicalization found the real phase rather than
  // reporting it missing.
  test('phase insert canonicalizes a bare decimal argument the way phase remove does', () => {
    const dir = project('adr-612-bracket-insert-decimal-canon-');
    writeBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01.01-first-sub'), { recursive: true });
    fs.appendFileSync(
      planning(dir, 'ROADMAP.md'),
      '### [CK.02] 01.01: First Sub (INSERTED)\n\n**Goal:** Existing\n',
    );
    const before = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const dirsBefore = fs.readdirSync(planning(dir, 'phases')).sort();

    const bare = runGsdTools(['phase', 'insert', '1.1', 'Urgent fix'], dir);
    const padded = runGsdTools(['phase', 'insert', '01.01', 'Urgent fix'], dir);

    assert.equal(bare.success, false, bare.output);
    assert.equal(padded.success, false, padded.output);
    assert.match(bare.error, /01\.01/);
    assert.match(padded.error, /01\.01/);
    assert.doesNotMatch(bare.error, /not found/i);
    assert.match(bare.error, /decimal level/i);
    assert.match(padded.error, /decimal level/i);
    assert.equal(bare.error, padded.error);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), before);
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(planning(dir, 'phases')).sort(), dirsBefore);
  });

  test('phase insert --sibling under a decimal afterPhase still succeeds (only nested three-level ids are refused)', () => {
    const dir = project('adr-612-bracket-insert-decimal-sibling-');
    writeBracketFixture(dir);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01.01-first-sub'), { recursive: true });
    fs.appendFileSync(
      planning(dir, 'ROADMAP.md'),
      '### [CK.02] 01.01: First Sub (INSERTED)\n\n**Goal:** Existing\n',
    );

    const out = run(['phase', 'insert', '1.1', 'Second Sub', '--sibling'], dir);

    assert.equal(out.phase_number, '01.02');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-01.02-second-sub')), true);
  });

  // #4304 round 6 (I1): `phase insert` only ever canonicalized a BARE
  // argument through phaseToken (round 5's W4) — a qualified id
  // ("CK.02-01") or a display id ("[CK.02] 01") failed phaseToken (which
  // only ever accepts digits/dots) and refused with "cannot be resolved",
  // even though `phase remove` already accepts both forms. Insert now
  // canonicalizes through the SAME shared adapter remove uses
  // (canonicalizeBracketPhaseArgument).
  test('phase insert accepts the qualified and display bracket argument forms remove accepts', () => {
    const bareDir = project('adr-612-bracket-insert-args-bare-');
    writeBracketFixture(bareDir);
    const bare = run(['phase', 'insert', '1', 'Urgent fix'], bareDir);

    const qualifiedDir = project('adr-612-bracket-insert-args-qualified-');
    writeBracketFixture(qualifiedDir);
    const qualified = run(['phase', 'insert', 'CK.02-01', 'Urgent fix'], qualifiedDir);

    const displayDir = project('adr-612-bracket-insert-args-display-');
    writeBracketFixture(displayDir);
    const display = run(['phase', 'insert', '[CK.02] 01', 'Urgent fix'], displayDir);

    for (const out of [bare, qualified, display]) {
      assert.equal(out.phase_number, '01.01');
      assert.equal(out.directory, '.planning/phases/CK.02-01.01-urgent-fix');
    }
    assert.equal(
      fs.readFileSync(planning(qualifiedDir, 'ROADMAP.md'), 'utf8'),
      fs.readFileSync(planning(bareDir, 'ROADMAP.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(planning(displayDir, 'ROADMAP.md'), 'utf8'),
      fs.readFileSync(planning(bareDir, 'ROADMAP.md'), 'utf8'),
    );
  });

  // #4304 round 6 (I1): insert's directory allocation called `toDir`
  // directly, bypassing the bracketDirNameOrRefuse wrapper `phase add`/
  // `phase add-batch` already route through (round 5, B4) — an
  // empty-slug or all-digit description crashed with an uncaught
  // "toDir: slug sanitizes to empty" throw instead of the wrapper's clean
  // "Cannot create a phase directory for ..." refusal. Both controls use
  // committed git fixtures so their result cannot depend on HOME's global git
  // discovery/configuration state before they reach that refusal.
  test('phase insert refuses an empty-slug description through the SAME wrapper phase add uses, before any mutation', () => {
    const dir = gitProject('adr-612-bracket-insert-emptyslug-');
    writeBracketFixture(dir);
    const before = snapshotTree(planning(dir));

    const insertResult = runGsdTools(['phase', 'insert', '1', '!!!'], dir);
    const addDir = gitProject('adr-612-bracket-insert-emptyslug-add-control-');
    writeBracketFixture(addDir);
    const addResult = runGsdTools(['phase', 'add', '!!!'], addDir);

    assert.equal(insertResult.success, false, insertResult.output);
    assert.match(insertResult.error, /Cannot create a phase directory for "!!!"/);
    assert.equal(
      insertResult.error.replace(/^Error: /, '').split(':').slice(0, 2).join(':'),
      addResult.error.replace(/^Error: /, '').split(':').slice(0, 2).join(':'),
    );
    assert.deepEqual(snapshotTree(planning(dir)), before);
  });

  test('state descriptive writes use bracket display while operational fields stay compatible', () => {
    const dir = project();
    writeBracketFixture(dir);

    run(['state', 'begin-phase', '--phase', '02', '--name', 'User Dashboard', '--plans', '2'], dir);

    const state = fs.readFileSync(planning(dir, 'STATE.md'), 'utf8');
    assert.equal(state.includes('**Last Activity Description:** [CK.02] 02 execution started'), true);
    assert.equal(state.includes('**Current focus:** [CK.02] 02 — User Dashboard'), true);
    assert.equal(state.includes('**Current Phase:** 02'), true);
    assert.equal(state.includes('**Status:** Executing Phase 02'), true);
    assert.equal(state.includes('Status: Executing Phase 02'), true);
    assert.match(state, /Last activity: \d{4}-\d{2}-\d{2} — \[CK\.02\] 02 execution started/);
    assert.equal(state.includes('Phase: 02 (User Dashboard) — EXECUTING'), true);
  });

  test('a repeated bracket begin-phase is a resume and preserves mid-flight counters', () => {
    const dir = project('adr-612-state-resume-');
    writeBracketFixture(dir);
    run(['state', 'begin-phase', '--phase', '02', '--name', 'User Dashboard', '--plans', '2'], dir);

    const statePath = planning(dir, 'STATE.md');
    fs.writeFileSync(
      statePath,
      fs.readFileSync(statePath, 'utf8').replace('**Current Plan:** 1', '**Current Plan:** 2'),
    );

    run(['state', 'begin-phase', '--phase', '02', '--name', 'Ignored Resume Name', '--plans', '9'], dir);
    const resumed = fs.readFileSync(statePath, 'utf8');
    assert.equal(resumed.includes('**Status:** Executing Phase 02'), true);
    assert.equal(resumed.includes('**Current Plan:** 2'), true);
    assert.equal(resumed.includes('**Total Plans in Phase:** 2'), true);
    assert.equal(resumed.includes('**Current Phase Name:** User Dashboard'), true);
    assert.match(resumed, /Last activity: \d{4}-\d{2}-\d{2} — \[CK\.02\] 02 execution resumed/);
  });

  test('state planned-phase and complete-phase descriptions use bracket display', () => {
    const plannedDir = project('adr-612-state-planned-');
    writeBracketFixture(plannedDir);
    const plannedStatePath = planning(plannedDir, 'STATE.md');
    fs.writeFileSync(
      plannedStatePath,
      fs.readFileSync(plannedStatePath, 'utf8')
        .replace('Last activity: 2026-09-01 — Roadmap created', 'Last activity: 2026-09-01'),
    );
    run(['state', 'planned-phase', '--phase', '02', '--name', 'User Dashboard', '--plans', '2'], plannedDir);
    assert.equal(
      fs.readFileSync(planning(plannedDir, 'STATE.md'), 'utf8')
        .includes('**Last Activity Description:** [CK.02] 02 planning complete — 2 plans ready'),
      true,
    );
    assert.match(
      fs.readFileSync(planning(plannedDir, 'STATE.md'), 'utf8'),
      /Last activity: \d{4}-\d{2}-\d{2} — \[CK\.02\] 02 planning complete/,
    );

    const completeDir = project('adr-612-state-complete-');
    writeBracketFixture(completeDir);
    run(['state', 'begin-phase', '--phase', '02', '--name', 'User Dashboard', '--plans', '2'], completeDir);
    run(['state', 'complete-phase', '--phase', '02'], completeDir);
    const completed = fs.readFileSync(planning(completeDir, 'STATE.md'), 'utf8');
    assert.equal(completed.includes('**Last Activity Description:** [CK.02] 02 marked complete'), true);
    assert.equal(completed.includes('**Status:** Phase 02 complete'), true);
    assert.equal(completed.includes('Status: Phase 02 complete'), true);
    assert.match(completed, /Last activity: \d{4}-\d{2}-\d{2} — \[CK\.02\] 02 marked complete/);
    assert.equal(completed.includes('Phase: 02 — COMPLETE'), true);
  });

  test('a state write materializes milestone frontmatter from the active ROADMAP milestone', () => {
    const dir = project('adr-612-state-milestone-');
    writeBracketFixture(dir);
    const statePath = planning(dir, 'STATE.md');
    const withoutMilestone = fs.readFileSync(statePath, 'utf8')
      .replace('milestone: v2.0\n', '')
      .replace('milestone_name: Foundation\n', '');
    fs.writeFileSync(statePath, withoutMilestone);

    run(['state', 'begin-phase', '--phase', '01', '--name', 'Foundation', '--plans', '1'], dir);

    const state = fs.readFileSync(statePath, 'utf8');
    assert.equal(state.includes('milestone: v2.0'), true);
    assert.equal(JSON.parse(runGsdTools(['state', 'json'], dir).output).milestone, 'v2.0');
  });

  // #4304 round-3 Blocker 2: phaseEntryInsertOffset called currentMilestoneRawRanges
  // without the resolved convention, so on version-less bracket headings
  // (`## [CK.02] Current` followed by `## [CK.03] Future`) it got null and
  // fell back to whole-document insertion (past CK.03, at EOF) instead of
  // the active milestone's own end.
  function versionlessTwoMilestoneRoadmap() {
    return [
      '# Roadmap',
      '',
      '## [CK.02] Current',
      '',
      '### [CK.02] 01: One',
      '',
      '**Goal:** keep',
      '',
      '## [CK.03] Future',
      '',
      '### [CK.03] 01: Later',
      '',
      '**Goal:** untouched',
      '',
    ].join('\n');
  }

  test('phase add scopes the insertion point to the active milestone when milestone headings carry no version token', () => {
    const dir = project('adr-612-bracket-versionless-add-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    const roadmapBefore = versionlessTwoMilestoneRoadmap();
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), roadmapBefore);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.03-01-later'), { recursive: true });

    const ck03SectionBefore = roadmapBefore.slice(roadmapBefore.indexOf('## [CK.03]'));

    const out = run(['phase', 'add', 'Two'], dir);

    assert.equal(out.phase_number, 2);
    assert.equal(out.directory, '.planning/phases/CK.02-02-two');
    assert.equal(fs.existsSync(planning(dir, 'phases', 'CK.02-02-two')), true);

    const roadmapAfter = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const ck03SectionAfter = roadmapAfter.slice(roadmapAfter.indexOf('## [CK.03]'));
    assert.equal(ck03SectionAfter, ck03SectionBefore);

    const ck02SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.02]'),
      roadmapAfter.indexOf('## [CK.03]'),
    );
    assert.equal(ck02SectionAfter.includes('### [CK.02] 02: Two'), true);
  });

  test('phase add-batch scopes the insertion point to the active milestone when milestone headings carry no version token', () => {
    const dir = project('adr-612-bracket-versionless-addbatch-');
    writeConfig(dir, 'bracket');
    fs.writeFileSync(planning(dir, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    const roadmapBefore = versionlessTwoMilestoneRoadmap();
    fs.writeFileSync(planning(dir, 'ROADMAP.md'), roadmapBefore);
    fs.mkdirSync(planning(dir, 'phases', 'CK.02-01-one'), { recursive: true });
    fs.mkdirSync(planning(dir, 'phases', 'CK.03-01-later'), { recursive: true });

    const ck03SectionBefore = roadmapBefore.slice(roadmapBefore.indexOf('## [CK.03]'));

    const out = run(['phase', 'add-batch', '--descriptions', '["Two","Three"]'], dir);

    assert.deepEqual(out.phases.map((phase) => phase.phase_number), [2, 3]);
    assert.deepEqual(
      out.phases.map((phase) => phase.directory),
      ['.planning/phases/CK.02-02-two', '.planning/phases/CK.02-03-three'],
    );

    const roadmapAfter = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    const ck03SectionAfter = roadmapAfter.slice(roadmapAfter.indexOf('## [CK.03]'));
    assert.equal(ck03SectionAfter, ck03SectionBefore);

    const ck02SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.02]'),
      roadmapAfter.indexOf('## [CK.03]'),
    );
    assert.equal(ck02SectionAfter.includes('### [CK.02] 02: Two'), true);
    assert.equal(ck02SectionAfter.includes('### [CK.02] 03: Three'), true);
  });
});

const LEGACY_ROADMAP_BYTES = '# Roadmap\n\n'
  + '### Phase 1: Foundation\n\n'
  + '**Goal:** Existing\n\n'
  + '### Phase 01.1: Hotfix (INSERTED)\n\n'
  + '**Goal:** [Urgent work - to be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 1\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n'
  + '- [ ] TBD (run /gsd-plan-phase 01.1 to break down)\n\n'
  + '### Phase 2: Second\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 1\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n'
  + '- [ ] TBD (run /gsd-plan-phase 2 to break down)\n\n'
  + '### Phase 3: Third\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 2\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n'
  + '- [ ] TBD (run /gsd-plan-phase 3 to break down)\n\n'
  + '### Phase 4: Fourth\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 3\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n'
  + '- [ ] TBD (run /gsd-plan-phase 4 to break down)\n';

for (const convention of [null, 'sequential', 'milestone-prefixed']) {
  test(`#4304 byte identity: ${String(convention)} preserves phase add/add-batch/insert output`, () => {
    const dir = project('adr-612-legacy-bytes-');
    writeConfig(dir, convention);
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Existing\n',
    );

    const add = run(['phase', 'add', 'Second'], dir);
    const batch = run(['phase', 'add-batch', '--descriptions', '["Third","Fourth"]'], dir);
    const insert = run(['phase', 'insert', '1', 'Hotfix'], dir);

    assert.deepEqual(
      [add.phase_number, batch.phases.map((phase) => phase.phase_number), insert.phase_number],
      [2, [3, 4], '01.1'],
    );
    assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), LEGACY_ROADMAP_BYTES);
    assert.deepEqual(
      fs.readdirSync(planning(dir, 'phases')).sort(),
      ['CK-01.1-hotfix', 'CK-02-second', 'CK-03-third', 'CK-04-fourth'],
    );

    fs.writeFileSync(planning(dir, 'phases', 'CK-02-second', '02-01-PLAN.md'), '# Plan\n');
    for (const query of ['02', '2']) {
      const result = runGsdTools(['find-phase', query], dir);
      assert.equal(result.success, true, result.error);
      assert.equal(
        result.output,
        [
          '{',
          '  "found": true,',
          '  "directory": ".planning/phases/CK-02-second",',
          '  "phase_number": "02",',
          '  "phase_name": "second",',
          '  "plans": [',
          '    "02-01-PLAN.md"',
          '  ],',
          '  "summaries": [],',
          '  "plan_count": 1,',
          '  "summary_count": 0,',
          '  "plan_count_all": 1',
          '}',
        ].join('\n'),
        query,
      );
    }
    const qualified = runGsdTools(['find-phase', 'CK.02-02'], dir);
    assert.equal(qualified.success, true, qualified.error);
    assert.equal(
      qualified.output,
      [
        '{',
        '  "found": false,',
        '  "directory": null,',
        '  "phase_number": null,',
        '  "phase_name": null,',
        '  "plans": [],',
        '  "summaries": [],',
        '  "plan_count": null,',
        '  "summary_count": null,',
        '  "plan_count_all": null,',
        '  "searched_directories": [',
        '    ".planning/phases"',
        '  ]',
        '}',
      ].join('\n'),
    );
  });
}

for (const convention of [null, 'sequential', 'milestone-prefixed']) {
  test(`#4304 normalization parity: ${String(convention)} matches upstream/next for a fenced phase heading`, () => {
    const dir = project('adr-612-legacy-fenced-normalization-');
    writeConfig(dir, convention);
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Foundation',
        '**Goal:** Existing',
        '',
        '```md',
        '### Phase 99: Example',
        'prose',
        '```',
        '',
      ].join('\n'),
    );

    run(['phase', 'add', 'Second'], dir);

    const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
    assert.equal(
      roadmap.includes('```md\n\n### Phase 99: Example\n\nprose\n```'),
      true,
      'legacy write bytes must match upstream/next normalization',
    );
  });
}

test('#4304 byte identity: non-bracket phase-plan-index and init execute-phase outputs do not vary by convention', () => {
  const outputs = [];
  for (const convention of [null, 'sequential', 'milestone-prefixed']) {
    const dir = project('adr-612-legacy-lookup-bytes-');
    writeConfig(dir, convention);
    fs.writeFileSync(
      planning(dir, 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 2: Second\n\n**Goal:** Existing\n',
    );
    const phaseDir = planning(dir, 'phases', 'CK-02-second');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '---\nwave: 1\n---\n');

    const index = runGsdTools(['phase-plan-index', '02'], dir);
    assert.equal(index.success, true, index.error);
    const execute = runGsdTools(['init', 'execute-phase', '02'], dir);
    assert.equal(execute.success, true, execute.error);
    // The outputs carry the project root in three spellings on Windows: native
    // (`project_root`, JSON-escaped in the raw text), POSIX (`phase_dir`, #2376)
    // and the bare native form; scrub all of them before comparing.
    const scrub = (text) => [JSON.stringify(dir).slice(1, -1), toPosixPath(dir), dir]
      .reduce((acc, form) => acc.replaceAll(form, '<PROJECT>'), text);
    outputs.push({
      index: scrub(index.output),
      execute: scrub(execute.output),
    });
  }

  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0]);
});

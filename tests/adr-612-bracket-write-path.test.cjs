'use strict';

// allow-test-rule: source-text-is-the-product — see #4304
// ROADMAP.md and STATE.md are the writer outputs under test, so their exact bytes
// are the public contract at this seam.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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

function run(args, cwd) {
  const result = runGsdTools(args, cwd);
  assert.equal(result.success, true, `${args.join(' ')} failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

describe('#4304 / ADR-612 PR-4 bracket writers', () => {
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
});

const LEGACY_ROADMAP_BYTES = '# Roadmap\n\n'
  + '### Phase 1: Foundation\n\n'
  + '**Goal:** Existing\n\n'
  + '### Phase 01.1: Hotfix (INSERTED)\n\n'
  + '**Goal:** [Urgent work - to be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 1\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n\n'
  + '- [ ] TBD (run /gsd-plan-phase 01.1 to break down)\n\n'
  + '### Phase 2: Second\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 1\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n\n'
  + '- [ ] TBD (run /gsd-plan-phase 2 to break down)\n\n'
  + '### Phase 3: Third\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 2\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n\n'
  + '- [ ] TBD (run /gsd-plan-phase 3 to break down)\n\n'
  + '### Phase 4: Fourth\n\n'
  + '**Goal:** [To be planned]\n'
  + '**Requirements**: TBD\n'
  + '**Depends on:** Phase 3\n'
  + '**Plans:** 0 plans\n\n'
  + 'Plans:\n\n'
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
  });
}

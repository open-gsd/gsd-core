/**
 * Cross-site agreement of the ROADMAP phase-entry WRITERS with the phase-entry
 * grammar (#5764, Phase 4 of epic #5692; readers were Phase 3, #5763).
 *
 * Generates phase-list entries in every accepted form (marker x gap x box
 * state x bold token x indent) and applies each writer (`phase complete`,
 * `phase remove`, `roadmap update-plan-progress`, `roadmap upgrade`'s id
 * rewrite). Each writer must find the same entry every reader finds, change
 * only that entry, and leave the entry's form untouched. A writer with a
 * divergent private pattern is shown red by the positive control.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup, createTempDir } = require('./helpers.cjs');
const { computeMigrationPlan } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
const { checklistBulletExtent, getRoadmapPhaseInternal } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { buildStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
const { buildPlanningSnapshot } = require('../gsd-core/bin/lib/planning-snapshot.cjs');

const SEED = 5764;

const formArb = fc.record({
  indent: fc.constantFrom('', '  ', '\t'),
  marker: fc.constantFrom('-', '*'),
  gap1: fc.constantFrom('', ' ', '  '),
  state: fc.constantFrom(' ', 'x', 'X'),
  gap2: fc.constantFrom('', ' '),
  bold: fc.constantFrom('**', '__', ''),
});
const uncheckedFormArb = formArb.map((f) => ({ ...f, state: ' ' }));

function render(form, id = '1') {
  const label = `Phase ${id}: Name`;
  const wrapped = form.bold ? `${form.bold}${label}${form.bold}` : label;
  return `${form.indent}${form.marker}${form.gap1}[${form.state}]${form.gap2}${wrapped}`;
}

/** Lines that open a checklist entry of any accepted form. */
const entryLines = (text) => text.split('\n').filter((l) => /^[ \t]*[-*][ \t]*\[[ xX]\]/.test(l.replace(/\r$/, '')));

function writeProject(dir, roadmap, { phases = [], state = '---\nmilestone: v1.0.0\n---\n' } = {}) {
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), '{}');
  fs.writeFileSync(path.join(planning, 'STATE.md'), state);
  for (const [name, files] of phases) {
    fs.mkdirSync(path.join(planning, 'phases', name), { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(planning, 'phases', name, file), body);
  }
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap);
}

const readRoadmap = (dir) => fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
const MILESTONE = ['# Roadmap', '', '## Current Milestone: v1.0.0 - T', ''];

/**
 * A writer: `run(form)` applies the writer to a project whose ROADMAP carries
 * `render(form, ...)` entries and returns the problems it finds, or null when
 * the form is outside what that writer is meant to see.
 */
function writers() {
  return [
    {
      name: 'phase complete (tick + stamp)',
      run: (form) => {
        if (form.state !== ' ') return null;
        const dir = createTempProject();
        try {
          writeProject(
            dir,
            [...MILESTONE, render(form, '1'), render(form, '2'), '', '### Phase 1: Name', '**Goal:** g', '**Plans:** 1 plans', '', '### Phase 2: Name', '**Goal:** g', ''].join('\n'),
            {
              phases: [['01-a', {
                '01-01-PLAN.md': '# Plan\n',
                '01-01-SUMMARY.md': '# Summary\n',
                '01-VERIFICATION.md': '---\nstatus: passed\n---\n# V\n',
              }]],
              state: '---\nmilestone: v1.0.0\n---\n# State\n\n**Current Phase:** 01\n**Status:** In progress\n',
            },
          );
          const result = runGsdTools(['phase', 'complete', '1'], dir);
          const entries = entryLines(readRoadmap(dir));
          const problems = [];
          if (!result.success) problems.push(`phase complete failed: ${result.error}`);
          if (!entries[0] || !entries[0].startsWith(render({ ...form, state: 'x' }, '1'))) {
            problems.push(`phase 1 entry not ticked in form: ${JSON.stringify(entries[0])}`);
          }
          if (entries[1] !== render(form, '2')) problems.push(`phase 2 entry changed: ${JSON.stringify(entries[1])}`);
          return problems;
        } finally {
          cleanup(dir);
        }
      },
    },
    {
      name: 'phase remove (delete + renumber)',
      run: (form) => {
        const dir = createTempProject();
        try {
          writeProject(
            dir,
            [...MILESTONE, render(form, '1'), render(form, '2'), render(form, '3'), '', '### Phase 1: Name', '', '### Phase 2: Name', '', '### Phase 3: Name', ''].join('\n'),
          );
          const result = runGsdTools(['phase', 'remove', '2'], dir);
          const entries = entryLines(readRoadmap(dir));
          const problems = [];
          if (!result.success) problems.push(`phase remove failed: ${result.error}`);
          if (entries.length !== 2) problems.push(`expected 2 entries after remove, got ${JSON.stringify(entries)}`);
          if (entries[0] !== render(form, '1')) problems.push(`phase 1 entry changed: ${JSON.stringify(entries[0])}`);
          if (entries[1] !== render(form, '2')) problems.push(`old phase 3 not renumbered to 2 in form: ${JSON.stringify(entries[1])}`);
          return problems;
        } finally {
          cleanup(dir);
        }
      },
    },
    {
      name: 'roadmap update-plan-progress (stamp + nested row)',
      run: (form) => {
        if (form.state !== ' ') return null;
        const dir = createTempProject();
        try {
          writeProject(
            dir,
            [...MILESTONE, render(form, '1'), '  - [ ] 01-01-PLAN.md', '', '### Phase 1: Name', '**Goal:** g', '**Plans:** 1 plans', '', 'Plans:', '- [ ] 01-01-PLAN.md', ''].join('\n'),
            {
              phases: [['01-a', {
                '01-01-PLAN.md': '# Plan\n',
                '01-01-SUMMARY.md': '# Summary\n',
                '01-VERIFICATION.md': '---\nstatus: passed\n---\n# V\n',
              }]],
            },
          );
          const result = runGsdTools(['roadmap', 'update-plan-progress', '1'], dir);
          const entries = entryLines(readRoadmap(dir));
          const problems = [];
          if (!result.success) problems.push(`update-plan-progress failed: ${result.error}`);
          if (!entries[0] || !entries[0].startsWith(render({ ...form, state: 'x' }, '1'))) {
            problems.push(`phase 1 entry not stamped in form: ${JSON.stringify(entries[0])}`);
          }
          return problems;
        } finally {
          cleanup(dir);
        }
      },
    },
    {
      name: 'roadmap upgrade (checklist id rewrite)',
      run: (form) => {
        const dir = createTempDir('writers-upgrade-');
        try {
          const planning = path.join(dir, '.planning');
          fs.mkdirSync(path.join(planning, 'phases', '01-foo'), { recursive: true });
          fs.mkdirSync(path.join(planning, 'phases', '02-bar'), { recursive: true });
          fs.writeFileSync(
            path.join(planning, 'ROADMAP.md'),
            ['## v1.0: First Milestone', '', render(form, '1'), render(form, '2'), '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'),
          );
          const edits = computeMigrationPlan(dir).roadmapEdits;
          const problems = [];
          for (const id of ['1', '2']) {
            const edit = edits.find((e) => e.from === render(form, id));
            if (!edit) {
              problems.push(`no id rewrite for ${JSON.stringify(render(form, id))}`);
            } else if (edit.to.slice(0, edit.to.indexOf('Phase')) !== edit.from.slice(0, edit.from.indexOf('Phase'))) {
              problems.push(`rewrite changed the entry form: ${JSON.stringify(edit)}`);
            }
          }
          return problems;
        } finally {
          cleanup(dir);
        }
      },
    },
  ];
}

describe('phase-entry writers agree with the grammar on every accepted form (#5764)', () => {
  for (const writer of writers()) {
    test(`${writer.name}: finds, changes and preserves the entry in every accepted form`, () => {
      fc.assert(
        fc.property(formArb, (form) => {
          const problems = writer.run(form);
          if (problems !== null) assert.deepEqual(problems, [], `form ${JSON.stringify(render(form))}`);
        }),
        { seed: SEED, numRuns: 24 },
      );
    });
  }

  test('positive control: a writer with a divergent private pattern is red', () => {
    // The pre-#5764 shape: hyphen only, lowercase x only, `**` bold only.
    const divergent = {
      name: 'divergent-writer',
      run: (form) => {
        const flipped = render(form, '1').replace(/^([ \t]*-\s*\[)[ ](\]\s*(?:\*\*)?\s*Phase\s+1)/i, '$1x$2');
        return flipped === render(form, '1') ? [`did not flip ${JSON.stringify(render(form, '1'))}`] : [];
      },
    };
    const reds = [];
    for (const marker of ['-', '*']) {
      for (const bold of ['**', '__']) {
        const form = { indent: '', marker, gap1: ' ', state: ' ', gap2: ' ', bold };
        for (const writer of [...writers(), divergent]) {
          const problems = writer.run(form);
          if (problems && problems.length) reds.push(`${writer.name}: ${problems.join('; ')}`);
        }
      }
    }
    assert.ok(reds.some((r) => r.startsWith('divergent-writer')), 'the divergent writer must be reported');
    assert.deepEqual(reds.filter((r) => !r.startsWith('divergent-writer')), [], 'real writers stay green');
  });
});

describe('writers leave text that is not a phase entry alone (#5764)', () => {
  let dir;
  beforeEach(() => {
    dir = createTempProject();
  });
  afterEach(() => cleanup(dir));

  test('phase remove does not delete or renumber a mid-line mention or a blockquote', () => {
    writeProject(
      dir,
      [
        ...MILESTONE,
        '- [ ] **Phase 1: Name**',
        '- [ ] **Phase 2: Name**',
        '- [ ] **Phase 3: Name**',
        '',
        'See - [ ] Phase 2: Name for the rationale.',
        '> - [ ] **Phase 3: Name**',
        '',
        '### Phase 1: Name',
        '',
        '### Phase 2: Name',
        '',
        '### Phase 3: Name',
        '',
      ].join('\n'),
    );
    const result = runGsdTools(['phase', 'remove', '2'], dir);
    assert.ok(result.success, result.error);
    const text = readRoadmap(dir);
    assert.match(text, /^See - \[ \] Phase 2: Name for the rationale\.$/m, 'a mid-line mention is not an entry');
    assert.match(text, /^> - \[ \] \*\*Phase 3: Name\*\*$/m, 'a blockquote is not an entry');
    assert.deepEqual(entryLines(text), ['- [ ] **Phase 1: Name**', '- [ ] **Phase 2: Name**']);
  });

  test('phase complete ticks Phase 2 only: Phase 2.1 and Phase 20 are different phases', () => {
    writeProject(
      dir,
      [...MILESTONE, '- [ ] **Phase 2: Name**', '- [ ] **Phase 2.1: Name**', '- [ ] **Phase 20: Name**', '', '### Phase 2: Name', '**Goal:** g', '**Plans:** 1 plans', ''].join('\n'),
      {
        phases: [['02-a', {
          '02-01-PLAN.md': '# Plan\n',
          '02-01-SUMMARY.md': '# Summary\n',
          '02-VERIFICATION.md': '---\nstatus: passed\n---\n# V\n',
        }]],
        state: '---\nmilestone: v1.0.0\n---\n# State\n\n**Current Phase:** 02\n**Status:** In progress\n',
      },
    );
    const result = runGsdTools(['phase', 'complete', '2'], dir);
    assert.ok(result.success, result.error);
    const entries = entryLines(readRoadmap(dir));
    assert.match(entries[0], /^- \[x\] \*\*Phase 2: Name\*\*/);
    assert.equal(entries[1], '- [ ] **Phase 2.1: Name**');
    assert.equal(entries[2], '- [ ] **Phase 20: Name**');
  });

  test('phase complete on a CRLF ROADMAP keeps each entry on one CRLF line', () => {
    writeProject(
      dir,
      [...MILESTONE, '* [ ] **Phase 1: Name**', '* [ ] **Phase 2: Name**', '', '### Phase 1: Name', '**Goal:** g', '**Plans:** 1 plans', ''].join('\r\n'),
      {
        phases: [['01-a', {
          '01-01-PLAN.md': '# Plan\n',
          '01-01-SUMMARY.md': '# Summary\n',
          '01-VERIFICATION.md': '---\nstatus: passed\n---\n# V\n',
        }]],
        state: '---\nmilestone: v1.0.0\n---\n# State\n\n**Current Phase:** 01\n**Status:** In progress\n',
      },
    );
    const result = runGsdTools(['phase', 'complete', '1'], dir);
    assert.ok(result.success, result.error);
    const [first, second] = entryLines(readRoadmap(dir));
    assert.match(first, /^\* \[x\] \*\*Phase 1: Name\*\* \(completed \d{4}-\d{2}-\d{2}\)\r$/, 'stamp stays before the line ending');
    assert.equal(second, '* [ ] **Phase 2: Name**\r');
  });
});

describe('checklistBulletExtent honors the bullet indent whatever the match shape (#5764)', () => {
  test('an indent-only capture (the roadmap.cts span scans) stops at a shallower line', () => {
    const text = '  - [ ] **Phase 1: A**\n  - [ ] 01-01-PLAN.md\nPlans: kept outside\n  - [ ] 01-02-PLAN.md\n';
    const bullet = /^([ \t]*)-/m.exec(text);
    const { start, end } = checklistBulletExtent(text, bullet);
    assert.equal(text.slice(start, end), '  - [ ] 01-01-PLAN.md\n');
  });

  test('an opening-bracket capture (phaseChecklistBullet) gives the same extent', () => {
    const text = '  - [ ] **Phase 1: A**\n  - [ ] 01-01-PLAN.md\nPlans: kept outside\n  - [ ] 01-02-PLAN.md\n';
    const bullet = /^([ \t]*-[ \t]*\[)/m.exec(text);
    const { start, end } = checklistBulletExtent(text, bullet);
    assert.equal(text.slice(start, end), '  - [ ] 01-01-PLAN.md\n');
  });
});

describe('the remaining bullet readers accept every form the grammar accepts (#5764)', () => {
  let dir;
  beforeEach(() => {
    dir = createTempProject();
  });
  afterEach(() => cleanup(dir));

  const forms = [
    '- [ ] **Phase {ID}: Name**',
    '* [ ] **Phase {ID}: Name**',
    '  - [x] __Phase {ID}: Name__',
    '- [X] **Phase {ID}: Name**',
  ];

  test('state-contract `## Phases` checklist fallback finds and ticks each form', () => {
    for (const template of forms) {
      const entry = (id) => template.replace('{ID}', id);
      writeProject(dir, ['# Roadmap', '', '## Phases', '', entry('1'), entry('2').replace('[ ]', '[x]'), ''].join('\n'), { state: '---\nmilestone: v1.0\n---\n# State\n' });
      const phases = buildStateContract(dir).phases.map((p) => p.number);
      assert.deepEqual(phases, ['1', '2'], `phases for ${JSON.stringify(entry('1'))}`);
    }
  });

  test('planning-snapshot checkbox state reads each form', () => {
    for (const template of forms) {
      const ticked = /\[[xX]\]/.test(template);
      writeProject(dir, ['# Roadmap', '', '## Phases', '', template.replace('{ID}', '1'), ''].join('\n'));
      const snapshot = buildPlanningSnapshot(dir);
      assert.deepEqual(snapshot.roadmapPhaseCheckboxes.value, { 1: ticked }, `state for ${JSON.stringify(template)}`);
    }
  });

  test('the bullet-only phase lookup finds each form, including the `__` wrapper', () => {
    for (const template of forms) {
      writeProject(dir, ['# Roadmap', '', template.replace('{ID}', '36'), ''].join('\n'));
      const found = getRoadmapPhaseInternal(dir, '36');
      assert.ok(found && found.found, `lookup for ${JSON.stringify(template)}`);
      assert.equal(found.phase_name, 'Name');
    }
  });
});

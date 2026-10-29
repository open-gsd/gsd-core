/**
 * Cross-site agreement on the phase-entry grammar: readers (#5763, Phase 3 of
 * #5692) and writers (#5764, Phase 4).
 *
 * Generates phase-list entries in every accepted form (marker x gap x box
 * state/case x bold token x indent). Readers must reach the same verdict:
 * whether the phase exists and whether it is ticked. Writers (`phase complete`,
 * `phase remove`, `roadmap update-plan-progress`, the `roadmap upgrade` id
 * rewrite) must find the same entry the readers find, change only that entry,
 * and leave its form untouched. A reader or writer with a divergent private
 * pattern is shown red by the positive controls.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup, createTempDir } = require('./helpers.cjs');
const { buildRoadmapPhaseVariants, buildNotStartedPhaseVariants } = require('../gsd-core/bin/lib/validate.cjs');
const { hasPhaseEntries } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { checklistEntrySrc } = require('../gsd-core/bin/lib/roadmap.cjs');
const { isPhaseEntryChecked } = require('../gsd-core/bin/lib/phase-entry-grammar.cjs');
const { parsePhaseChecklistLine } = require('../gsd-core/bin/lib/phase-id.cjs');
const { computeMigrationPlan } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
const { checklistBulletExtent, getRoadmapPhaseInternal } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { buildStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
const { buildPlanningSnapshot } = require('../gsd-core/bin/lib/planning-snapshot.cjs');

const SEED = 5763;
const WRITER_SEED = 5764;

const formArb = fc.record({
  indent: fc.constantFrom('', '  ', '\t'),
  marker: fc.constantFrom('-', '*'),
  gap1: fc.constantFrom(' ', '  ', '\t'),
  state: fc.constantFrom(' ', 'x', 'X'),
  gap2: fc.constantFrom('', ' '),
  bold: fc.constantFrom('**', '__', ''),
});

/** `Phase <id>: Name`, bold-wrapped when the form carries a bold token. */
function render(form, id = '1') {
  const label = `Phase ${id}: Name`;
  const wrapped = form.bold ? `${form.bold}${label}${form.bold}` : label;
  return `${form.indent}${form.marker}${form.gap1}[${form.state}]${form.gap2}${wrapped}`;
}

const isTicked = (form) => form.state !== ' ';

/**
 * A reader: `read(form)` -> verdict `{ found, ticked }`, or null when the form
 * is outside what that reader is meant to see (a bold-required reader skips
 * the bold-less forms).
 */
function pureReaders() {
  return [
    {
      name: 'validate.buildRoadmapPhaseVariants',
      read: (form) => ({
        found: buildRoadmapPhaseVariants(`# Roadmap\n\n${render(form)}\n`).roadmapPhases.has('1'),
        ticked: null,
      }),
    },
    {
      name: 'validate.buildNotStartedPhaseVariants',
      read: (form) => {
        const notStarted = buildNotStartedPhaseVariants(`# Roadmap\n\n${render(form)}\n`).has('1');
        // "not started" is the unchecked half: found-and-unchecked <=> state ' '.
        return { found: true, ticked: !notStarted };
      },
    },
    {
      name: 'phase-id.parsePhaseChecklistLine',
      read: (form) => {
        const parsed = parsePhaseChecklistLine(render(form), null);
        return { found: parsed !== null && parsed.phaseToken === '1', ticked: parsed ? parsed.checked : null };
      },
    },
    {
      name: 'roadmap.checklistEntrySrc',
      read: (form) => {
        if (!form.bold) return null; // bold-required reader
        const text = `# Roadmap\n\n${render(form)}\n`;
        const m = new RegExp(checklistEntrySrc(null), 'im').exec(text);
        return { found: m !== null, ticked: m ? isPhaseEntryChecked(m[0]) : null };
      },
    },
    {
      name: 'roadmap-parser.hasPhaseEntries',
      read: (form) => {
        if (!form.bold) return null; // bold-required reader
        return { found: hasPhaseEntries(`# Roadmap\n\n${render(form)}\n`), ticked: null };
      },
    },
  ];
}

/** Verdicts every reader must share for one form; returns the disagreements. */
function disagreements(form, readers) {
  const out = [];
  for (const reader of readers) {
    const verdict = reader.read(form);
    if (verdict === null) continue;
    if (!verdict.found) out.push(`${reader.name}: did not find ${JSON.stringify(render(form))}`);
    else if (verdict.ticked !== null && verdict.ticked !== isTicked(form)) {
      out.push(`${reader.name}: read ticked=${verdict.ticked} for ${JSON.stringify(render(form))}`);
    }
  }
  return out;
}

describe('phase-entry readers agree on the accepted grammar (#5763)', () => {
  test('every pure-string reader agrees on every accepted form', () => {
    fc.assert(
      fc.property(formArb, (form) => {
        assert.deepEqual(disagreements(form, pureReaders()), []);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  test('positive control: a reader with a divergent private pattern is red', () => {
    const divergent = {
      // The pre-#5763 shape: hyphen only, lowercase x only, bold required.
      name: 'divergent-reader',
      read: (form) => {
        const m = /-\s*\[([ x])\]\s*\*\*Phase\s+1:/i.exec(render(form));
        return { found: m !== null, ticked: m ? m[1] === 'x' : null };
      },
    };
    const readers = [...pureReaders(), divergent];
    const reds = [];
    for (const marker of ['-', '*']) {
      for (const bold of ['**', '__']) {
        reds.push(...disagreements({ indent: '', marker, gap1: ' ', state: 'X', gap2: ' ', bold }, readers));
      }
    }
    assert.ok(reds.some((r) => r.startsWith('divergent-reader')), 'the divergent reader must be reported');
    assert.ok(!reds.some((r) => !r.startsWith('divergent-reader')), `real readers stay green: ${reds.join('; ')}`);
  });
});

describe('CLI readers agree on the accepted grammar (#5763)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => cleanup(tmpDir));

  function writeRoadmap(entries, details = '') {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Milestone: v1.0\n\n${entries.join('\n')}\n\n${details}`,
    );
  }

  test('roadmap analyze: roadmap_record and roadmap_complete follow the tick for every form', () => {
    fc.assert(
      fc.property(formArb.filter((f) => f.bold !== ''), (form) => {
        writeRoadmap([render(form)], '### Phase 1: Name\n\n**Goal**: g\n');
        const result = runGsdTools('roadmap analyze', tmpDir);
        assert.ok(result.success, result.error);
        const out = JSON.parse(result.output);
        assert.equal(out.roadmap_record['1'], isTicked(form), `roadmap_record for ${JSON.stringify(render(form))}`);
        assert.equal(out.phases[0].roadmap_complete, isTicked(form), `roadmap_complete for ${JSON.stringify(render(form))}`);
      }),
      { seed: SEED, numRuns: 30 },
    );
  });

  test('phase next-decimal sees a checklist sibling in every accepted form', () => {
    fc.assert(
      fc.property(formArb, (form) => {
        writeRoadmap([render(form, '1'), render(form, '1.1')], '### Phase 1: Name\n\n**Goal**: g\n');
        const result = runGsdTools('phase next-decimal 1 --raw', tmpDir);
        assert.ok(result.success, result.error);
        assert.match(result.output.trim(), /1\.2$/, `next decimal after ${JSON.stringify(render(form, '1.1'))}`);
      }),
      { seed: SEED, numRuns: 30 },
    );
  });
});

// ─── Writers (#5764) ─────────────────────────────────────────────────────────

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
      // A flip writer only ever sees an unchecked entry, so generate those.
      const arb = writer.name.startsWith('phase complete') || writer.name.startsWith('roadmap update-plan-progress')
        ? formArb.map((f) => ({ ...f, state: ' ' }))
        : formArb;
      fc.assert(
        fc.property(arb, (form) => {
          const problems = writer.run(form);
          if (problems !== null) assert.deepEqual(problems, [], `form ${JSON.stringify(render(form))}`);
        }),
        { seed: WRITER_SEED, numRuns: 24 },
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

  test('phase remove renumbers decorated entries too, and a mention inside another entry is not an entry', () => {
    writeProject(
      dir,
      [
        ...MILESTONE,
        '- [ ] **Phase 1: A**',
        '- [x] ~~**Phase 2: B**~~',
        '- [ ] 🚧 **Phase 3: C**',
        '- [ ] **Phase 4: D**, needs Phase 2: B',
        '',
        '### Phase 1: A',
        '',
        '### Phase 2: B',
        '',
        '### Phase 3: C',
        '',
        '### Phase 4: D',
        '',
      ].join('\n'),
    );
    const result = runGsdTools(['phase', 'remove', '1', '--force'], dir);
    assert.ok(result.success, result.error);
    assert.deepEqual(entryLines(readRoadmap(dir)), [
      '- [x] ~~**Phase 1: B**~~',
      '- [ ] 🚧 **Phase 2: C**',
      '- [ ] **Phase 3: D**, needs Phase 2: B',
    ]);
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

  test('phase complete on a CRLF ROADMAP stamps the entry on its own line (the writer normalizes to LF)', () => {
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
    const text = readRoadmap(dir);
    assert.equal(text.includes('\r'), false, 'no stray carriage return is left behind');
    const [first, second] = entryLines(text);
    assert.match(first, /^\* \[x\] \*\*Phase 1: Name\*\* \(completed \d{4}-\d{2}-\d{2}\)$/, 'the stamp lands on the entry line');
    assert.equal(second, '* [ ] **Phase 2: Name**');
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

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

let tmpDir;

const planning = (...parts) => path.join(tmpDir, '.planning', ...parts);

function makePhaseDir(name, files = []) {
  const dir = planning('phases', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), '# artifact\n');
}

function snapshotTree(root) {
  const snapshot = [];
  function visit(dir, relativeDir = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(relativeDir, entry.name);
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot.push({ type: 'directory', path: relative });
        visit(absolute, relative);
      } else {
        snapshot.push({
          type: 'file',
          path: relative,
          bytes: fs.readFileSync(absolute).toString('base64'),
        });
      }
    }
  }
  visit(root);
  return snapshot;
}

function replaceSeed(roadmapLines, phaseDirs) {
  fs.writeFileSync(planning('ROADMAP.md'), roadmapLines.join('\n'));
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this fixture helper replaces only seed()'s known .planning/phases subtree; helpers.cleanup() would destroy the whole live fixture.
  fs.rmSync(planning('phases'), { recursive: true, force: true });
  for (const [name, files] of phaseDirs) makePhaseDir(name, files);
}

function seed() {
  fs.writeFileSync(
    planning('config.json'),
    JSON.stringify({ project_code: 'CK', phase_id_convention: 'bracket' }, null, 2) + '\n',
  );
  fs.writeFileSync(
    planning('STATE.md'),
    '---\nmilestone: v2.0\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
  );
  fs.writeFileSync(
    planning('ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## [CK.01] v1.0 — Prior',
      '',
      '- [ ] [CK.01] 02: Prior Decoy',
      '',
      '### [CK.01] 02: Prior Decoy',
      '**Goal:** untouched',
      '',
      '## [CK.02] v2.0 — Current',
      '',
      '- [ ] [CK.02] 01: One',
      '- [ ] [CK.02] 01.01: First Insert',
      '- [ ] [CK.02] 01.02: Second Insert',
      '- [ ] [CK.02] 02: Two',
      '- [ ] [CK.02] 03: Three',
      '- [ ] [CK.02] 04: Four',
      '',
      '### [CK.02] 01: One',
      '**Goal:** keep',
      '',
      '### [CK.02] 01.01: First Insert',
      '**Goal:** remove independently',
      '',
      '### [CK.02] 01.02: Second Insert',
      '**Goal:** renumber independently',
      '**Plans:** `01.02-01-PLAN.md`',
      '',
      '### [CK.02] 02: Two',
      '**Goal:** remove',
      '',
      '### [CK.02] 03: Three',
      '**Goal:** renumber',
      '**Plans:** `03-01-PLAN.md`',
      '',
      '### [CK.02] 04: Four',
      '**Goal:** renumber after an occupied destination moves',
      '**Depends on:** [CK.02] 03',
      '**Plans:** `04-01-PLAN.md`',
      '',
      '## Progress',
      '',
      '| Phase | Plans | Status |',
      '| --- | --- | --- |',
      '| [CK.01] 02 | 0/1 | Prior |',
      '| [CK.02] 01 | 0/1 | Planned |',
      '| [CK.02] 01.01 | 0/1 | Planned |',
      '| [CK.02] 01.02 | 0/1 | Planned |',
      '| [CK.02] 02 | 0/1 | Planned |',
      '| [CK.02] 03 | 0/1 | Planned |',
      '| [CK.02] 04 | 0/1 | Planned |',
      '',
    ].join('\n'),
  );
  makePhaseDir('CK.01-02-prior-decoy', ['02-01-PLAN.md']);
  makePhaseDir('CK.02-01-one', ['01-01-PLAN.md']);
  makePhaseDir('CK.02-01.01-first-insert', ['01.01-01-PLAN.md']);
  makePhaseDir('CK.02-01.02-second-insert', ['01.02-01-PLAN.md']);
  makePhaseDir('CK.02-02-two', ['02-01-PLAN.md']);
  makePhaseDir('CK.02-03-three', ['03-01-PLAN.md']);
  makePhaseDir('CK.02-04-four', ['04-01-PLAN.md']);
}

function seedLegacyOnlyRemovalTarget({ legacyDirectory, legacyHeading }) {
  replaceSeed(
    [
      '# Roadmap',
      '',
      '## [CK.02] v2.0 — Current',
      '',
      ...(legacyHeading ? ['### Phase 2: Old work', '**Goal:** migrate before removing', ''] : []),
      '### [CK.02] 03: New work',
      '**Goal:** must not renumber on refusal',
      '',
    ],
    [
      ...(legacyDirectory ? [['CK-02-old-work', ['02-01-PLAN.md']]] : []),
      ['CK.02-03-new-work', ['03-01-PLAN.md']],
    ],
  );
}

function managerPhase(phaseNumber) {
  const result = runGsdTools(['init', 'manager'], tmpDir);
  assert.equal(result.success, true, result.error || result.output);
  const phase = JSON.parse(result.output).phases.find((row) => row.number === phaseNumber);
  assert.ok(phase, `manager must report phase ${phaseNumber}`);
  return phase;
}

describe('#4304 / ADR-612 bracket phase remove', () => {
  beforeEach(() => {
    tmpDir = createTempProject('adr-612-remove-');
    seed();
  });
  afterEach(() => cleanup(tmpDir));

  test('removes and renumbers only inside the active milestone bracket', () => {
    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.directory_deleted, 'CK.02-02-two');
    assert.deepEqual(
      fs.readdirSync(planning('phases')).sort(),
      [
        'CK.01-02-prior-decoy',
        'CK.02-01-one',
        'CK.02-01.01-first-insert',
        'CK.02-01.02-second-insert',
        'CK.02-02-three',
        'CK.02-03-four',
      ],
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-03-four', '03-01-PLAN.md')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.01] 02: Prior Decoy'), true);
    assert.equal(roadmap.includes('| [CK.01] 02 | 0/1 | Prior |'), true);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('### [CK.02] 03: Four'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] 02'), true);
    assert.equal(roadmap.includes('`02-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('`03-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('| [CK.02] 02 | 0/1 | Planned |'), true);
    assert.equal(roadmap.includes('| [CK.02] 03 | 0/1 | Planned |'), true);
    assert.equal(roadmap.includes('| [CK.02] 04 | 0/1 | Planned |'), false);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \|/gm) ?? []).length, 1);
  });

  test('renumbers every continuation token in a qualified dependency list', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [x] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '- [ ] [CK.02] 04: Four',
        '',
        '### [CK.02] 01: One',
        '**Goal:** complete prerequisite',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** incomplete prerequisite',
        '',
        '### [CK.02] 04: Four',
        '**Goal:** blocked dependent',
        '**Depends on:** [CK.02] Phase 01 and 03',
        '',
      ],
      [
        ['CK.02-01-one', ['01-01-PLAN.md', '01-01-SUMMARY.md', '01-VERIFICATION.md']],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
        ['CK.02-04-four', []],
      ],
    );
    fs.writeFileSync(
      planning('phases', 'CK.02-01-one', '01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n',
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('**Depends on:** [CK.02] Phase 01 and 02'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] Phase 01 and 03'), false);

    const dependent = managerPhase('03');
    assert.deepEqual(dependent.dep_phases, ['[CK.02] 01', '[CK.02] 02']);
    assert.equal(dependent.deps_satisfied, false);
    assert.equal(dependent.is_next_to_discuss, false);
  });

  test('reports a removed identity in a qualified-list continuation token', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** dependent',
        '**Depends on:** [CK.02] Phase 01 and 02',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const dependsLine = splitLines(roadmap).indexOf('**Depends on:** [CK.02] Phase 01 and 02') + 1;

    assert.ok(dependsLine > 0, 'dangling continuation token must survive');
    assert.deepEqual(out.references_left_untouched, [dependsLine]);
  });

  test('refuses before mutation when bracket removal would rename into a symlinked directory path', () => {
    const outside = path.join(tmpDir, 'outside-remove-target');
    fs.mkdirSync(outside);
    const link = planning('phases', 'CK.02-02-three');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const roadmapBefore = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /symbolic link|outside the planning phases directory/i);
    assert.equal(fs.readFileSync(planning('ROADMAP.md'), 'utf8'), roadmapBefore);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-two')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-03-three')), true);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  test('removes a bracket subphase and renumbers only later siblings', () => {
    const result = runGsdTools(['phase', 'remove', '01.01', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-first-insert')), false);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-second-insert')), true);
    assert.equal(
      fs.existsSync(planning('phases', 'CK.02-01.01-second-insert', '01.01-01-PLAN.md')),
      true,
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-two')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('First Insert'), false);
    assert.equal(roadmap.includes('### [CK.02] 01.01: Second Insert'), true);
    assert.equal(roadmap.includes('### [CK.02] 01.02: Second Insert'), false);
    assert.equal(roadmap.includes('`01.01-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('| [CK.02] 01.02 |'), false);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 01\.01 \|/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), true);
  });

  // #4304 Blocker 1: a qualified bracket id (`CK.02-02`) used to resolve and
  // delete its directory, then crash on `parseInt(normalized, 10)` (NaN)
  // inside renameBracketPhases/updateRoadmapAfterBracketPhaseRemoval, leaving
  // ROADMAP and STATE unsynced with the already-deleted directory. The fix
  // parses the qualified form through parsePhaseId and validates it BEFORE
  // any deletion.
  test('removes a phase using its fully-qualified bracket id, identically to the bare form', () => {
    const result = runGsdTools(['phase', 'remove', 'CK.02-02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.directory_deleted, 'CK.02-02-two');
    assert.equal(out.roadmap_updated, true);
    assert.equal(out.state_updated, true);
    assert.deepEqual(
      fs.readdirSync(planning('phases')).sort(),
      [
        'CK.01-02-prior-decoy',
        'CK.02-01-one',
        'CK.02-01.01-first-insert',
        'CK.02-01.02-second-insert',
        'CK.02-02-three',
        'CK.02-03-four',
      ],
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-03-four', '03-01-PLAN.md')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.01] 02: Prior Decoy'), true);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('### [CK.02] 03: Four'), true);
  });

  test('removes a phase using its fully-qualified decimal bracket id (subphase)', () => {
    const result = runGsdTools(['phase', 'remove', 'CK.02-01.01', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-first-insert')), false);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-second-insert')), true);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('First Insert'), false);
    assert.equal(roadmap.includes('### [CK.02] 01.01: Second Insert'), true);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), true);
  });

  test('refuses a qualified id naming a different milestone, leaving the directory in place', () => {
    const roadmapBefore = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const dirsBefore = fs.readdirSync(planning('phases')).sort();

    const result = runGsdTools(['phase', 'remove', 'CK.01-02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /active milestone/i);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-02-prior-decoy')), true);
    assert.equal(fs.readFileSync(planning('ROADMAP.md'), 'utf8'), roadmapBefore);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), dirsBefore);
  });

  test('refuses a nested bracket phase argument before mutating any planning file or directory', () => {
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '1.1.1', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /cannot be resolved to a bracket phase number/i);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  test('refuses a nonnumeric bracket phase argument before mutating any planning file or directory', () => {
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', 'abc', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /cannot be resolved to a bracket phase number/i);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  // #4304 round-3 Blocker 1: `normalizePhaseName` (the legacy grammar) pads
  // only a decimal query's leading integer, not its subphase segment — "1.1"
  // normalizes to "01.1", not the bracket directory's own "01.01" — so the
  // bare-argument path never matched CK.02-01.01-first, yet still deleted the
  // ROADMAP section and renumbered 01.02 to 01.01, leaving the undeleted
  // 01.01 directory and the renamed-from-01.02 directory both claiming
  // subphase 01.01.
  test('removes a phase using an unpadded bracket subphase argument, identically to the padded form', () => {
    const result = runGsdTools(['phase', 'remove', '1.1', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.directory_deleted, 'CK.02-01.01-first-insert');
    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-first-insert')), false);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-01.01-second-insert')), true);
    assert.equal(
      fs.existsSync(planning('phases', 'CK.02-01.01-second-insert', '01.01-01-PLAN.md')),
      true,
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-two')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('First Insert'), false);
    assert.equal(roadmap.includes('### [CK.02] 01.01: Second Insert'), true);
    assert.equal(roadmap.includes('### [CK.02] 01.02: Second Insert'), false);
    assert.equal(roadmap.includes('`01.01-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('| [CK.02] 01.02 |'), false);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 01\.01 \|/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), true);
  });

  test('padded and unpadded spellings of the same bracket subphase id produce byte-identical results', () => {
    const dirUnpadded = createTempProject('adr-612-remove-unpadded-');
    const dirPadded = createTempProject('adr-612-remove-padded-');
    const savedTmpDir = tmpDir;
    try {
      tmpDir = dirUnpadded;
      seed();
      const resultUnpadded = runGsdTools(['phase', 'remove', '1.1', '--force'], dirUnpadded);
      assert.equal(resultUnpadded.success, true, resultUnpadded.error || resultUnpadded.output);

      tmpDir = dirPadded;
      seed();
      const resultPadded = runGsdTools(['phase', 'remove', '01.01', '--force'], dirPadded);
      assert.equal(resultPadded.success, true, resultPadded.error || resultPadded.output);
    } finally {
      tmpDir = savedTmpDir;
    }

    const roadmapUnpadded = fs.readFileSync(path.join(dirUnpadded, '.planning', 'ROADMAP.md'), 'utf8');
    const roadmapPadded = fs.readFileSync(path.join(dirPadded, '.planning', 'ROADMAP.md'), 'utf8');
    assert.equal(roadmapUnpadded, roadmapPadded);

    const dirsUnpadded = fs.readdirSync(path.join(dirUnpadded, '.planning', 'phases')).sort();
    const dirsPadded = fs.readdirSync(path.join(dirPadded, '.planning', 'phases')).sort();
    assert.deepEqual(dirsUnpadded, dirsPadded);

    cleanup(dirUnpadded);
    cleanup(dirPadded);
  });

  // #4304 Blocker 3: the artifact-token rewrite (`03-01-PLAN.md` -> `02-01-PLAN.md`)
  // ran as a global replace with no milestone qualifier, so an EARLIER
  // milestone's own same-numbered artifact reference was corrupted even
  // though that milestone's directory/files were never touched. The display-id
  // rewrite (`[CK.02] 03` -> `[CK.02] 02`) was already milestone-qualified and
  // safe; only the bare-token rewrite needed scoping.
  test('confines artifact-token renumbering to the active milestone, leaving an earlier milestone byte-identical', () => {
    fs.writeFileSync(
      planning('ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.01] v1.0 — Prior',
        '',
        '### [CK.01] 03: Prior Three',
        '',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Two',
        '',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 03 | 0/1 | Prior |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ].join('\n'),
    );
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (this test replaces seed()'s ROADMAP with its own, and the seeded phase dirs would otherwise leak in as unrelated rename candidates); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(planning('phases'), { recursive: true, force: true });
    makePhaseDir('CK.01-03-prior-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']);
    makePhaseDir('CK.02-02-two', ['02-01-PLAN.md']);
    makePhaseDir('CK.02-03-three', ['03-01-PLAN.md']);

    const roadmapBefore = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.01]'),
      roadmapBefore.indexOf('## [CK.02]'),
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmapAfter = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.01]'),
      roadmapAfter.indexOf('## [CK.02]'),
    );
    assert.equal(ck01SectionAfter, ck01SectionBefore);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-SUMMARY.md')), true);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 03: Three'), false);
  });

  // #4304 follow-up: the ADR-612 canonical milestone heading carries no vX.Y
  // token at all (`## [GSD.09] Hidden`) — currentMilestoneRawRanges must
  // scope the artifact-token rewrite for this shape too, not only the
  // vX.Y-bearing shape every other fixture in this file uses.
  test('confines artifact-token renumbering to the active milestone when milestone headings carry no version token', () => {
    fs.writeFileSync(
      planning('ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.01] Prior',
        '',
        '### [CK.01] 03: Prior Three',
        '',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        '',
        '## [CK.02] Current',
        '',
        '### [CK.02] 02: Two',
        '',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 03 | 0/1 | Prior |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ].join('\n'),
    );
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (this test replaces seed()'s ROADMAP with its own, and the seeded phase dirs would otherwise leak in as unrelated rename candidates); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(planning('phases'), { recursive: true, force: true });
    makePhaseDir('CK.01-03-prior-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']);
    makePhaseDir('CK.02-02-two', ['02-01-PLAN.md']);
    makePhaseDir('CK.02-03-three', ['03-01-PLAN.md']);

    const roadmapBefore = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.01]'),
      roadmapBefore.indexOf('## [CK.02]'),
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmapAfter = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.01]'),
      roadmapAfter.indexOf('## [CK.02]'),
    );
    assert.equal(ck01SectionAfter, ck01SectionBefore);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-SUMMARY.md')), true);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 03: Three'), false);
  });

  // #4304 round-3 Blocker 3: round 2 confined BOTH the display-id replace and
  // the bare artifact-token replace to `ranges.primary`, but a fully
  // qualified reference (a global Progress table AFTER a later sibling
  // milestone, e.g. CK.03) carries its own milestone and cannot collide —
  // scoping it too left it stale after a renumber.
  test('renumbers fully qualified references in a global Progress table outside the active milestone section, while another milestone stays byte-identical', () => {
    fs.writeFileSync(
      planning('ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## [CK.01] v1.0 — Prior',
        '',
        '### [CK.01] 03: Prior Three',
        '',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Two',
        '',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '### [CK.03] 01: Later',
        '',
        '**Goal:** untouched by the CK.02 removal',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 03 | 0/1 | Prior |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.03] 01 | 0/1 | Future |',
        '',
      ].join('\n'),
    );
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (this test replaces seed()'s ROADMAP with its own, and the seeded phase dirs would otherwise leak in as unrelated rename candidates); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(planning('phases'), { recursive: true, force: true });
    makePhaseDir('CK.01-03-prior-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']);
    makePhaseDir('CK.02-02-two', ['02-01-PLAN.md']);
    makePhaseDir('CK.02-03-three', ['03-01-PLAN.md']);
    makePhaseDir('CK.03-01-later', []);

    const roadmapBefore = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.01]'),
      roadmapBefore.indexOf('## [CK.02]'),
    );
    const ck03SectionBefore = roadmapBefore.slice(
      roadmapBefore.indexOf('## [CK.03]'),
      roadmapBefore.indexOf('## Progress'),
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmapAfter = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck01SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.01]'),
      roadmapAfter.indexOf('## [CK.02]'),
    );
    assert.equal(ck01SectionAfter, ck01SectionBefore);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior-three', '03-01-SUMMARY.md')), true);

    const ck03SectionAfter = roadmapAfter.slice(
      roadmapAfter.indexOf('## [CK.03]'),
      roadmapAfter.indexOf('## Progress'),
    );
    assert.equal(ck03SectionAfter, ck03SectionBefore);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmapAfter.includes('### [CK.02] 03: Three'), false);

    const progressAfter = roadmapAfter.slice(roadmapAfter.indexOf('## Progress'));
    assert.equal(progressAfter.includes('| [CK.02] 02 | 0/1 | Planned |'), true);
    assert.equal(progressAfter.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.equal(progressAfter.includes('| [CK.01] 03 | 0/1 | Prior |'), true);
    assert.equal(progressAfter.includes('| [CK.03] 01 | 0/1 | Future |'), true);
    assert.equal((progressAfter.match(/^\| \[CK\.02\] 02 \|/gm) ?? []).length, 1);
  });

  test('discovers and renumbers later phases in both the active primary and Phase Details ranges', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '### [CK.03] 01: Future',
        '**Goal:** untouched',
        '',
        '## [CK.02] v2.0 — Current (Phase Details)',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ],
      [
        ['CK.02-02-two', ['02-01-PLAN.md']],
        ['CK.02-03-three', ['03-01-PLAN.md']],
        ['CK.03-01-future', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('`02-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('## [CK.03] v3.0 — Future'), true);
    assert.equal(out.roadmap_lines_rewritten > 0, true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  for (const { name, legacyDirectory, legacyHeading } of [
    { name: 'directory and heading', legacyDirectory: true, legacyHeading: true },
    { name: 'directory only', legacyDirectory: true, legacyHeading: false },
    { name: 'heading only', legacyDirectory: false, legacyHeading: true },
  ]) {
    test(`refuses a bracket-path removal that resolves only to a legacy ${name}`, () => {
      seedLegacyOnlyRemovalTarget({ legacyDirectory, legacyHeading });
      const before = snapshotTree(planning());

      const result = runGsdTools(['phase', 'remove', '2', '--force'], tmpDir);

      assert.equal(result.success, false, result.output);
      if (legacyDirectory) assert.match(result.error, /CK-02-old-work/);
      if (legacyHeading) assert.match(result.error, /### Phase 2: Old work/);
      assert.match(result.error, /roadmap upgrade --convention bracket/);
      assert.deepEqual(snapshotTree(planning()), before);
    });
  }

  test('removes a bracket target beside legacy siblings and renumbers only bracket identities', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Bracket target',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Bracket successor',
        '**Goal:** renumber',
        '',
        '### Phase 9: Legacy sibling',
        '**Goal:** preserve byte-for-byte',
        '',
      ],
      [
        ['CK.02-02-bracket-target', ['02-01-PLAN.md']],
        ['CK.02-03-bracket-successor', ['03-01-PLAN.md']],
        ['CK-09-legacy-sibling', ['09-01-PLAN.md']],
      ],
    );
    const result = runGsdTools(['phase', 'remove', '2', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    assert.equal(out.directory_deleted, 'CK.02-02-bracket-target');
    assert.deepEqual(out.renamed_directories, [
      { from: 'CK.02-03-bracket-successor', to: 'CK.02-02-bracket-successor' },
    ]);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-bracket-successor', '02-01-PLAN.md')), true);
    assert.equal(fs.existsSync(planning('phases', 'CK-09-legacy-sibling', '09-01-PLAN.md')), true);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Bracket successor'), true);
    assert.equal(roadmap.includes('### Phase 9: Legacy sibling'), true);
    assert.equal(roadmap.includes('**Goal:** preserve byte-for-byte'), true);
  });

  test('legacy-convention removal retains its exact heading and directory behavior', () => {
    fs.writeFileSync(
      planning('config.json'),
      JSON.stringify({ project_code: 'CK', phase_id_convention: null }, null, 2) + '\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## v2.0 — Current',
        '',
        '### Phase 1: One',
        '**Goal:** keep',
        '',
        '### Phase 2: Two',
        '**Goal:** remove',
        '',
        '### Phase 3: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['01-one', ['01-01-PLAN.md']],
        ['02-two', ['02-01-PLAN.md']],
        ['03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '2', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    assert.equal(out.directory_deleted, '02-two');
    assert.deepEqual(out.renamed_directories, [{ from: '03-three', to: '02-three' }]);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['01-one', '02-three']);
    assert.equal(fs.readFileSync(planning('ROADMAP.md'), 'utf8'), [
      '# Roadmap',
      '',
      '## v2.0 — Current',
      '',
      '### Phase 1: One',
      '',
      '**Goal:** keep',
      '',
      '### Phase 2: Three',
      '',
      '**Goal:** renumber',
      '',
    ].join('\n'));
    assert.equal(fs.readFileSync(planning('phases', '01-one', '01-01-PLAN.md'), 'utf8'), '# artifact\n');
    assert.equal(fs.readFileSync(planning('phases', '02-three', '02-01-PLAN.md'), 'utf8'), '# artifact\n');
  });

  test('renumbers only complete qualified identities, preserving prefixed and subphase identities byte-for-byte', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Depends on:** CK.02-03',
        'Boundary decoy: XCK.02-03-other',
        'Subphase decoy: CK.02-03.1',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal(roadmap.includes('**Depends on:** CK.02-02'), true);
    assert.equal(roadmap.includes('Boundary decoy: XCK.02-03-other'), true);
    assert.equal(roadmap.includes('Subphase decoy: CK.02-03.1'), true);
    assert.equal(roadmap.includes('XCK.02-02-other'), false);
    assert.equal(roadmap.includes('CK.02-02.1'), false);
  });

  test('renumbers bare artifact filenames without rewriting a filename owned by a directory path', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `../CK.01-03-prior/03-01-PLAN.md`, `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        '',
      ],
      [
        ['CK.01-03-prior', ['03-01-PLAN.md']],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal(
      roadmap.includes('**Plans:** `../CK.01-03-prior/03-01-PLAN.md`, `02-01-PLAN.md`, `02-01-SUMMARY.md`'),
      true,
    );
    assert.equal(roadmap.includes('../CK.01-03-prior/02-01-PLAN.md'), false);
    assert.equal(fs.existsSync(planning('phases', 'CK.01-03-prior', '03-01-PLAN.md')), true);
  });

  test('rewrites only owned roadmap line classes and reports untouched phase prose', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] **[CK.02] 02: Two**',
        '- [ ] [CK.02] 03 Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03 (FOLLOW-UP): Three',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] 03',
        '**Plans:** `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        'Qualified reference: CK.02-03',
        'Phase 03 remains prose and must stay byte-identical.',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const lines = splitLines(roadmap);
    const proseLine = lines.indexOf('Phase 03 remains prose and must stay byte-identical.') + 1;

    assert.equal(roadmap.includes('- [ ] **[CK.02] 02: Two**'), false);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02 Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 02 (FOLLOW-UP): Three'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] 02'), true);
    assert.equal(roadmap.includes('**Plans:** `02-01-PLAN.md`, `02-01-SUMMARY.md`'), true);
    assert.equal(roadmap.includes('Qualified reference: CK.02-02'), true);
    assert.equal(lines[proseLine - 1], 'Phase 03 remains prose and must stay byte-identical.');
    assert.equal(roadmap.includes('| [CK.02] 02 | 0/1 | Planned |'), true);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \|/gm) ?? []).length, 1);
    assert.equal(out.roadmap_lines_rewritten, 9);
    assert.deepEqual(out.references_left_untouched, [proseLine]);
  });

  // #4304 round-5 Blocker 1: classifyBracketOwnedLine's table-row guard and
  // bold-cell strip were regex LITERALS written with doubled backslashes
  // (`/^[ \\t]*\\|/`, `/^\\*\\*(.*)\\*\\*$/`), so the guard matched every
  // line (an empty alternation branch) and any prose line beginning with the
  // removed phase's display id was misclassified 'progress' and deleted
  // anywhere in the document — the preamble, another milestone's section, a
  // trailing '## Notes' section, all outside the active milestone. Free
  // prose is never an owned line class and must survive byte-identical; a
  // genuine (optionally bold) pipe-table row whose first cell is the
  // target's complete identity is the only thing removed, wherever it sits.
  test('leaves free prose byte-identical everywhere and deletes only genuine (bold or plain) progress rows', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '[CK.02] 02 mentioned before any milestone heading must stay untouched.',
        '',
        '## [CK.01] v1.0 — Prior',
        '',
        '[CK.02] 02 referenced from another milestone section must stay untouched.',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Notes',
        '',
        '[CK.02] 02 was descoped; its work moved to the auth epic.',
        '[CK.02] 02: descoped (colon form)',
        '[CK.02] 02',
        'Keep: see [CK.02] 02 for history.',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| **[CK.02] 02** | 0/1 | Planned |',
        '| **[CK.02] 03** | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal(
      roadmap.includes('[CK.02] 02 mentioned before any milestone heading must stay untouched.'),
      true,
    );
    assert.equal(
      roadmap.includes('[CK.02] 02 referenced from another milestone section must stay untouched.'),
      true,
    );
    assert.equal(
      roadmap.includes('[CK.02] 02 was descoped; its work moved to the auth epic.'),
      true,
    );
    assert.equal(roadmap.includes('[CK.02] 02: descoped (colon form)'), true);
    assert.equal(splitLines(roadmap).includes('[CK.02] 02'), true);
    assert.equal(roadmap.includes('Keep: see [CK.02] 02 for history.'), true);

    assert.equal(roadmap.includes('| **[CK.02] 02** | 0/1 | Planned |'), true);
    assert.equal(roadmap.includes('| **[CK.02] 03** | 0/1 | Planned |'), false);
    assert.equal((roadmap.match(/^\| \*\*\[CK\.02\] 02\*\* \|/gm) ?? []).length, 1);
  });

  // #4304 round-5 Blocker 2: renameBracketPhases renames a later phase's
  // sub-phase directories and artifact files on disk (03.01 -> 02.01), but
  // updateRoadmapAfterBracketPhaseRemoval's own token collection tracked
  // only bare integer phase numbers, so a decimal identity like
  // `[CK.02] 03.01` never got a renumber mapping entry and every ROADMAP
  // spelling of it (checklist, heading, progress row, bare artifact token)
  // was left pointing at the pre-renumber id while disk had already moved.
  // Both consumers must now come from the same identity mapping.
  test('renumbers a later phase\'s sub-phase on disk and in ROADMAP from one mapping', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '- [ ] [CK.02] 03.01: Three Sub',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '### [CK.02] 03.01: Three Sub',
        '**Goal:** renumber sub',
        '**Depends on:** [CK.02] 03',
        '**Plans:** `03.01-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.02] 03.01 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', ['01-01-PLAN.md']],
        ['CK.02-02-two', ['02-01-PLAN.md']],
        ['CK.02-03-three', ['03-01-PLAN.md']],
        ['CK.02-03.01-three-sub', ['03.01-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.deepEqual(
      fs.readdirSync(planning('phases')).sort(),
      ['CK.02-01-one', 'CK.02-02-three', 'CK.02-02.01-three-sub'],
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(
      fs.existsSync(planning('phases', 'CK.02-02.01-three-sub', '02.01-01-PLAN.md')),
      true,
    );

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('- [ ] [CK.02] 02.01: Three Sub'), true);
    assert.equal(roadmap.includes('### [CK.02] 02.01: Three Sub'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] 02'), true);
    assert.equal(roadmap.includes('**Plans:** `02.01-01-PLAN.md`'), true);
    assert.equal(roadmap.includes('| [CK.02] 02.01 | 0/1 | Planned |'), true);
    assert.equal(roadmap.includes('03.01'), false);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round-5 Blocker 5: references_left_untouched re-searched the
  // PERSISTED (already-rewritten) content for pre-renumber ids, so whenever
  // two or more phases shift, a later phase's NEW value collides textually
  // with an earlier phase's OLD value and every correctly-rewritten line
  // is reported as "untouched". Computing the report from the ORIGINAL
  // line instead makes each occurrence unambiguous.
  test('does not report correctly-renumbered lines as untouched when two phases shift', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '- [ ] [CK.02] 04: Four',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '### [CK.02] 04: Four',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] 03',
        '**Plans:** `04-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.02] 04 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', ['01-01-PLAN.md']],
        ['CK.02-02-two', ['02-01-PLAN.md']],
        ['CK.02-03-three', ['03-01-PLAN.md']],
        ['CK.02-04-four', ['04-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Four'), true);
    assert.equal(roadmap.includes('**Depends on:** [CK.02] 02'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round-5 Blocker 5: dangling references to the REMOVED identity
  // (not renumbered — deleted) were missed because the check only
  // recognized the legacy "Phase NN" spelling, not the display or dash
  // qualified forms.
  test('reports dangling references to the removed identity in display and dash form', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] 02',
        'Also blocked by CK.02-02 and Phase 02.',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const lines = splitLines(roadmap);
    const dependsLine = lines.indexOf('**Depends on:** [CK.02] 02') + 1;
    const blockedLine = lines.indexOf('Also blocked by CK.02-02 and Phase 02.') + 1;

    assert.equal(roadmap.includes('**Depends on:** [CK.02] 02'), true);
    assert.equal(roadmap.includes('Also blocked by CK.02-02 and Phase 02.'), true);
    assert.deepEqual(out.references_left_untouched.sort((a, b) => a - b), [dependsLine, blockedLine].sort((a, b) => a - b));
  });

  // #4304 round-5 Blocker 5: a stale pre-renumber reference followed by
  // sentence-final punctuation or a directory-name suffix was missed
  // because the (?![\d.]) lookahead rejected any following '.', and a
  // dash-form reference embedded in a directory path (a hyphen following
  // the identity) was likewise never reported.
  test('reports pre-renumber identities left stale by sentence-final punctuation and directory-name suffixes', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        'Blocked until [CK.02] 03.',
        'Dir name: CK.02-03-three',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const lines = splitLines(roadmap);
    const blockedLine = lines.indexOf('Blocked until [CK.02] 03.') + 1;
    const dirNameLine = lines.indexOf('Dir name: CK.02-03-three') + 1;

    // The rewrite itself is unchanged by this fix: both stale lines remain
    // byte-identical (their own stricter boundary still declines to rewrite
    // sentence-final punctuation or a directory-name-owned dash form), but
    // the bare artifact reference on the next line IS rewritten.
    assert.equal(roadmap.includes('Blocked until [CK.02] 03.'), true);
    assert.equal(roadmap.includes('Dir name: CK.02-03-three'), true);
    assert.equal(roadmap.includes('**Plans:** `02-01-PLAN.md`'), true);
    assert.deepEqual(out.references_left_untouched.sort((a, b) => a - b), [blockedLine, dirNameLine].sort((a, b) => a - b));
  });

  // #4304 round-5 W2 (fix): deleteSection removes the FIRST matching
  // heading in the whole document, not the one inside the active milestone
  // — a shipped v2.0 milestone and an active v2.1 milestone sharing the
  // same bracket code (milestoneToken folds both to [CK.02]) let a shipped
  // "## [CK.02] v2.0" section's own "### [CK.02] 02" detail heading be
  // deleted while the ACTIVE v2.1 section's own "### [CK.02] 02" survives
  // untouched, then gets duplicated by the renumber. Scope the deletion to
  // the same active-milestone ranges (primary + Phase Details) the
  // checklist-row deletion already uses.
  test('scopes detail-section deletion to the active milestone, leaving a shipped section with the same bracket code untouched', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Phase Recovery Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '',
        '### [CK.02] 01: Old One',
        '**Goal:** shipped',
        '',
        '### [CK.02] 02: Old Two',
        '**Goal:** shipped',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // The shipped section's own detail heading is untouched.
    assert.equal(roadmap.includes('### [CK.02] 02: Old Two'), true);
    assert.equal(roadmap.includes('**Goal:** shipped'), true);
    const shippedSection = roadmap.slice(
      roadmap.indexOf('## [CK.02] v2.0'),
      roadmap.indexOf('## [CK.02] v2.1'),
    );
    assert.equal(shippedSection.includes('### [CK.02] 02: Old Two'), true);
    // The active section's own target heading is gone, and its later
    // sibling is renumbered — not duplicated onto the removed heading's slot.
    const activeSection = roadmap.slice(roadmap.indexOf('## [CK.02] v2.1'));
    assert.equal(activeSection.includes('### [CK.02] 02: Two'), false);
    assert.equal(activeSection.includes('**Goal:** remove'), false);
    assert.equal(activeSection.includes('### [CK.02] 02: Three'), true);
    assert.equal(activeSection.includes('### [CK.02] 03: Three'), false);
    assert.equal((activeSection.match(/^### \[CK\.02\] 02:/gm) ?? []).length, 1);
  });

  // #4304 round 6 (B1): currentMilestoneRawRanges' details-range END omitted
  // the bracketBoundary the SAME function applies to the primary range end
  // (roadmap-parser.cts:2298), so on version-less bracket milestone headings
  // the active details window ran through the NEXT sibling milestone's own
  // "(Phase Details)" section. Removal's active-range rewrite and its W2
  // pre-delete ranges both consume this window, so the sibling's own bare
  // artifact token ('**Plans:** `03-01-PLAN.md`') was rewritten to point at
  // a file that does not exist on disk.
  test('does not leak the details range into a sibling milestone when headings carry no version token', () => {
    replaceSeed(
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
        '### [CK.02] 02: Two',
        '**Goal:** remove',
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
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
        ['CK.03-03-future-three', ['03-01-PLAN.md']],
      ],
    );
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    assert.deepEqual(out.references_left_untouched, []);

    // The sibling milestone's own Phase Details section is untouched — in
    // particular its own bare artifact token still names the file that
    // actually exists on disk, not '02-01-PLAN.md' (round 5's own W2 fix
    // already keeps the HEADING out of the leaked window; this pins the
    // bare-artifact-token rewrite the leaked window also drove).
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const ck03SectionAfter = roadmap.slice(roadmap.indexOf('## [CK.03] Future (Phase Details)'));
    assert.equal(
      ck03SectionAfter,
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
    assert.equal(fs.existsSync(planning('phases', 'CK.03-03-future-three', '03-01-PLAN.md')), true);

    // The active milestone's own phase 03 correctly renumbers to 02.
    const ck02Section = roadmap.slice(
      roadmap.indexOf('## [CK.02] Current (Phase Details)'),
      roadmap.indexOf('## [CK.03] Future (Phase Details)'),
    );
    assert.equal(ck02Section.includes('### [CK.02] 02: Three'), true);
    assert.equal(ck02Section.includes('`02-01-PLAN.md`'), true);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
  });

  // #4304 round 6 (W1): progress/table rows were deleted roadmap-wide with
  // no active-range check (src/phase.cts:3099-3104), so a shipped milestone
  // sharing the bracket code lost its own completed-phase row, and any
  // non-Progress table (a Requirements Traceability table) whose first cell
  // happened to be the removed identity lost its row too — even though
  // qualified-reference RENUMBERING (a different mechanism) correctly stays
  // roadmap-wide. Deletion is scoped to the active milestone's own table
  // content plus a `## Progress` section (the #2012 scope legacy already
  // uses); a table elsewhere is never touched.
  test('deletes a progress row only inside the active milestone\'s own table, never in a shipped section or an unrelated table', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '',
        '### [CK.02] 02: Old Two',
        '**Goal:** shipped',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 1/1 | Complete |',
        '| [CK.02] 02 | 1/1 | Complete |',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
        '## Requirements Traceability',
        '',
        '| Phase | Requirement | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 02 | REQ-01 | Done |',
        '| [CK.02] 02 | REQ-07 | Open |',
        '| [CK.02] 03 | REQ-08 | Open |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // The shipped section's own Complete row survives byte-identical.
    assert.equal(roadmap.includes('| [CK.02] 01 | 1/1 | Complete |'), true);
    assert.equal(roadmap.includes('| [CK.02] 02 | 1/1 | Complete |'), true);

    // The active table's own target row is gone; its later sibling is
    // renumbered onto that slot, not duplicated.
    assert.equal(roadmap.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);

    // The Requirements Traceability table is not a Progress table: the
    // dangling REQ-07 row (naming the just-removed identity) survives
    // byte-identical, and REQ-08's identity is renumbered like any other
    // qualified reference — its ROW is never a deletion candidate.
    assert.equal(roadmap.includes('| [CK.02] 02 | REQ-07 | Open |'), true);
    assert.equal(roadmap.includes('| [CK.02] 03 | REQ-08 | Open |'), false);
    assert.equal(roadmap.includes('| [CK.02] 02 | REQ-08 | Open |'), true);
    assert.equal(roadmap.includes('| [CK.01] 02 | REQ-01 | Done |'), true);
  });

  // #4304 round 6 (W2): removing an integer phase that has its own
  // sub-phases neither removed nor refused them (computeBracketRenumberMapping's
  // filter only ever selects phase > removedInt, never phase === removedInt) —
  // the sub-phase directories and ROADMAP rows stayed while the NEXT phase's
  // sub-phases renumbered onto the SAME identities, manufacturing duplicate
  // [CK.02] 02.01 identities on disk and in ROADMAP. Refuse before any
  // mutation, naming the orphan sub-phases.
  test('refuses removing a bracket phase that still has sub-phases, naming them, before any mutation', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 02.01: Two Sub A',
        '- [ ] [CK.02] 02.02: Two Sub B',
        '- [ ] [CK.02] 03: Three',
        '- [ ] [CK.02] 03.01: Three Sub',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 02.01: Two Sub A',
        '**Goal:** sub of removed',
        '',
        '### [CK.02] 02.02: Two Sub B',
        '**Goal:** sub of removed',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '### [CK.02] 03.01: Three Sub',
        '**Goal:** renumber sub',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 02.01 | 0/1 | Planned |',
        '| [CK.02] 02.02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.02] 03.01 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-02.01-two-sub-a', []],
        ['CK.02-02.02-two-sub-b', []],
        ['CK.02-03-three', []],
        ['CK.02-03.01-three-sub', []],
      ],
    );
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /still has sub-phase/i);
    assert.match(result.error, /\[CK\.02\] 02\.01/);
    assert.match(result.error, /\[CK\.02\] 02\.02/);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  // #4304 round 17 (W2): the active raw milestone range can contain a shipped
  // details archive with the same folded bracket code. The removal rewrite
  // already excludes those reader-classified historical lines, but the
  // parent-child guard did not, so an archived 02.01 blocked removal of the
  // unrelated live 02 even with --force.
  test('does not treat a same-code archived sub-phase as a child of the live phase', () => {
    fs.writeFileSync(planning('STATE.md'), '---\nmilestone: v2.1\n---\n');
    const archive = [
      '<details>',
      '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
      '',
      '### [CK.02] 02.01: Archived Child',
      '',
      '**Goal:** preserve',
      '',
      '</details>',
    ].join('\n');
    const protectedFence = [
      '```md',
      '## Progress',
      '| Phase | Status |',
      '| --- | --- |',
      '| [CK.02] 03 | Example only |',
      '**Depends on:** [CK.02] 03',
      '```',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        archive,
        '',
        protectedFence,
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes(archive), true, 'shipped child must remain byte-identical');
    assert.equal(roadmap.includes(protectedFence), true, 'fenced Progress example must remain byte-identical');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
  });

  // #4304 round 18 (B1): selecting the live heading is not enough. The
  // section deletion itself must stop at the active container boundary when
  // the target is the final heading inside an open details block.
  test('keeps an active details close and following milestone notes byte-identical when removing its last phase', () => {
    const protectedSuffix = [
      '</details>',
      '',
      'Milestone notes remain here.',
      '',
      'This prose belongs to the milestone, not the phase.',
      '',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '<details>',
        '<summary>Active phase details</summary>',
        '',
        '- [ ] [CK.02] 02: Two',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        protectedSuffix,
      ],
      [['CK.02-02-two', []]],
    );
    const before = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const beforeSuffix = before.slice(before.indexOf('</details>'));

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.slice(roadmap.indexOf('</details>')), beforeSuffix);
    assert.deepEqual(JSON.parse(result.output).references_left_untouched, []);
  });

  // #4304 round 18 (B1): a historical details archive can begin immediately
  // after the target and contain only deeper headings. Heading depth alone
  // must not let the target deletion consume the archive through EOF.
  test('keeps an immediately following shipped details archive with deeper headings byte-identical', () => {
    const archive = [
      '<details>',
      '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
      '',
      '#### [CK.02] 09: Archived Deep Heading',
      '',
      '**Goal:** preserve history',
      '',
      '</details>',
      '',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        archive,
      ],
      [['CK.02-02-two', []]],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes(archive), true, 'shipped archive must remain byte-identical');
    assert.deepEqual(JSON.parse(result.output).references_left_untouched, []);
  });

  // #4304 round 19 (B1): a details tag inside a fenced HTML example is
  // documentation, not a container boundary. Treating it as live markup cut
  // deletion off inside the target section, leaving the closing fence behind;
  // that unterminated fence then hid the live sibling from renumbering.
  test('ignores fenced details examples when bounding bracket section deletion', () => {
    const fencedExample = [
      '```html',
      '<details>',
      '<summary>Example only</summary>',
      '<p>Literal documentation</p>',
      '</details>',
      '```',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove the whole section',
        '',
        fencedExample,
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes(fencedExample), false, 'target-owned example must be deleted');
    assert.equal(roadmap.includes('```'), false, 'no orphaned fence delimiter may survive');
    assert.equal(
      scanFencedBlocks(splitLines(roadmap)).some((block) => block.closeLineIdx === -1),
      false,
      'resulting Markdown must not contain an unterminated fence',
    );
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-02-three']);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 19 inventory: the shared historical classifier also tracked
  // details tags on raw lines. A fenced fake close inside a shipped archive
  // must not end protection before the archive's real closing tag.
  test('ignores fenced details tags while protecting shipped history', () => {
    fs.writeFileSync(planning('STATE.md'), '---\nmilestone: v2.1\n---\n');
    const archive = [
      '<details>',
      '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
      '',
      '```html',
      '</details>',
      '```',
      '',
      '### [CK.02] 03: Archived Three',
      '',
      '**Depends on:** [CK.02] 03',
      '',
      '</details>',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        archive,
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes(archive), true, 'shipped archive must remain byte-identical');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-02-three']);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 20 (B1): a shipped archive can contain nested release-note
  // details before its phase inventory. Closing the nested block must not end
  // the outer archive's historical ownership or let removal select its phase.
  test('tracks nested details depth while protecting a shipped archive', () => {
    fs.writeFileSync(planning('STATE.md'), '---\nmilestone: v2.1\n---\n');
    const archive = [
      '<details>',
      '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
      '',
      '<details>',
      '<summary>Release notes</summary>',
      '',
      'Historical release-note body.',
      '',
      '</details>',
      '',
      '### [CK.02] 02: Archived Two',
      '',
      '**Goal:** preserve archived phase bytes',
      '',
      '</details>',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        archive,
        '',
        '### [CK.02] 02: Live Two',
        '**Goal:** remove live target',
        '',
        '### [CK.02] 03: Live Three',
        '**Goal:** renumber once',
        '',
      ],
      [
        ['CK.02-02-live-two', []],
        ['CK.02-03-live-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes(archive), true, 'nested shipped archive must remain byte-identical');
    assert.equal(roadmap.includes('### [CK.02] 02: Live Two'), false);
    assert.equal((roadmap.match(/^### \[CK\.02\] 02: Live Three$/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('### [CK.02] 03: Live Three'), false);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-02-live-three']);
    assert.deepEqual(out.references_left_untouched, []);
  });

  test('still stops bracket deletion at the next same-level live heading', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** keep the sibling body',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('**Goal:** keep the sibling body'), true);
  });

  // #4304 round 20 (B2): the reader inventories bracket phase headings at
  // levels 2-4. A deeper next phase is still a sibling identity, not body
  // content owned by the phase being removed.
  test('stops bracket deletion at the next distinct phase heading at any depth', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '#### [CK.02] 03: Three',
        '**Goal:** keep the deeper sibling body',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal((roadmap.match(/^#### \[CK\.02\] 02: Three$/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('#### [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('**Goal:** keep the deeper sibling body'), true);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-02-three']);
    assert.deepEqual(out.references_left_untouched, []);
  });

  test('deletes a non-phase deeper subheading with its bracket phase', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '#### Notes',
        'This note belongs only to phase two.',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** keep the sibling body',
        '',
      ],
      [
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('#### Notes'), false);
    assert.equal(roadmap.includes('This note belongs only to phase two.'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('**Goal:** keep the sibling body'), true);
  });

  // #4304 round 11 (W1): the sub-phase safety guard must share the read
  // side's CommonMark fence handling. A heading-shaped example inside a
  // fence is documentation, not a child phase, and cannot block removal.
  test('does not treat a fenced example sub-phase as a real child', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '```md',
        '### [CK.02] 02.01: Example subphase',
        '```',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
  });

  test('removing a bracket phase\'s own sub-phase directly is unaffected by the parent-sub-phase refusal', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 02.01: Two Sub A',
        '- [ ] [CK.02] 02.02: Two Sub B',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** keep',
        '',
        '### [CK.02] 02.01: Two Sub A',
        '**Goal:** remove',
        '',
        '### [CK.02] 02.02: Two Sub B',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-02.01-two-sub-a', []],
        ['CK.02-02.02-two-sub-b', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02.01', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    assert.equal(fs.existsSync(planning('phases', 'CK.02-02.01-two-sub-a')), false);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02.01-two-sub-b')), true);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('### [CK.02] 02.01: Two Sub B'), true);
  });

  // #4304 round 6 (W3): the read grammar admits BOTH `[CK.02] 02:` and the
  // labeled `[CK.02] Phase 02:` spelling (pinned at
  // tests/adr-612-bracket-grammar.test.cjs:644), and this PR's own owned-
  // line classifier (BRACKET_HEADING_LINE_RE et al) already admits it too —
  // but deleteSection's predicate compared heading.text against the
  // label-less display form with a literal startsWith, and
  // replaceQualifiedBracketReference matched the label-less literal
  // substring only, so a labeled removal was half-applied: rows deleted,
  // the target's own detail section kept, later phases renamed on disk
  // with NONE of their ROADMAP headings/rows renumbered.
  test('removes and fully renumbers the labeled "[CK.MM] Phase NN:" bracket spelling', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] Phase 01: One',
        '- [ ] [CK.02] Phase 02: Two',
        '- [ ] [CK.02] Phase 03: Three',
        '',
        '### [CK.02] Phase 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] Phase 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] Phase 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] Phase 01 | 0/1 | Planned |',
        '| [CK.02] Phase 02 | 0/1 | Planned |',
        '| [CK.02] Phase 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.deepEqual(
      fs.readdirSync(planning('phases')).sort(),
      ['CK.02-01-one', 'CK.02-02-three'],
    );
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    // The target is completely gone: checklist row, detail section, progress row.
    assert.equal(roadmap.includes('- [ ] [CK.02] Phase 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] Phase 02: Two'), false);
    assert.equal(roadmap.includes('**Goal:** remove'), false);
    // Phase 03 is fully renumbered to 02, label preserved, disk agreeing —
    // and the target's own progress row is gone (only ONE "Phase 02" row
    // remains, the renumbered one; the count assertions below pin this,
    // since the target and renumbered rows share identical placeholder text).
    assert.equal(roadmap.includes('- [ ] [CK.02] Phase 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] Phase 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] Phase 03: Three'), false);
    assert.equal((roadmap.match(/^### \[CK\.02\] Phase 02:/gm) ?? []).length, 1);
    assert.equal((roadmap.match(/^\| \[CK\.02\] Phase 02 \|/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('`02-01-PLAN.md`'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 6 (B5 follow-up): references_left_untouched exists so the
  // report never omits a dangling reference to the removed identity.
  // bracketQualifiedMentionedInLine only ever recognized the label-less
  // display form ("[CK.02] 02"), which is not a substring of a labeled
  // mention ("[CK.02] Phase 02") — so a genuinely dangling
  // "**Depends on:** [CK.02] Phase 02" line (a phase that depended on the
  // just-removed phase, spelled in the labeled bracket form) survived the
  // removal byte-identical but was never flagged. Fixed by teaching
  // bracketQualifiedMentionedInLine the SAME optional "Phase " label
  // replaceQualifiedBracketReference already rewrites (W3), rather than a
  // second, independent label grammar.
  test('reports a dangling labeled mention of the removed identity by its persisted line number', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] [CK.02] Phase 01: One',
        '- [ ] [CK.02] Phase 02: Two',
        '- [ ] [CK.02] Phase 03: Three',
        '',
        '### [CK.02] Phase 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] Phase 02: Two',
        '**Goal:** remove me',
        '',
        '### [CK.02] Phase 03: Three',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] Phase 02',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const lines = splitLines(roadmap);
    const dependsLine = lines.indexOf('**Depends on:** [CK.02] Phase 02') + 1;

    assert.ok(dependsLine > 0, 'the dangling Depends-on line must survive byte-identical');
    assert.equal(roadmap.includes('**Depends on:** [CK.02] Phase 02'), true);
    assert.deepEqual(out.references_left_untouched, [dependsLine]);
  });

  // #4304 round 7 (B1): the read grammar (phase-id.cts's bracketAlt, compiled
  // with `i` at roadmap-parser.cts's BRACKET_PHASE_ENTRY_HEADING_RE) and this
  // PR's own `phase insert`/`phase add` (canonicalizeBracketPhaseArgument)
  // already accept a lowercase project code ("[ck.02] 02:"), a lowercase or
  // uppercase "Phase" label ("[CK.02] phase 02:" / "[CK.02] PHASE 02:"),
  // extra internal spacing, and no space at all between the bracket and the
  // number ("[CK.02]02:") as real phases. Round 6's write-side regexes
  // (BRACKET_HEADING_LINE_RE et al, replaceQualifiedBracketReference,
  // bracketQualifiedMentionedInLine) were hand-composed case-sensitively
  // with `[ \t]+` instead of being derived from that same grammar, so
  // `phase remove` on any of these spellings deleted and renamed on disk
  // but left the target's own heading/checklist/progress row and the later
  // phase's stale number in ROADMAP, reporting references_left_untouched: []
  // over a ROADMAP that still named both the removed and the pre-rename
  // identity.
  test('removes and fully renumbers every case/spacing variant of the bracket phase spelling', () => {
    const spellings = [
      ['lower-code', (n) => `[ck.02] ${n}`],
      ['lower-label', (n) => `[CK.02] phase ${n}`],
      ['upper-label', (n) => `[CK.02] PHASE ${n}`],
      ['extra-spaces', (n) => `[CK.02]  Phase  ${n}`],
      ['no-space', (n) => `[CK.02]${n}`],
    ];
    for (const [name, spell] of spellings) {
      replaceSeed(
        [
          '# Roadmap',
          '',
          '## [CK.02] v2.0 — Current 🚧',
          '',
          `- [ ] ${spell('01')}: One`,
          `- [ ] ${spell('02')}: Two`,
          `- [ ] ${spell('03')}: Three`,
          '',
          `### ${spell('01')}: One`,
          '**Goal:** keep',
          '',
          `### ${spell('02')}: Two`,
          '**Goal:** remove',
          '',
          `### ${spell('03')}: Three`,
          '**Goal:** renumber',
          `**Depends on:** ${spell('02')}`,
          '**Plans:** `03-01-PLAN.md`',
          '',
          '## Progress',
          '',
          '| Phase | Plans | Status |',
          '| --- | --- | --- |',
          `| ${spell('01')} | 0/1 | Planned |`,
          `| ${spell('02')} | 0/1 | Planned |`,
          `| ${spell('03')} | 0/1 | Planned |`,
          '',
        ],
        [
          ['CK.02-01-one', []],
          ['CK.02-02-two', []],
          ['CK.02-03-three', ['03-01-PLAN.md']],
        ],
      );

      const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
      assert.equal(result.success, true, `[${name}] ${result.error || result.output}`);
      const out = JSON.parse(result.output);

      assert.deepEqual(
        fs.readdirSync(planning('phases')).sort(),
        ['CK.02-01-one', 'CK.02-02-three'],
        `[${name}] directories`,
      );
      assert.equal(
        fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')),
        true,
        `[${name}] renamed artifact`,
      );

      const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
      // The target is completely gone: checklist row, detail section
      // (its own "Goal" line), and progress row — in the line's own spelling.
      assert.equal(roadmap.includes(`${spell('02')}: Two`), false, `[${name}] target gone`);
      assert.equal(roadmap.includes('**Goal:** remove'), false, `[${name}] target section gone`);
      // Phase 03 is fully renumbered to 02, spelling and case preserved,
      // disk agreeing — and the target's own row is gone (only ONE
      // instance of the renumbered heading/row survives).
      assert.equal(roadmap.includes(`### ${spell('02')}: Three`), true, `[${name}] renumbered heading`);
      assert.equal(roadmap.includes(`### ${spell('03')}: Three`), false, `[${name}] old heading gone`);
      assert.equal(roadmap.includes(`- [ ] ${spell('02')}: Three`), true, `[${name}] renumbered checklist`);
      assert.equal(
        roadmap.includes(`| ${spell('02')} | 0/1 | Planned |`),
        true,
        `[${name}] renumbered progress row`,
      );
      const headingLines = splitLines(roadmap).filter((l) => l.startsWith(`### ${spell('02')}:`));
      assert.equal(headingLines.length, 1, `[${name}] no duplicate heading`);
      const progressLines = splitLines(roadmap).filter((l) => l.startsWith(`| ${spell('02')} |`));
      assert.equal(progressLines.length, 1, `[${name}] no duplicate progress row`);

      // The only genuinely dangling reference is the "Depends on" line
      // naming the just-removed identity — never an empty report over a
      // half-applied removal.
      const lines = splitLines(roadmap);
      const dependsLine = lines.indexOf(`**Depends on:** ${spell('02')}`) + 1;
      assert.ok(dependsLine > 0, `[${name}] dangling Depends-on line must survive`);
      assert.deepEqual(out.references_left_untouched, [dependsLine], `[${name}] references_left_untouched`);
    }
  });

  test('removes and renumbers manager-readable bold checklist rows with no space after the colon', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '- [ ] **[CK.02] 01:Keep**',
        '- [ ] **[CK.02] 02:Remove**',
        '- [ ] **[CK.02] 03:Next**',
        '',
        '### [CK.02] 01: Keep',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Remove',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Next',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-keep', []],
        ['CK.02-02-remove', []],
        ['CK.02-03-next', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('- [ ] **[CK.02] 02:Remove**'), false);
    assert.equal(roadmap.includes('- [ ] **[CK.02] 02:Next**'), true);
    assert.equal(roadmap.includes('- [ ] **[CK.02] 03:Next**'), false);
  });

  // #4304 round 7 (W1): bracketMilestoneOwnTableEnd anchored ONLY at the
  // milestone heading itself and stopped at the very NEXT heading of level
  // <= 2, regardless of what it was — so a "## Notes" aside sitting between
  // the phase headings and the milestone's own "### Progress" table closed
  // the "own table" window before the table it was meant to include was
  // ever reached, leaving the removed identity's row stale after renumbering.
  test('deletes a progress row that sits behind a "## Notes" aside before its own "### Progress" table', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Notes',
        '',
        'Some notes.',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 7 (W1): each milestone owning its OWN "## Progress" section
  // — a shipped milestone's, sorting first in the document, and the active
  // milestone's own, sorting second — is a shape the round-6 fix regressed
  // on two ways at once: the document-first "## Progress" scope claimed the
  // SHIPPED section (never the active one it was meant to scope this
  // removal to), while bracketMilestoneOwnTableEnd closed the active
  // milestone's own "own table" window AT its own "## Progress" heading,
  // excluding the very table beneath it.
  test('scopes progress-row deletion to each milestone\'s own "## Progress" section, not the document-first one', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.01] v1.0 — Shipped ✅',
        '',
        '- [x] [CK.01] 01: Old One',
        '- [x] [CK.01] 02: Old Two',
        '',
        '### [CK.01] 01: Old One',
        '**Goal:** shipped',
        '',
        '### [CK.01] 02: Old Two',
        '**Goal:** shipped',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 01 | 1/1 | Complete |',
        '| [CK.01] 02 | 1/1 | Complete |',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.01-01-old-one', []],
        ['CK.01-02-old-two', []],
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // Shipped CK.01's own Progress section survives byte-identical.
    assert.equal(roadmap.includes('| [CK.01] 01 | 1/1 | Complete |'), true);
    assert.equal(roadmap.includes('| [CK.01] 02 | 1/1 | Complete |'), true);

    // Active CK.02's own target row is gone; its later sibling renumbers
    // onto that slot without duplicating.
    const ck02Progress = roadmap.slice(roadmap.lastIndexOf('## Progress'));
    assert.equal((ck02Progress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(ck02Progress.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 7 (W1): the same-code two-versions shape (a shipped v2.0 and
  // an active v2.1 folding to the SAME `[CK.02]` bracket, each with its own
  // "## Progress") is the sharpest form of the bug: the document-first
  // "## Progress" scope silently deleted the SHIPPED milestone's own Complete
  // row for the just-removed identity instead of the active milestone's
  // Planned row, because nothing distinguished "the first Progress heading"
  // from "the active milestone's own Progress heading".
  test('scopes progress-row deletion to the active version\'s own "## Progress" when a shipped milestone shares the bracket code', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '',
        '### [CK.02] 01: Old One',
        '**Goal:** shipped',
        '',
        '### [CK.02] 02: Old Two',
        '**Goal:** shipped',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 1/1 | Complete |',
        '| [CK.02] 02 | 1/1 | Complete |',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // The shipped v2.0 section (same bracket code) keeps BOTH Complete
    // rows — round 6 silently deleted its phase-02 row instead of the
    // active version's.
    assert.equal(roadmap.includes('| [CK.02] 01 | 1/1 | Complete |'), true);
    assert.equal(roadmap.includes('| [CK.02] 02 | 1/1 | Complete |'), true);

    // The active v2.1 section's target row is gone, no duplicate.
    const activeProgress = roadmap.slice(roadmap.lastIndexOf('## Progress'));
    assert.equal((activeProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(activeProgress.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 8 (B1): round 7 folded the CODE (foldBracketId) before
  // parsePhaseId but passed the captured NUMBER through verbatim, so a
  // non-canonical ROADMAP spelling ("[CK.02] 2:", not the canonical
  // "[CK.02] 02:") threw parsePhaseId's own canonicality check and
  // classified as 'other' — invisible to the heading/checklist/progress
  // deletion, the renumber mapping, and the W2 sub-phase scan alike, even
  // though `roadmap get-phase`/`analyze`/`validate` and this PR's own
  // `phase insert`/`phase add` all already treat it as a real phase. The
  // fix canonicalizes the captured number (phaseToken, the same adapter the
  // bare-token argument path already uses) before parsePhaseId, and makes
  // the qualified-reference rewriter/detector match the number through the
  // same tolerant grammar instead of the canonical literal.
  test('removes and renumbers a non-canonically-spelled phase number, reporting the dangling old mention', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 1: One',
        '- [ ] [CK.02] 2: Two',
        '- [ ] [CK.02] 3: Three',
        '',
        '### [CK.02] 1: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 2: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 3: Three',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] 2',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 1 | 0/1 | Planned |',
        '| [CK.02] 2 | 0/1 | Planned |',
        '| [CK.02] 3 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);

    assert.equal(out.directory_deleted, 'CK.02-02-two');
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    // The target is completely gone: heading, checklist row, progress row.
    assert.equal(roadmap.includes('[CK.02] 2: Two'), false);
    assert.equal(roadmap.includes('**Goal:** remove'), false);
    // Phase 3 renumbers to the CANONICAL padded token, not the old spelling's
    // "3" — GSD never writes a non-canonical number.
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 3: Three'), false);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('| [CK.02] 02 | 0/1 | Planned |'), true);
    const headingLines = splitLines(roadmap).filter((l) => l.startsWith('### [CK.02] 02:'));
    assert.equal(headingLines.length, 1);
    const progressLines = splitLines(roadmap).filter((l) => l.startsWith('| [CK.02] 02 |'));
    assert.equal(progressLines.length, 1);

    // The dangling "Depends on" mention of the just-removed identity, still
    // spelled non-canonically, is reported rather than silently dropped.
    const lines = splitLines(roadmap);
    const dependsLine = lines.indexOf('**Depends on:** [CK.02] 2') + 1;
    assert.ok(dependsLine > 0, 'dangling Depends-on line must survive');
    assert.deepEqual(out.references_left_untouched, [dependsLine]);
  });

  // #4304 round 8 (B1): an OVER-padded spelling ("[CK.02] 002:") has the
  // same defect — and confirms the rewrite always emits the canonical
  // 2-digit token on renumber, never preserving a 3-digit source spelling.
  test('removes and renumbers an over-padded phase number to the canonical width', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 001: One',
        '- [ ] [CK.02] 002: Two',
        '- [ ] [CK.02] 003: Three',
        '',
        '### [CK.02] 001: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 002: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 003: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    assert.equal(out.directory_deleted, 'CK.02-02-two');

    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('[CK.02] 002: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 003: Three'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 8 (B1): the round-6 W2 sub-phase refusal scans
  // classifyBracketOwnedLine's output for `phase === targetInt` rows — with
  // the number-canonicalization gap, a ROADMAP-only sub-phase spelled
  // unpadded ("[CK.02] 02.1:") was invisible to that scan, so `remove 02`
  // was NOT refused and would have manufactured a duplicate identity when
  // the next phase's sub-phase renumbered onto the same slot.
  test('refuses removing a phase whose own sub-phase is spelled with an unpadded number', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 02.1: Two Sub',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 02.1: Two Sub',
        '**Goal:** orphan risk',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /still has sub-phase/i);
    assert.match(result.error, /\[CK\.02\] 02\.01/);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  // #4304 round 8 (W1): round 7's ownership gate treated the document-first
  // "## Progress" as "owned elsewhere" whenever the ACTIVE milestone had its
  // own separate "Progress" heading, regardless of where the document-first
  // one actually sat — so a genuinely global table BEFORE any milestone
  // heading kept the removed identity's row once the active milestone also
  // had its own dedicated "### Progress". The row is global (nothing
  // precedes it) and must be deleted here, same as the active's own table.
  test('deletes the removed phase\'s row from a global Progress table at the top of the document', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.03] 01 | 0/1 | Planned |',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '- [ ] [CK.03] 01: F-One',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
        ['CK.03-01-f-one', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const globalProgress = roadmap.slice(0, roadmap.indexOf('## [CK.02]'));
    assert.equal(globalProgress.includes('| [CK.02] 01 | 0/1 | Planned |'), true);
    assert.equal((globalProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(globalProgress.includes('| [CK.03] 01 | 0/1 | Planned |'), true);

    const ownProgress = roadmap.slice(roadmap.lastIndexOf('### Progress'));
    assert.equal((ownProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(ownProgress.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 8 (W1): the OTHER shape the same over-claim broke — a
  // genuinely global "## Progress" table sitting AFTER a LATER milestone's
  // own heading, with nothing recognized following it. Round 7 treated it
  // as owned by that later milestone (or, before this fix, by whichever
  // milestone the active one's own separate Progress heading pushed it
  // toward), leaving the removed identity's row stale.
  test('deletes the removed phase\'s row from a global Progress table trailing after a later milestone', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '- [ ] [CK.03] 01: F-One',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.03] 01 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
        ['CK.03-01-f-one', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const globalProgress = roadmap.slice(roadmap.lastIndexOf('## Progress'));
    assert.equal(globalProgress.includes('| [CK.02] 01 | 0/1 | Planned |'), true);
    assert.equal((globalProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(globalProgress.includes('| [CK.03] 01 | 0/1 | Planned |'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 9 (B1, regression from round 8/de31ccac0): round 8's own
  // positional rewrite of bracketProgressSectionOwnedByOtherMilestone dropped
  // round 7's precondition that the ACTIVE milestone must own a Progress
  // heading before a document-first "## Progress" can be treated as a
  // DIFFERENT milestone's — so a shared "## Progress" table (the ACTIVE
  // milestone has no dedicated Progress heading of its own) was declared
  // "owned elsewhere" whenever ANY version-bearing heading (here a versioned
  // backlog heading, no real milestone at all) followed it, leaving the
  // removed identity's row stale while the renumbered sibling's row landed on
  // the SAME id — two rows for one identity. Same base fixture as the
  // "renumbers fully qualified references in a global Progress table..."
  // test above, with one appended versioned heading.
  test('deletes the removed phase\'s row exactly once from a shared global Progress table followed by a versioned backlog heading', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.01] v1.0 — Prior',
        '',
        '### [CK.01] 03: Prior Three',
        '',
        '**Goal:** untouched',
        '**Plans:** `03-01-PLAN.md`, `03-01-SUMMARY.md`',
        '',
        '## [CK.02] v2.0 — Current',
        '',
        '### [CK.02] 02: Two',
        '',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## [CK.03] v3.0 — Future',
        '',
        '### [CK.03] 01: Later',
        '',
        '**Goal:** untouched by the CK.02 removal',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.01] 03 | 0/1 | Prior |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '| [CK.03] 01 | 0/1 | Future |',
        '',
        '## Backlog (v4.0 candidates)',
        '',
        '- [ ] [CK.02] 999.1: Someday',
        '',
      ],
      [
        ['CK.01-03-prior-three', ['03-01-PLAN.md', '03-01-SUMMARY.md']],
        ['CK.02-02-two', ['02-01-PLAN.md']],
        ['CK.02-03-three', ['03-01-PLAN.md']],
        ['CK.03-01-later', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const progressAfter = roadmap.slice(roadmap.indexOf('## Progress'), roadmap.indexOf('## Backlog'));
    assert.equal((progressAfter.match(/^\| \[CK\.02\] 02 \|/gm) ?? []).length, 1);
    assert.equal(progressAfter.includes('| [CK.02] 02 | 0/1 | Planned |'), true);
    assert.equal(progressAfter.includes('| [CK.01] 03 | 0/1 | Prior |'), true);
    assert.equal(progressAfter.includes('| [CK.03] 01 | 0/1 | Future |'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 9 (W1, regression from round 8): `bracketRecognizedMilestoneMarkers`
  // enumerated ONLY version-token milestone headings, narrower than the
  // window locator's OWN recognition grammar (`isBracketMilestoneBoundary` /
  // `bracketFallbackHeadingMatches`) — so a fully version-less, same-code
  // shipped/active pair (the ADR-612 canonical name-only heading shape,
  // "## [CK.02] Shipped", no `vX.Y` anywhere) produced NO marker for the
  // shipped heading at all, and its own dedicated "## Progress" table was
  // treated as shared/global — losing its own Complete row to the active
  // milestone's removal even though the active milestone has its own
  // separate "### Progress" table.
  test('keeps a version-less shipped milestone\'s own Progress row when the active milestone shares its bracket code', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 1/1 | Complete |',
        '| [CK.02] 02 | 1/1 | Complete |',
        '',
        '## [CK.02] Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // Shipped's own table survives byte-identical — both rows, including 02.
    const shippedProgress = roadmap.slice(roadmap.indexOf('## Progress'), roadmap.indexOf('## [CK.02] Current'));
    assert.equal(shippedProgress.includes('| [CK.02] 01 | 1/1 | Complete |'), true);
    assert.equal(shippedProgress.includes('| [CK.02] 02 | 1/1 | Complete |'), true);

    // Active's own table has the target row gone, no duplicate.
    const activeProgress = roadmap.slice(roadmap.lastIndexOf('### Progress'));
    assert.equal((activeProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(activeProgress.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 9 (W2, pre-existing since round 5): a non-closed heading
  // carrying the ACTIVE version token sits BEFORE the real milestone
  // heading ("## Goals for v2.0"). The read side selects THAT heading as
  // the active one (`selectMilestoneHeading` picks the first non-closed
  // match for the version), so the located window is just the Goals
  // paragraph — ending exactly where the real milestone heading begins —
  // and the target's real heading/checklist lines never fall inside it.
  // Before this fix, `phase remove` still deleted the target's directory
  // and renamed later ones while its heading/checklist survived in
  // ROADMAP.md; the pre-mutation guard now refuses before touching disk.
  test('refuses to remove a phase when a decoy heading carrying the active version precedes the real milestone heading', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## Goals for v2.0',
        '',
        'Ship the thing.',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Depends on:** [CK.02] 02',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /lies outside/i);
    assert.match(result.error, /Goals for v2\.0/);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  // #4304 round 9 (W2, round-4's own still-open W1 class): no milestone
  // heading exists in ROADMAP.md at all. The bracket-fallback selector
  // (`bracketFallbackHeadingMatches`) has no phase-tail exclusion, so it
  // picks the FIRST bracket phase heading ("### [CK.02] 01: One") as if it
  // were the milestone heading, and the resulting window happens to span
  // every LATER phase heading through EOF while the checklist bullets —
  // which sit above that first heading — remain entirely outside it. A
  // heading correctly falling inside must never mask a checklist row that
  // does not: this is exactly the shape that motivates checking heading and
  // checklist independently rather than "any owned line found inside".
  test('refuses to remove a phase when ROADMAP.md has no milestone heading at all', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /lies outside/i);
    assert.deepEqual(snapshotTree(planning()), before);
  });

  // #4304 round 8 (W2): `isProgressHeading` required an EXACT "progress"
  // match while `bracketProgressSectionRange` already matched "## Progress"
  // with any suffix (`\b`), so a shipped milestone's "## Progress (v2.0)"
  // and the active milestone's own "## Progress (v2.1)" (same bracket code,
  // two versions) never engaged the own-section scope: the shipped row was
  // deleted by the wrong (document-first) scope, and the active's target
  // row survived to duplicate. One suffix-tolerant predicate now backs
  // both, and a Progress heading whose OWN version-like suffix looks like a
  // milestone marker to `currentMilestoneRawRanges`' section-end scan no
  // longer falls just outside the active milestone's own range.
  test('scopes progress-row deletion correctly when both milestones title their own table "Progress (vX.Y)"', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '',
        '## Progress (v2.0)',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 1/1 | Complete |',
        '| [CK.02] 02 | 1/1 | Complete |',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress (v2.1)',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // Shipped v2.0's own Progress table survives byte-identical — both rows.
    assert.equal(roadmap.includes('| [CK.02] 01 | 1/1 | Complete |'), true);
    assert.equal(roadmap.includes('| [CK.02] 02 | 1/1 | Complete |'), true);

    // Active v2.1's own table has the target row gone, no duplicate.
    const activeProgress = roadmap.slice(roadmap.lastIndexOf('## Progress'));
    assert.equal((activeProgress.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(activeProgress.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 8 (W2): a single-milestone shape whose OWN Progress heading
  // carries a version suffix ("### Progress (v2.0)"), reached only through
  // a "## Notes" aside — round 7's exact-match predicate left the stale
  // target row behind (flagged, not deleted) because the suffixed heading
  // never registered as the milestone's own.
  test('deletes the target row from a suffixed own Progress heading reached through a Notes aside', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Notes',
        'aside',
        '',
        '### Progress (v2.0)',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \| 0\/1 \| Planned \|$/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('| [CK.02] 03 | 0/1 | Planned |'), false);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304: the pre-mutation guard checked heading and checklist independently
  // over the WHOLE
  // document with no notion of an archived/shipped section, so a same-code
  // point release (milestoneToken folds v2.0/v2.1 to one [CK.02]) whose
  // shipped checklist survives in the complete-milestone <details> archive
  // falsely refused any phase the shipped milestone also numbered, as soon
  // as the active phase has a heading but no checklist bullet — exactly what
  // `phase add` writes. The read side locates the window correctly; the
  // archived line is never evidence the ACTIVE window is mislocated.
  test('does not refuse removal when a same-code shipped milestone\'s archived checklist survives and the active phase has no checklist bullet', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## Phases',
        '',
        '<details>',
        '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '- [x] [CK.02] 03: Old Three',
        '',
        '### [CK.02] 03: Old Three',
        '**Goal:** preserve shipped history',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 03 | 1/1 | Complete |',
        '',
        '</details>',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    const before = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const shippedIdentityLinesBefore = splitLines(before).filter((line) =>
      line.includes('[CK.02] 03') && (line.includes('Old Three') || line.includes('Complete')));

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // The archived <details> block's shipped heading, checklist, and progress
    // lines are byte-identical. Phase 03 is the discriminator: active 03 must
    // renumber, while shipped 03 must not.
    const shippedIdentityLinesAfter = splitLines(roadmap).filter((line) =>
      line.includes('[CK.02] 03') && (line.includes('Old Three') || line.includes('Complete')));
    assert.deepEqual(shippedIdentityLinesAfter, shippedIdentityLinesBefore);
    // Active section: 02 removed, 03 renumbered onto 02.
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  test('selects the live target after an archived same-id heading inside the active milestone window', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    const archive = [
      '<details>',
      '<summary>✅ [CK.02] v2.0 — SHIPPED 2026-01-01</summary>',
      '',
      '- [x] [CK.02] 02: Archived Two',
      '',
      '### [CK.02] 02: Archived Two',
      '',
      '**Goal:** preserve this historical section byte-for-byte',
      '',
      '</details>',
    ].join('\n');
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        archive,
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const archiveStart = roadmap.indexOf('<details>');
    const archiveEnd = roadmap.indexOf('</details>', archiveStart);
    const archivedAfter = archiveEnd === -1
      ? roadmap.slice(archiveStart)
      : roadmap.slice(archiveStart, archiveEnd + '</details>'.length);
    assert.equal(archivedAfter, archive, 'historical block must remain byte-identical');
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false, 'live target must be deleted');
    assert.equal((roadmap.match(/^### \[CK\.02\] 02: Three$/gm) ?? []).length, 1);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 11 (B1): shipped history can remain open rather than wrapped
  // in <details>. A closed milestone heading owns history until the next
  // heading at the same or shallower level; qualified references inside that
  // section must remain byte-identical while the active point release with
  // the same folded bracket code is renumbered.
  test('preserves qualified phase identities under an open shipped milestone section', () => {
    fs.writeFileSync(
      planning('STATE.md'),
      '---\nmilestone: v2.1\n---\n\n# State\n\n**Status:** Planning\n**Last Activity:** 2026-09-01\n',
    );
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Shipped ✅',
        '',
        '- [x] [CK.02] 01: Old One',
        '- [x] [CK.02] 02: Old Two',
        '- [x] [CK.02] 03: Old Three',
        '',
        '### [CK.02] 03: Old Three',
        '**Goal:** preserve shipped history',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 03 | 1/1 | Complete |',
        '',
        '## [CK.02] v2.1 — Current 🚧',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );
    const before = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    const shippedIdentityLinesBefore = splitLines(before).filter((line) =>
      line.includes('[CK.02] 03') && (line.includes('Old Three') || line.includes('Complete')));

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    const shippedIdentityLinesAfter = splitLines(roadmap).filter((line) =>
      line.includes('[CK.02] 03') && (line.includes('Old Three') || line.includes('Complete')));
    assert.deepEqual(shippedIdentityLinesAfter, shippedIdentityLinesBefore);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304 round 12 (B1): the historical-section marker predicate recognizes
  // words such as FAILED and the check mark, but those words can also appear
  // in an ordinary phase title. A phase heading is never a milestone section
  // boundary, even when its title carries a closed-milestone marker.
  for (const phaseTitle of ['Failed Payment Recovery', 'Done ✅']) {
    test(`renumbers an active phase titled ${JSON.stringify(phaseTitle)} instead of treating it as history`, () => {
      replaceSeed(
        [
          '# Roadmap',
          '',
          '## [CK.02] v2.0 — Current 🚧',
          '',
          '### [CK.02] 01: One',
          '**Goal:** keep',
          '',
          '### [CK.02] 02: Two',
          '**Goal:** remove',
          '',
          `### [CK.02] 03: ${phaseTitle}`,
          '**Goal:** renumber',
          '',
        ],
        [
          ['CK.02-01-one', []],
          ['CK.02-02-two', []],
          ['CK.02-03-three', []],
        ],
      );

      const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
      assert.equal(result.success, true, result.error || result.output);
      const out = JSON.parse(result.output);
      const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

      assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three')), true);
      assert.equal(roadmap.includes(`### [CK.02] 02: ${phaseTitle}`), true);
      assert.equal(roadmap.includes(`### [CK.02] 03: ${phaseTitle}`), false);
      assert.deepEqual(out.references_left_untouched, []);
    });
  }

  test('ignores a fenced closed-milestone example when classifying live removal lines', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '```md',
        '## [CK.01] v1.0 CLOSED',
        '```',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('- [ ] [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('## [CK.01] v1.0 CLOSED'), true);
    assert.deepEqual(out.references_left_untouched, []);
  });

  test('ignores a fenced target checklist example before the active milestone window', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '```md',
        '- [ ] [CK.02] 02: Documentation example',
        '```',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, true, result.error || result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Documentation example'), true);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
  });

  test('renumbers an active milestone phase list collapsed inside details', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '<details>',
        '<summary>Implementation phases</summary>',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '**Plans:** `03-01-PLAN.md`',
        '',
        '</details>',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', ['03-01-PLAN.md']],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    assert.deepEqual(fs.readdirSync(planning('phases')).sort(), ['CK.02-01-one', 'CK.02-02-three']);
    assert.equal(fs.existsSync(planning('phases', 'CK.02-02-three', '02-01-PLAN.md')), true);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('- [ ] [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('- [ ] [CK.02] 03: Three'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Two'), false);
    assert.equal(roadmap.includes('### [CK.02] 02: Three'), true);
    assert.equal(roadmap.includes('### [CK.02] 03: Three'), false);
    assert.match(roadmap, /<details>\n<summary>Implementation phases<\/summary>/);
    assert.deepEqual(out.references_left_untouched, []);
  });

  // #4304: the guard was additionally gated on `targetDir`, so a
  // ROADMAP-only target (a phase `phase add` created with no directory yet)
  // on a mislocated window still half-applied: later directories renamed and
  // their ROADMAP lines renumbered onto the target's identity while the
  // target's own heading/checklist survived, with an empty report. The
  // guard reads only ROADMAP content, so the extra gate protected nothing.
  test('refuses a ROADMAP-only removal target (no phase directory) when a decoy heading mislocates the active window', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## Goals for v2.0',
        '',
        'Ship.',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-03-three', []],
      ],
    );
    const before = snapshotTree(planning());

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);

    assert.equal(result.success, false, result.output);
    assert.match(result.error, /lies outside/i);
    assert.deepEqual(snapshotTree(planning()), before);
  });
  // #4304: the second marker loop (`isBracketMilestoneBoundary(h.text,
  // h.level, null)`) admitted the ACTIVE milestone's own same-id, version-less
  // prose sub-heading ("### [CK.02] Notes") as a milestone marker in its own
  // right, so a shared "## Progress" table sitting after it — but still
  // inside the active milestone's own primary range — was misread as
  // belonging to a phantom "other milestone" and its target row survived,
  // duplicating once the sibling phase renumbered onto the same identity.
  test('does not treat the active milestone\'s own same-id prose sub-heading as a milestone marker', () => {
    replaceSeed(
      [
        '# Roadmap',
        '',
        '## [CK.02] v2.0 — Current 🚧',
        '',
        '- [ ] [CK.02] 01: One',
        '- [ ] [CK.02] 02: Two',
        '- [ ] [CK.02] 03: Three',
        '',
        '### [CK.02] 01: One',
        '**Goal:** keep',
        '',
        '### [CK.02] 02: Two',
        '**Goal:** remove',
        '',
        '### [CK.02] 03: Three',
        '**Goal:** renumber',
        '',
        '### [CK.02] Notes',
        'aside',
        '',
        '### Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
        '## Done ✅',
        '',
        'nothing',
        '',
        '## Progress',
        '',
        '| Phase | Plans | Status |',
        '| --- | --- | --- |',
        '| [CK.02] 01 | 0/1 | Planned |',
        '| [CK.02] 02 | 0/1 | Planned |',
        '| [CK.02] 03 | 0/1 | Planned |',
        '',
        '## [CK.03] v3.0 — Planned 📋',
        '',
        '- [ ] [CK.03] 01: P',
        '',
      ],
      [
        ['CK.02-01-one', []],
        ['CK.02-02-two', []],
        ['CK.02-03-three', []],
      ],
    );

    const result = runGsdTools(['phase', 'remove', '02', '--force'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const out = JSON.parse(result.output);
    const roadmap = fs.readFileSync(planning('ROADMAP.md'), 'utf8');

    // Exactly one surviving "02" row per Progress table (own + shared): no
    // duplicate from the shared table being misattributed to the Notes
    // heading as if it were a different milestone's own section.
    assert.equal((roadmap.match(/^\| \[CK\.02\] 02 \|/gm) ?? []).length, 2);
    assert.equal((roadmap.match(/^\| \[CK\.02\] 03 \|/gm) ?? []).length, 0);
    assert.deepEqual(out.references_left_untouched, []);
  });
});

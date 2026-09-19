'use strict';

// allow-test-rule: source-text-is-the-product — see #4304
// ROADMAP.md and phase artifact names are the phase-remove output contract.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

let tmpDir;

const planning = (...parts) => path.join(tmpDir, '.planning', ...parts);

function makePhaseDir(name, files = []) {
  const dir = planning('phases', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), '# artifact\n');
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
});

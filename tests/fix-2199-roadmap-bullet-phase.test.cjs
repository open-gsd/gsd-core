'use strict';

/**
 * #2199 — ROADMAP phase resolution + milestone filter must accept bullet/checkbox
 * phase entries with an em-dash/en-dash/hyphen/colon separator, not just the
 * ATX-heading + colon form.
 *
 * Previously `findRoadmapPhaseInContent` tokenized headings only and required a
 * colon, so a bullet entry like `- [ ] **Phase N — name**` resolved found:false
 * and `Phase null` was written into STATE.md; the milestone filter collapsed to
 * a zero-count pass-all on a bullet-only ROADMAP.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const {
  getRoadmapPhaseInternal,
  getMilestonePhaseFilter,
} = require('../gsd-core/bin/lib/roadmap-parser.cjs');

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

describe('#2199 roadmap bullet/em-dash phase resolution', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('fix-2199-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('an all-bullet em-dash ROADMAP resolves each phase (no Phase null)', () => {
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## v1.0 Active', '',
      '- [ ] **Phase 1 — Authentication**: login flow',
      '- [ ] **Phase 2 — Authorization**: RBAC',
      '- [x] **Phase 3 — Audit Logging**: events',
      '',
    ].join('\n'));

    const p1 = getRoadmapPhaseInternal(tmpDir, '1');
    assert.ok(p1 && p1.found, 'Phase 1 must resolve on a bullet ROADMAP');
    assert.strictEqual(p1.phase_name, 'Authentication');

    const p2 = getRoadmapPhaseInternal(tmpDir, '2');
    assert.ok(p2 && p2.found);
    assert.strictEqual(p2.phase_name, 'Authorization');

    const p3 = getRoadmapPhaseInternal(tmpDir, '3');
    assert.ok(p3 && p3.found, 'a checked [x] bullet must also resolve');
    assert.strictEqual(p3.phase_name, 'Audit Logging');

    const absent = getRoadmapPhaseInternal(tmpDir, '99');
    assert.ok(!absent || !absent.found, 'an absent phase must not resolve');
  });

  test('bullet entries with colon / en-dash / hyphen separators all resolve', () => {
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## v1.0 Active', '',
      '- [ ] **Phase 1: Colon Sep**: one',
      '- [ ] **Phase 2 – En Dash**: two',
      '- [ ] **Phase 3 - Hyphen Sep**: three',
      '',
    ].join('\n'));
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, '1').phase_name, 'Colon Sep');
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, '2').phase_name, 'En Dash');
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, '3').phase_name, 'Hyphen Sep');
  });

  test('mixed heading + bullet forms both resolve', () => {
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## v1.0 Active', '',
      '### Phase 1: Heading Form',
      'body',
      '- [ ] **Phase 2 — Bullet Form**: two',
      '',
    ].join('\n'));
    const p1 = getRoadmapPhaseInternal(tmpDir, '1');
    assert.ok(p1 && p1.found, 'heading form still resolves (no regression)');
    assert.ok(/Heading Form/.test(p1.phase_name));
    const p2 = getRoadmapPhaseInternal(tmpDir, '2');
    assert.ok(p2 && p2.found, 'bullet form resolves alongside heading form');
    assert.strictEqual(p2.phase_name, 'Bullet Form');
  });

  test('milestone phase-count counts bullet-form phases (not zero)', () => {
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## v1.0 Active', '',
      '- [ ] **Phase 1 — One**: a',
      '- [ ] **Phase 2 — Two**: b',
      '- [ ] **Phase 3 — Three**: c',
      '',
    ].join('\n'));
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 3,
      'a bullet-only ROADMAP must populate the milestone phase set (was a zero-count pass-all before #2199)');
    assert.ok(filter('1'), 'phase 1 dir is in the milestone set');
    assert.ok(filter('2'), 'phase 2 dir is in the milestone set');
    assert.ok(!filter('99'), 'a non-listed phase is excluded');
  });
});

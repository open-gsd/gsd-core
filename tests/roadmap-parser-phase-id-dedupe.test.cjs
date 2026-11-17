'use strict';

/**
 * roadmap-parser.cjs — one phase, one id, whatever its padding (#5895)
 *
 * Seam: `scanMilestonePhaseIds` (the declared-id Set the smart-entry position
 * text and the roadmap phase list are built from). A decimal phase written
 * `02.1` in its heading and `2.1` in the checklist or progress table is one
 * phase, and the first-seen spelling is the member. Ids that are genuinely
 * different (custom, letter-suffixed, milestone-prefixed) stay different.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { scanMilestonePhaseIds } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { classifyProject } = require('../gsd-core/bin/lib/smart-entry.cjs');
const { cleanup } = require('./helpers.cjs');

const ids = (roadmap, convention = 'default') => [...scanMilestonePhaseIds(roadmap, convention)];

const heading = (id, name = 'Work') => `### Phase ${id}: ${name}\n\nGoal.\n`;
const bullet = (id, name = 'Work') => `- [x] **Phase ${id}: ${name}**\n`;
const tableRow = (id, name = 'Work') => `| ${id} | ${name} | Complete |\n`;
const TABLE_HEAD = '| Phase | Name | Status |\n|---|---|---|\n';

describe('scanMilestonePhaseIds: one phase, one id (#5895)', () => {
  // The scan reads headings, then bullets, then table rows, so "first-seen" is
  // that source order: a heading's spelling wins over a bullet's or a row's.
  test('a heading and a checklist bullet that spell one decimal phase differently are one id', () => {
    assert.deepEqual(ids(`## Phases\n\n${bullet('2.1', 'UI')}\n${heading('02.1', 'UI')}`), ['02.1']);
    assert.deepEqual(ids(`## Phases\n\n${heading('02.1', 'UI')}\n${bullet('2.1', 'UI')}`), ['02.1']);
    assert.deepEqual(ids(`## Phases\n\n${heading('2.1', 'UI')}\n${bullet('02.1', 'UI')}`), ['2.1']);
  });

  test('a table row joins the same member', () => {
    assert.deepEqual(ids(`${heading('02.1')}\n${TABLE_HEAD}${tableRow('2.1')}`), ['02.1']);
    assert.deepEqual(ids(`${bullet('2.1')}\n${TABLE_HEAD}${tableRow('02.1')}`), ['2.1']);
    assert.deepEqual(ids(`${bullet('2.1')}\n${heading('02.1')}\n${TABLE_HEAD}${tableRow('02.1')}`), ['02.1']);
  });

  test('the first-seen spelling is kept, in scan order, across several phases', () => {
    const roadmap = [
      bullet('1'), bullet('2'), bullet('2.1'), bullet('3'),
      heading('01'), heading('02'), heading('02.1'), heading('03'),
    ].join('\n');
    assert.deepEqual(ids(roadmap), ['01', '02', '02.1', '03']);
  });

  test('00.1 and 0.1 are one phase', () => {
    assert.deepEqual(ids(`${heading('00.1')}\n${bullet('0.1')}`), ['00.1']);
  });

  test('distinct phases stay distinct', () => {
    const roadmap = ['9', '10', '2', '2.1', '2A', '2B', '2.1.1'].map((id) => heading(id)).join('\n');
    assert.deepEqual(ids(roadmap), ['9', '10', '2', '2.1', '2A', '2B', '2.1.1']);
  });

  test('custom, milestone-prefixed and sentinel ids keep their identity', () => {
    const roadmap = ['2fa', '2fb', 'PROJ-42', 'AUTH-101', '1-2', '1-3', '999'].map((id) => heading(id)).join('\n');
    assert.deepEqual(ids(roadmap), ['2fa', '2fb', 'PROJ-42', 'AUTH-101', '1-2', '1-3']);
  });

  test('smart-entry reports the same position and total for a mixed and a consistently spelled ROADMAP', (t) => {
    const project = (roadmap) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5895-'));
      t.after(() => cleanup(dir));
      fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.planning', 'STATE.md'),
        '---\nstatus: planning\ncurrent_phase: 2.1\ntotal_phases: 4\n---\n\n# State\n\n**Status:** planning\n',
      );
      fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), roadmap);
      return dir;
    };
    const document = (headingIds, bulletIds) =>
      `# Roadmap\n\n## Milestone v1.0\n\n${bulletIds.map((id) => bullet(id, `W ${id}`)).join('')}\n${headingIds.map((id) => heading(id, `W ${id}`)).join('\n')}`;
    const classify = (roadmap) => classifyProject(project(roadmap));

    const consistent = classify(document(['1', '2', '2.1', '3'], ['1', '2', '2.1', '3']));
    const mixed = classify(document(['01', '02', '02.1', '03'], ['1', '2', '2.1', '3']));
    // The typed signal the position text is built from: four phases, not five.
    assert.equal(consistent.signals.milestone_phases.length, 4);
    assert.equal(mixed.signals.milestone_phases.length, 4);
    // The rendered `Phase N of M` text is compared, never pinned to a literal.
    assert.equal(mixed.summary, consistent.summary);
  });

  test('9 and 10, and 0.1 and 2.1, keep their numeric order through comparePhaseNum', () => {
    const { comparePhaseNum } = require('../gsd-core/bin/lib/phase-id.cjs');
    const declared = ids(['10', '9', '2.1', '0.1', '2'].map((id) => heading(id)).join('\n'));
    assert.deepEqual([...declared].sort((a, b) => comparePhaseNum(a, b)), ['0.1', '2', '2.1', '9', '10']);
  });

  test('property: respelling decimal ids padded or unpadded never changes how many phases are declared', () => {
    const phase = fc.record({
      major: fc.integer({ min: 1, max: 30 }),
      minor: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
    });
    fc.assert(fc.property(fc.array(phase, { minLength: 1, maxLength: 8 }), fc.boolean(), (phases, padHeadings) => {
      const spell = (p, pad) => {
        const major = pad ? String(p.major).padStart(2, '0') : String(p.major);
        return p.minor === undefined ? major : `${major}.${p.minor}`;
      };
      const unique = new Set(phases.map((p) => spell(p, false)));
      const roadmap = [
        ...phases.map((p) => heading(spell(p, padHeadings))),
        ...phases.map((p) => bullet(spell(p, !padHeadings))),
      ].join('\n');
      assert.equal(ids(roadmap).length, unique.size, roadmap);
    }), { seed: 5895, numRuns: 100 });
  });
});

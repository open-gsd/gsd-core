/**
 * #5761 (Phase 1 of epic #5692): the Roadmap Progress Module is the one owner of
 * "which table is the Progress table, and what is its milestone slice". These
 * tests pin the owner's rule and assert every migrated reader (the Progress
 * counters, the state contract, the workstream inventory) agrees with it. A
 * deliberately divergent reader is run through the same agreement check to
 * prove the check can go red.
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  locateRoadmapProgress,
  findProgressSection,
  normalizeMilestoneToken,
} = require('../gsd-core/bin/lib/roadmap-progress.cjs');
const { findTableWithColumns } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');
const { buildStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
const { inspectWorkstream } = require('../gsd-core/bin/lib/workstream-inventory.cjs');
const { cleanup } = require('./helpers.cjs');
const { createFixture, seedWorkstream } = require('./fixtures/index.cjs');

const HEADER = '| Phase | Milestone | Plans Complete | Status | Completed |\n| --- | --- | --- | --- | --- |';
const table = (rows) => `${HEADER}\n${rows.map(([p, ms, status]) => `| ${p} | ${ms} | 1/1 | ${status} | - |`).join('\n')}\n`;
const REAL = table([['3. Alpha', 'v2.0', 'Complete'], ['4. Beta', 'v2.0', 'In Progress'], ['5. Gamma', 'v2.0', 'Not started']]);
const DECOY = table([['7. Decoy A', 'v2.0', 'Complete'], ['8. Decoy B', 'v2.0', 'Complete']]);
const phaseCells = (rows) => rows.map((r) => r['Phase']);

describe('#5761 owner: where the Progress table is', () => {
  test('locates the table under ## Progress and reports the section range', () => {
    const content = `# Roadmap\n\n## Progress\n\n${REAL}\n## Later\n`;
    const { table: t, rows, section } = locateRoadmapProgress(content);
    assert.deepEqual(phaseCells(rows), ['3. Alpha', '4. Beta', '5. Gamma']);
    assert.equal(t.columns.includes('Milestone'), true);
    assert.equal(content.slice(section.start, section.start + 11), '## Progress');
    assert.equal(content.slice(section.end, section.end + 8), '## Later');
  });

  test('## Progress Tracker is a Progress heading', () => {
    const { rows } = locateRoadmapProgress(`## Progress Tracker\n\n${REAL}`);
    assert.equal(rows.length, 3);
  });

  test('a ## Progress inside a fenced block is ignored; the real section wins', () => {
    const content = `# Roadmap\n\n\`\`\`md\n## Progress\n\`\`\`\n\n${DECOY}\n## Progress\n\n${REAL}`;
    assert.deepEqual(phaseCells(locateRoadmapProgress(content).rows), ['3. Alpha', '4. Beta', '5. Gamma']);
  });

  test('a fenced ## Progress alone makes the document headingless (whole-document fallback)', () => {
    const content = `\`\`\`md\n## Progress\n\`\`\`\n\n${REAL}`;
    const loc = locateRoadmapProgress(content);
    assert.equal(loc.section, null);
    assert.equal(loc.rows.length, 3);
  });

  test('#2012 decoy: a same-column table before ## Progress is not the Progress table', () => {
    const content = `## Notes\n\n${DECOY}\n## Progress\n\n${REAL}`;
    assert.deepEqual(phaseCells(locateRoadmapProgress(content).rows), ['3. Alpha', '4. Beta', '5. Gamma']);
  });

  test('a Progress section with no matching table does not fall through to a later table', () => {
    const content = `## Progress\n\nnothing tracked yet\n\n## Notes\n\n${REAL}`;
    const loc = locateRoadmapProgress(content);
    assert.equal(loc.table, null);
    assert.deepEqual(loc.rows, []);
  });

  test('## Progressive and ### Progress are not Progress headings', () => {
    assert.equal(findProgressSection(`## Progressive Enhancement\n\n${REAL}`), null);
    assert.equal(findProgressSection(`### Progress\n\n${REAL}`), null);
    // The archive-span scan (roadmap-parser) asks this same question: level 1 is not the Progress section.
    assert.equal(findProgressSection(`# Progress\n\n${REAL}`), null);
    assert.equal(findProgressSection('Progress is made.\n| Progress |\n'), null);
  });

  test('CRLF content resolves like LF content', () => {
    const lf = `## Progress\n\n${REAL}`;
    assert.deepEqual(
      phaseCells(locateRoadmapProgress(lf.replace(/\n/g, '\r\n')).rows),
      phaseCells(locateRoadmapProgress(lf).rows),
    );
  });

  test('#5221 shape: a stray </details> after the Progress section does not hide the table', () => {
    const content = `## Progress\n\n${REAL}\n## Backlog\n\n<details><summary>old</summary>\n\nquote\n\n</details>\n`;
    assert.equal(locateRoadmapProgress(content).rows.length, 3);
  });

  test('column sets are probed in order: the first set with a table wins', () => {
    const flat = '| Phase | Plans Complete | Status | Completed |\n| --- | --- | --- | --- |\n| 1. A | 1/1 | Complete | - |\n';
    const content = `## Progress\n\n${flat}\n${REAL}`;
    const milestoneFirst = locateRoadmapProgress(content, { columns: [['Phase', 'Milestone'], ['Phase', 'Plans Complete']] });
    assert.equal(milestoneFirst.rows.length, 3);
    const flatFirst = locateRoadmapProgress(content, { columns: [['Phase', 'Plans Complete']] });
    assert.equal(flatFirst.rows.length, 1);
  });
});

describe('#5165 owner: the milestone slice', () => {
  const content = `## Progress\n\n${table([['1. Old', 'v1.0', 'Complete'], ['2. Cur', 'v1.1', 'In Progress'], ['3. Next', 'V1.1', 'Not started']])}`;

  test('milestone identity, not spelling: v1.1, V1.1, 1.1 and decorated cells are one milestone', () => {
    for (const spelling of ['v1.1', 'V1.1', ' 1.1 ', '**v1.1**', '`v1.1`']) {
      assert.deepEqual(phaseCells(locateRoadmapProgress(content, { milestone: spelling }).rows), ['2. Cur', '3. Next'], spelling);
    }
    assert.notEqual(normalizeMilestoneToken('v1.10'), normalizeMilestoneToken('v1.1'));
  });

  test('no milestone keeps every row; a table without the column keeps the whole table; no match is an empty slice', () => {
    assert.equal(locateRoadmapProgress(content).rows.length, 3);
    const flat = '## Progress\n\n| Phase | Plans Complete | Status | Completed |\n| --- | --- | --- | --- |\n| 1. A | 1/1 | Complete | - |\n';
    assert.equal(locateRoadmapProgress(flat, { milestone: 'v9' }).rows.length, 1);
    assert.deepEqual(locateRoadmapProgress(content, { milestone: 'v9.9' }).rows, []);
  });

  test('deriveProgressFromRoadmap counts only the named milestone', () => {
    const d = deriveProgressFromRoadmap(content, 'v1.1');
    assert.equal(d.totalPhases, 2);
    assert.equal(d.completedPhases, null);
    assert.equal(deriveProgressFromRoadmap(content, 'v1.0').completedPhases, 1);
  });
});

// ── Reader agreement ────────────────────────────────────────────────────────
// Every fixture's expected Progress table is what the OWNER returns. Each reader
// is reduced to "the phase numbers it believes are in the Progress table" and
// compared. `check` returns the names of fixtures where the reader disagrees.
const CORPUS = {
  plain: `# Roadmap\n\n## Progress\n\n${REAL}`,
  tracker: `# Roadmap\n\n## Progress Tracker\n\n${REAL}`,
  'decoy-before': `# Roadmap\n\n## Notes\n\n${DECOY}\n## Progress\n\n${REAL}`,
  'fenced-heading-first': `# Roadmap\n\n\`\`\`md\n## Progress\n\`\`\`\n\n${DECOY}\n## Progress\n\n${REAL}`,
  headingless: `# Roadmap\n\n${REAL}`,
};
const phaseNumbers = (rows) => rows.map((r) => /^\d+/.exec(r['Phase'])[0]);
const expectedFor = (content) => phaseNumbers(locateRoadmapProgress(content).rows);

function check(reader) {
  return Object.entries(CORPUS)
    .filter(([, content]) => JSON.stringify(reader(content)) !== JSON.stringify(expectedFor(content)))
    .map(([name]) => name);
}

describe('#5761 readers agree with the owner', () => {
  let tmp;
  beforeEach(() => { tmp = createFixture(); });
  afterEach(() => cleanup(tmp));

  const viaDerive = (content) => {
    // total + complete counts are enough to tell the REAL table from the decoy (3 vs 2 rows)
    const d = deriveProgressFromRoadmap(content, 'v2.0');
    return [d.totalPhases, d.completedPhases];
  };
  const derivedExpectation = (content) => {
    const rows = locateRoadmapProgress(content, { milestone: 'v2.0' }).rows;
    return [rows.length || null, rows.filter((r) => r['Status'] === 'Complete').length || null];
  };

  test('deriveProgressFromRoadmap', () => {
    for (const [name, content] of Object.entries(CORPUS)) {
      assert.deepEqual(viaDerive(content), derivedExpectation(content), name);
    }
  });

  test('buildStateContract phases', () => {
    const viaContract = (content) => {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), content);
      return buildStateContract(tmp, { now: () => 0, classify: () => ({ actions: [], recommended: null, summary: '' }) })
        .phases.map((p) => p.number);
    };
    assert.deepEqual(check(viaContract), []);
  });

  test('workstream inventory denominator', () => {
    let n = 0;
    const viaInventory = (content) => {
      const name = `ws-${n++}`;
      const wsDir = seedWorkstream(tmp, { name });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
      fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), content);
      const inv = inspectWorkstream(tmp, name, { active: null });
      return Array.from({ length: inv.roadmap_phase_count }, () => '#');
    };
    const expectedCount = (content) => Array.from({ length: expectedFor(content).length }, () => '#');
    for (const [name, content] of Object.entries(CORPUS)) {
      assert.deepEqual(viaInventory(content), expectedCount(content), name);
    }
  });

  test('positive control: a deliberately divergent reader goes red', () => {
    // The pre-owner workstream-inventory shape: first matching table in the whole document.
    const divergent = (content) => phaseNumbers(findTableWithColumns(content, ['Phase', 'Milestone']).rows);
    const red = check(divergent);
    assert.ok(red.includes('decoy-before'), `divergent reader must disagree on the decoy fixture, got ${JSON.stringify(red)}`);
    assert.ok(red.length > 0);
    // And a reader that delegates to the owner is green on the same corpus.
    assert.deepEqual(check((content) => phaseNumbers(locateRoadmapProgress(content).rows)), []);
  });
});

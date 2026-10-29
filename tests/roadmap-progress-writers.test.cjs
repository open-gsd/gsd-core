/**
 * #5762 (Phase 2 of epic #5692): the Progress WRITERS edit the table the
 * READERS read. `locateRoadmapProgress` (Phase 1, #5761) is the one owner of
 * "which table is the Progress table"; every writer slice now comes from the
 * same owner, so a fenced `## Progress` example, a `## Progress Tracker`
 * heading or a same-column decoy table cannot send a writer to a different
 * table than the one `deriveProgressFromRoadmap`, the state contract and the
 * workstream inventory read. A deliberately divergent writer (the pre-owner
 * regex slice) is run through the same agreement check to prove it can go red.
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { locateRoadmapProgress, editRoadmapProgress, findProgressSection, isProgressHeadingTitle } = require('../gsd-core/bin/lib/roadmap-progress.cjs');
const { editProgressTableSlice } = require('../gsd-core/bin/lib/roadmap.cjs');
const { updateTraceabilityCell } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');

const HEADER = '| Phase | Plans Complete | Status | Completed |\n| --- | --- | --- | --- |';
const rowsOf = (...phases) => phases.map(([n, name, plans = '0/1', status = 'Planned']) => `| ${n}. ${name} | ${plans} | ${status} | - |`).join('\n');
const table = (rows) => `${HEADER}\n${rows}\n`;
const REAL = table(rowsOf([3, 'Alpha'], [4, 'Beta'], [5, 'Gamma']));
const DECOY = table(rowsOf([7, 'Decoy A'], [8, 'Decoy B']));
const phaseNumbers = (rows) => rows.map((r) => /^\d+/.exec(r['Phase'])[0]);

const CORPUS = {
  plain: `# Roadmap\n\n## Progress\n\n${REAL}`,
  tracker: `# Roadmap\n\n## Progress Tracker\n\n${REAL}`,
  'decoy-before': `# Roadmap\n\n## Notes\n\n${DECOY}\n## Progress\n\n${REAL}`,
  'fenced-heading-first': `# Roadmap\n\n\`\`\`md\n## Progress\n\n${DECOY}\`\`\`\n\n## Progress\n\n${REAL}`,
  'fenced-comment-in-section': `# Roadmap\n\n## Progress\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n${REAL}`,
  headingless: `# Roadmap\n\n${REAL}`,
};
const expectedFor = (content) => phaseNumbers(locateRoadmapProgress(content).rows);

// Each writer is reduced to "the slice it hands to its edit callback". The
// slice must resolve, through the OWNER, to the table the owner locates.
const WRITERS = {
  'editRoadmapProgress': (content, edit) => editRoadmapProgress(content, edit),
  'editProgressTableSlice (roadmap update-plan-progress / phase add / phase complete)': (content, edit) => editProgressTableSlice(content, edit, null),
};

function sliceSeenBy(writer, content) {
  const seen = [];
  const out = writer(content, (scoped) => { seen.push(scoped); return scoped; });
  return { seen, out };
}

function check(writer) {
  return Object.entries(CORPUS)
    .filter(([, content]) => {
      const { seen } = sliceSeenBy(writer, content);
      // An empty expectation would let two empty row lists "agree".
      return expectedFor(content).length === 0 || seen.length !== 1 || JSON.stringify(phaseNumbers(locateRoadmapProgress(seen[0]).rows)) !== JSON.stringify(expectedFor(content));
    })
    .map(([name]) => name);
}

describe('#5762 writers hand their edit the slice the owner locates', () => {
  for (const [name, writer] of Object.entries(WRITERS)) {
    test(`${name}: every corpus fixture`, () => {
      assert.deepEqual(check(writer), []);
    });

    test(`${name}: an identity edit is a lossless splice`, () => {
      for (const [fixture, content] of Object.entries(CORPUS)) {
        assert.equal(sliceSeenBy(writer, content).out, content, fixture);
      }
    });
  }

  test('positive control: the pre-owner regex slice goes red on the fenced heading', () => {
    // The shape every writer carried before the owner: first `## Progress` by regex, fence-blind.
    const divergent = (content, edit) => {
      const m = content.match(/^##[ \t]+Progress\b/im);
      if (!m || m.index === undefined) return edit(content);
      const from = content.slice(m.index);
      const next = from.search(/\n#{1,2}[ \t]/);
      const scoped = next >= 0 ? from.slice(0, next) : from;
      return content.slice(0, m.index) + edit(scoped) + (next >= 0 ? from.slice(next) : '');
    };
    const red = check(divergent);
    assert.ok(red.includes('fenced-heading-first'), `divergent writer must disagree on the fenced fixture, got ${JSON.stringify(red)}`);
    assert.ok(red.includes('fenced-comment-in-section'), `a fenced "# comment" ends the regex slice early, got ${JSON.stringify(red)}`);
  });

  test('a decoy table before ## Progress keeps every byte', () => {
    const content = CORPUS['decoy-before'];
    const out = editRoadmapProgress(content, (s) => s.replace('Planned', 'Done'));
    assert.ok(out.startsWith(`# Roadmap\n\n## Notes\n\n${DECOY}\n## Progress`));
    assert.equal((out.match(/Done/g) || []).length, 1);
  });
});

describe('#5762 owner write side: headingless, active range, edges', () => {
  test("headingless 'whole' edits the document the readers scan; 'skip' never calls edit", () => {
    let calls = 0;
    const whole = editRoadmapProgress(CORPUS.headingless, (s) => { calls += 1; return s.replace('Alpha', 'Edited'); });
    assert.equal(calls, 1);
    assert.ok(whole.includes('Edited'));
    calls = 0;
    const skipped = editRoadmapProgress(CORPUS.headingless, (s) => { calls += 1; return s; }, { headingless: 'skip' });
    assert.equal(calls, 0);
    assert.equal(skipped, CORPUS.headingless);
  });

  test('## Progressive, ### Progress and # Progress are not Progress sections', () => {
    for (const heading of ['## Progressive', '### Progress', '# Progress']) {
      let calls = 0;
      const content = `${heading}\n\n${REAL}`;
      assert.equal(editRoadmapProgress(content, (s) => { calls += 1; return s; }, { headingless: 'skip' }), content, heading);
      assert.equal(calls, 0, heading);
    }
  });

  test('the Progress section in the active range wins over an earlier one (#5553)', () => {
    const first = `## Progress\n\n${table(rowsOf([1, 'Shipped']))}\n## Shipped\n\n`;
    const second = `## Progress\n\n${table(rowsOf([2, 'Active']))}`;
    const content = `${first}${second}`;
    const active = { start: first.length, end: content.length };
    const seenActive = [];
    editRoadmapProgress(content, (s) => { seenActive.push(s); return s; }, { active });
    assert.equal(seenActive.length, 1);
    assert.ok(seenActive[0].includes('Active') && !seenActive[0].includes('Shipped'));
    const seenDefault = [];
    editRoadmapProgress(content, (s) => { seenDefault.push(s); return s; });
    assert.ok(seenDefault[0].includes('Shipped'));
  });

  test('an active range holding no Progress heading falls back to the first one', () => {
    const content = `## Progress\n\n${table(rowsOf([1, 'Only']))}\n## Later\n\ntext\n`;
    const seen = [];
    editRoadmapProgress(content, (s) => { seen.push(s); return s; }, { active: { start: content.indexOf('## Later'), end: content.length } });
    assert.ok(seen[0].includes('Only'));
  });

  test('boundary: a Progress section that is the last thing in the file, with and without a trailing newline', () => {
    for (const tail of ['', '\n']) {
      const content = `# R\n\n## Progress\n\n${HEADER}\n${rowsOf([1, 'Last'])}${tail}`;
      const out = editRoadmapProgress(content, (s) => s.replace('Planned', 'Done'));
      assert.equal(out, content.replace('Planned', 'Done'), JSON.stringify(tail));
    }
  });

  test('the slice ends at an indented or bare ## heading, as the readers do (documented change)', () => {
    for (const next of ['  ## Indented', '##']) {
      const content = `## Progress\n\n${HEADER}\n${rowsOf([1, 'One'])}\n${next}\n\ntail\n`;
      const seen = [];
      editRoadmapProgress(content, (s) => { seen.push(s); return s; });
      assert.ok(!seen[0].includes('tail'), JSON.stringify(next));
    }
  });

  test('exclude drops candidate headings (the bracket remover skips archived milestones)', () => {
    const first = `## Progress\n\n${table(rowsOf([1, 'Archived']))}\n## Next\n\n`;
    const content = `${first}## Progress\n\n${table(rowsOf([2, 'Live']))}`;
    const section = findProgressSection(content, { exclude: (offset) => offset === 0 });
    assert.equal(section.start, first.length);
    assert.ok(isProgressHeadingTitle('Progress (v2.1)') && isProgressHeadingTitle('progress tracker'));
    assert.ok(!isProgressHeadingTitle('Progressive') && !isProgressHeadingTitle('Not Progress'));
  });

  test('CRLF content: the splice adds no bare LF and a CRLF section equals the LF result', () => {
    const lf = CORPUS['decoy-before'];
    const crlf = lf.replace(/\n/g, '\r\n');
    const out = editRoadmapProgress(crlf, (s) => s.replace('Planned', 'Done'));
    assert.ok(!/(?<!\r)\n/.test(out), 'no bare \\n introduced');
    assert.equal(out.replace(/\r\n/g, '\n'), editRoadmapProgress(lf, (s) => s.replace('Planned', 'Done')));
  });

  test('a blank line between the table and the next heading survives a row insert at the section end', () => {
    const content = `## Progress\n\n${HEADER}\n${rowsOf([1, 'One'])}\n\n## Later\n`;
    const out = editProgressTableSlice(content, (s) => `${s.trimEnd()}\n| 2. Two | 0/0 | Not started | - |\n`, null);
    assert.ok(/\| 2\. Two \|[^\n]*\n\n?## Later/.test(out), out);
  });
});

describe('#5762 CLI writers edit the table the readers read', () => {
  let dir;
  beforeEach(() => {
    dir = createFixture();
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\nmilestone: v1.0\n---\n\n# State\n');
  });
  afterEach(() => cleanup(dir));

  // A fenced example `## Progress` (with its own table) sits BEFORE the real section.
  const FENCED = `\`\`\`md\n## Progress\n\n${table(rowsOf([1, 'One'], [2, 'Two'], [3, 'Three']))}\`\`\`\n`;
  const roadmap = () => [
    '# Roadmap',
    '',
    FENCED,
    '### Phase 1: One\n**Goal:** a\n',
    '### Phase 2: Two\n**Goal:** b\n',
    '### Phase 3: Three\n**Goal:** c\n',
    `## Progress\n\n${table(rowsOf([1, 'One'], [2, 'Two'], [3, 'Three']))}`,
  ].join('\n');
  const write = (text) => fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), text);
  const read = () => fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
  const split = (text) => {
    const at = text.lastIndexOf('\n## Progress');
    return { before: text.slice(0, at), real: text.slice(at) };
  };
  const mkdirs = (...names) => names.forEach((n) => fs.mkdirSync(path.join(dir, '.planning', 'phases', n), { recursive: true }));

  test('roadmap update-plan-progress updates the real table and leaves the fenced copy byte-identical', () => {
    mkdirs('01-one', '02-two', '03-three');
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-two', '02-01-PLAN.md'), '# plan\n');
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-two', '02-01-SUMMARY.md'), '# summary\n');
    write(roadmap());
    const r = runGsdTools(['roadmap', 'update-plan-progress', '2'], dir);
    assert.ok(r.success, r.error);
    const after = split(read());
    assert.equal(after.before, split(roadmap()).before, 'the fenced example must not be edited');
    const row = locateRoadmapProgress(read()).rows.find((x) => x['Phase'].startsWith('2.'));
    assert.equal(row['Plans Complete'].trim(), '1/1');
  });

  test('phase remove deletes the row from the real table and leaves the fenced copy byte-identical', () => {
    mkdirs('01-one', '02-two', '03-three');
    write(roadmap());
    const r = runGsdTools(['phase', 'remove', '2'], dir);
    assert.ok(r.success, r.error);
    const after = split(read());
    assert.equal(after.before.includes('| 2. Two |'), true, 'the fenced example must not be edited (row still present)');
    assert.deepEqual(locateRoadmapProgress(read()).rows.map((x) => x['Phase'].trim()), ['1. One', '2. Three']);
  });

  test('phase remove with no Progress heading edits no table (a Phase|Requirements decoy keeps every byte)', () => {
    mkdirs('01-one', '02-two', '03-three');
    const decoy = '| Phase | Requirements | Count |\n| --- | --- | --- |\n| 2. Two | REQ-1 | 1 |\n';
    const text = `# Roadmap\n\n${decoy}\n### Phase 1: One\n**Goal:** a\n\n### Phase 2: Two\n**Goal:** b\n\n### Phase 3: Three\n**Goal:** c\n`;
    write(text);
    const r = runGsdTools(['phase', 'remove', '2'], dir);
    assert.ok(r.success, r.error);
    assert.ok(read().includes(decoy), 'the decoy table is untouched');
  });

  test('drift-guard phase-status reads a ## Progress Tracker table like every other reader', () => {
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      "---\ngsd_state_version: '1.0'\nstatus: planning\n---\n\n# Project State\n\n## Current Position\n\nPhase: 3 of 8 (Alpha)\nPlan: 1 of 1 in current phase\nStatus: Phase complete\nLast activity: 2026-08-09 — fixture\n",
    );
    write(`# Roadmap\n\n## Progress Tracker\n\n${table(rowsOf([3, 'Alpha', '1/1', 'Complete']))}`);
    const r = runGsdTools(['drift-guard', 'phase-status', '--phase', '3'], dir);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).verdict, 'consistent');
  });
});

describe('#5762 one Traceability slice for REQUIREMENTS.md', () => {
  const REQ_TABLE = '| Requirement | Phase | Status |\n| --- | --- | --- |\n| AUTH-01 | 1 | Pending |\n| AUTH-02 | 2 | Pending |\n';
  const OUT_OF_SCOPE = '| Feature | Reason |\n| --- | --- |\n| Mobile | later |\n';
  const byReq = (id) => (row) => (Object.values(row)[0] ?? '').trim() === id;
  const flip = (text, id) => updateTraceabilityCell(text, byReq(id), 'Status', ' Complete ');

  test('## Traceability and ## Traceability Status both scope the write', () => {
    for (const heading of ['## Traceability', '## Traceability Status']) {
      const res = flip(`# Reqs\n\n## Out of Scope\n\n${OUT_OF_SCOPE}\n${heading}\n\n${REQ_TABLE}`, 'AUTH-02');
      assert.equal(res.ok, true, heading);
      assert.ok(res.value.includes('| AUTH-02 | 2 | Complete |'), heading);
      assert.ok(res.value.includes(OUT_OF_SCOPE), `${heading}: the Out of Scope table keeps every byte`);
    }
  });

  test('no Traceability heading falls back to the whole text', () => {
    const res = flip(`# Reqs\n\n${REQ_TABLE}`, 'AUTH-01');
    assert.equal(res.ok, true);
    assert.ok(res.value.includes('| AUTH-01 | 1 | Complete |'));
  });

  test('a fenced ## Traceability example does not capture the write', () => {
    const fenced = `\`\`\`md\n## Traceability\n\n${REQ_TABLE.replace('Pending', 'Example')}\`\`\`\n`;
    const content = `# Reqs\n\n${fenced}\n## Traceability\n\n${REQ_TABLE}`;
    const res = flip(content, 'AUTH-01');
    assert.equal(res.ok, true);
    assert.ok(res.value.startsWith(`# Reqs\n\n${fenced}`), 'the fenced example keeps every byte');
    assert.ok(res.value.endsWith('| AUTH-01 | 1 | Complete |\n| AUTH-02 | 2 | Pending |\n'));
  });

  test('a row that is not in the Traceability table reports no matching row', () => {
    const res = flip(`## Traceability\n\n${REQ_TABLE}`, 'AUTH-99');
    assert.equal(res.ok, false);
  });
});

'use strict';

/**
 * #5027: the roadmap template's `Plans:` checklist rows must render, from CLI
 * output alone, to the identity `roadmap update-plan-progress` ticks: the plan
 * file stem (`padded_phase-LL`). A display label in those rows is never
 * matched, so a plan would stay unticked under every convention.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const TEMPLATE = path.join(__dirname, '..', 'gsd-core', 'templates', 'roadmap.md');
const projects = new Set();
afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function run(args, cwd) {
  const result = runGsdTools(args, cwd);
  assert.equal(result.success, true, `${args.join(' ')} failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

/** The first `Plans:` checklist in the template's fenced roadmap example. */
function templatePlanRows() {
  const block = extractFencedBlock(fs.readFileSync(TEMPLATE, 'utf8'), 'markdown');
  assert.ok(block, 'roadmap template keeps its fenced markdown example');
  const lines = block.split('\n');
  const start = lines.indexOf('Plans:');
  assert.notEqual(start, -1, 'template example has a Plans: checklist');
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^- \[[ x]\] /.test(line)) break;
    rows.push(line);
  }
  assert.ok(rows.length >= 2, 'template Plans: checklist has rows');
  return rows;
}

/** Fill a template row from CLI output only; any other identity placeholder is unresolvable. */
function renderRow(row, paddedPhase, planNumber) {
  const rendered = row
    .replaceAll('{padded_phase}', paddedPhase)
    .replaceAll('{plan_padded}', String(planNumber).padStart(2, '0'));
  assert.doesNotMatch(rendered, /\{[A-Za-z_]+\}/,
    `template plan row ${JSON.stringify(row)} needs an identity the CLI does not return`);
  return rendered;
}

// bracket: `roadmap update-plan-progress` does not yet locate the
// writer-created `### [CK.01] 01: Alpha` section (`roadmap get-phase` does),
// so it reports `missing_phase_details` and ticks nothing. That reader gap
// predates PR-6 and is outside its scope. Per CONTRIBUTING (no skip, no todo),
// the bracket case asserts today's observed outcome; when the reader is fixed
// this assertion breaks and flips to the ticked expectation.
const CONVENTIONS = [
  { convention: 'sequential', milestone: '## v1.0 Foundation', ticks: true },
  { convention: 'milestone-prefixed', milestone: '## v1.0 Foundation', ticks: true },
  { convention: 'bracket', milestone: '## [CK.01] v1.0 — Foundation', ticks: false },
];

for (const { convention, milestone, ticks } of CONVENTIONS) {
  test(`template Plans: rows render to the plan stem update-plan-progress ticks (${convention})`, () => {
    const dir = createTempProject('gsd-5027-plan-rows-');
    projects.add(dir);
    const planning = (...parts) => path.join(dir, '.planning', ...parts);
    fs.writeFileSync(planning('config.json'),
      `${JSON.stringify({ project_code: 'CK', phase_id_convention: convention }, null, 2)}\n`);
    fs.writeFileSync(planning('STATE.md'), '---\nmilestone: v1.0\n---\n');
    fs.writeFileSync(planning('ROADMAP.md'), `# Roadmap\n\n${milestone}\n`);

    const added = run(['phase', 'add', 'Alpha'], dir);
    const init = run(['init', 'plan-phase', String(added.phase_number)], dir);
    assert.equal(init.phase_found, true);
    const rows = templatePlanRows().map((row, i) => renderRow(row, init.padded_phase, i + 1));

    // The writer leaves a TBD placeholder row; the template's rows replace it.
    const roadmapPath = planning('ROADMAP.md');
    const written = fs.readFileSync(roadmapPath, 'utf8');
    assert.match(written, /^- \[ \] TBD\b.*$/m, `${convention}: phase add writes a TBD plan row`);
    fs.writeFileSync(roadmapPath, written.replace(/^- \[ \] TBD\b.*$/m, rows.join('\n')));
    const phaseDir = path.resolve(dir, init.phase_dir);
    const stem = `${init.padded_phase}-01`;
    fs.writeFileSync(path.join(phaseDir, `${stem}-PLAN.md`), '---\nwave: 1\ndepends_on: []\n---\n\n# Plan\n');
    fs.writeFileSync(path.join(phaseDir, `${stem}-SUMMARY.md`), '# Summary\n');
    // The rendered row names exactly the plan file stem the ticker keys on.
    assert.ok(rows[0].startsWith(`- [ ] ${stem}: `), `${convention}: ${rows[0]} must start with ${stem}`);

    const progress = run(['roadmap', 'update-plan-progress', String(added.phase_number)], dir);

    const roadmap = fs.readFileSync(roadmapPath, 'utf8');
    assert.ok(roadmap.includes(rows[1]), `${convention}: an unexecuted plan's row stays unticked`);
    assert.equal(roadmap.split(stem).length - 1, 1,
      `${convention}: no duplicate row is inserted beside the template row:\n${roadmap}`);
    if (ticks) {
      assert.ok(roadmap.includes(rows[0].replace('- [ ] ', '- [x] ')),
        `${convention}: the completed plan's template row must be ticked:\n${roadmap}`);
    } else {
      assert.equal(progress.reason, 'missing_phase_details');
      assert.ok(roadmap.includes(rows[0]), `${convention}: current reader leaves the row unticked`);
    }
  });
}

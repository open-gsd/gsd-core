/**
 * GSD Tools Tests - New Milestone Research Decision (#5148)
 *
 * Structural tests for gsd-core/workflows/new-milestone.md (the #5148
 * approval, plus the two docs rows ruled in on 2026-11-05):
 *  1. research scope covers the existing codebase, not only new features,
 *     and per-dimension fields and the codebase-map instruction match it,
 *  2. `(Recommended)` is bound to `research_enabled`,
 *  3. a researcher subset requires user-visible disclosure, and the
 *     synthesizer's required_reading lists only files written in this run,
 *  4. Step 9 reads FEATURES.md only when the features dimension ran,
 *  5. Step 10 passes SUMMARY.md to the roadmapper only when research ran,
 *     and states the inline-roadmap branch when agents_installed is false,
 *  6. this run's outputs are cleared first, and only on a real spawn.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const NEW_MILESTONE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
const workflow = readFileNormalized(NEW_MILESTONE_PATH);

/** Step body: from its `## N. Title` heading up to the next `## ` heading. */
function stepBody(heading) {
  const start = workflow.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `"${heading}" heading is missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n## \d+\./);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Researcher template slice of a step body: common-structure heading to the researcher spawn. */
function researcherTemplate(step) {
  const start = step.indexOf('**Common structure for every researcher:**');
  const end = step.indexOf('subagent_type="gsd-project-researcher"');
  assert.ok(start !== -1 && end > start, 'researcher template is missing');
  return step.slice(start, end);
}

describe('new-milestone Step 8 research decision (#5148)', () => {
  const body = stepBody('## 8. Research Decision');

  test('both prompts include the existing codebase in research scope', () => {
    const prompts = body.match(/AskUserQuestion: "[^"]*"/g) || [];
    assert.equal(prompts.length, 2, 'expected one prompt per research_enabled branch');
    for (const prompt of prompts) {
      assert.match(prompt, /existing codebase/i, `prompt lacks codebase scope: ${prompt}`);
    }
    const researchFirst = body.match(/- "Research first[^\n]*/g) || [];
    assert.equal(researchFirst.length, 2, 'expected a "Research first" option in each branch');
    for (const option of researchFirst) {
      assert.match(option, /existing codebase/i, `option lacks codebase scope: ${option}`);
    }
  });

  test('the research question is flagged as moot when agents_installed is false', () => {
    const question = body.indexOf('AskUserQuestion');
    assert.ok(body.slice(0, question).includes('research cannot run this milestone'),
      'Step 8 must say before the question that research cannot run this milestone when agents_installed is false');
  });

  test('(Recommended) is tied to research_enabled and marks one option only', () => {
    const parts = body.split('**If `research_enabled` is `false`:**');
    assert.equal(parts.length, 2, 'expected exactly one false-branch marker');
    const [enabled, disabled] = parts;
    const marked = (text) => (text.match(/^- "[^\n]*\(Recommended\)[^\n]*/gm) || []);
    const enabledMarks = marked(enabled);
    assert.equal(enabledMarks.length, 1, 'exactly one option carries (Recommended) when research_enabled is true');
    assert.ok(enabledMarks[0].startsWith('- "Research first (Recommended)"'));
    assert.deepEqual(marked(disabled), [], 'no option may carry (Recommended) when research_enabled is false');
    assert.match(body, /`\(Recommended\)` is bound to `research_enabled`/);
  });

  test('a researcher subset must be disclosed to the user before spawning', () => {
    assert.match(body, /Drop a dimension only when it clearly does not apply/);
    assert.match(body, /At least one must run/);
    assert.match(body, /tell the user before spawning/);
    assert.match(body, /Skipping: \{dimension\(s\)\}/);
    assert.match(body, /Never drop one silently/);
    assert.doesNotMatch(workflow, /Spawning 4 researchers|four researchers|Run all 4 researchers|4 parallel agents/i, 'researcher count must not be hardcoded');
    const spawn = body.indexOf('subagent_type="gsd-project-researcher"');
    assert.notEqual(spawn, -1, 'Step 8 must spawn gsd-project-researcher agents');
    assert.ok(body.indexOf('Skipping: {dimension(s)}') < spawn, 'disclosure must precede the researcher spawn');
  });

  test('synthesizer required_reading lists only files written in this run', () => {
    const synthStart = body.indexOf('After all complete, confirm that');
    assert.notEqual(synthStart, -1, 'synthesizer spawn step is missing');
    const synth = body.slice(synthStart);
    const intro = synth.split('Agent(prompt=')[0];
    assert.match(intro, /written by the researchers spawned in this run/);
    assert.match(intro, /never files left from earlier runs/);
    assert.match(intro, /a missing file means that researcher failed/);
    const readingStart = synth.indexOf('<required_reading>');
    const readingEnd = synth.indexOf('</required_reading>');
    assert.ok(readingStart !== -1 && readingEnd > readingStart, 'synthesizer <required_reading> block is missing');
    const reading = synth.slice(readingStart, readingEnd);
    assert.equal(reading.trim(), '<required_reading>\n{required_reading_lines}', 'required_reading must hold only the built {required_reading_lines}');
    assert.match(synth, /Read only the files listed above; do not read other research files in \{research_dir\}/);
    assert.match(synth, /`Not researched \(dimension skipped\)`/);
    assert.match(synth, /intentionally skipped; their absence is expected/, 'synthesizer prompt must say skipped dimensions are expected');
    assert.match(synth, /Display key findings from SUMMARY\.md \(omit a line whose dimension was skipped/,
      'RESEARCH COMPLETE must not show findings for a skipped dimension');
  });

  test('researcher template scopes the milestone work, not only new features', () => {
    const template = researcherTemplate(body);
    assert.doesNotMatch(template, /NEW features|\[new features\]/, 'template must not limit research to new features');
    assert.match(template, /<research_type>[^<]*this milestone's work/);
    assert.match(template, /integration points and pitfalls in the existing codebase/);
  });

  test('per-dimension fields cover refactors and breakage, not only added features', () => {
    const table = body.slice(body.indexOf('**Dimension-specific fields:**'), body.indexOf('| FILE |'));
    assert.match(table, /\| QUESTION \|/, 'dimension table is missing');
    assert.doesNotMatch(table, /ADDING these features|adding \[target features\]|NEW capabilities|adding these features/,
      'dimension cells must not limit research to added features');
    assert.match(table, /What in the existing codebase could they break\?/);
    assert.match(table, /What do they couple to\?/);
    assert.doesNotMatch(workflow, /\[new features\]/, 'no step may still say [new features]');
  });

  test('researchers are told to read the codebase map, within the workflow text only', () => {
    const template = researcherTemplate(body);
    const context = template.slice(template.indexOf('<milestone_context>'), template.indexOf('</milestone_context>'));
    assert.match(context, /read the codebase map from `\/gsd:map-codebase` when the project has one; otherwise inspect the source this work touches/);
    assert.doesNotMatch(workflow, /codebase_map_files|\{codebase_map_lines\}/,
      'the approved scope is new-milestone.md only; no new init field feeds the researchers');
  });

  test('placeholders have a deterministic builder and outputs of an earlier run are cleared first', () => {
    assert.match(body, /`\{dimensions kept\}` is the list of dimensions that will run, in the order stack, features, architecture, pitfalls, and `\{N\}` is its count/);
    assert.match(body, /`\{required_reading_lines\}` is one line `- \{research_dir\}\/\{FILE\}` per dimension in `\{dimensions kept\}`/);
    assert.match(body, /`\{research_summary_line\}` is `- \{research_dir\}\/SUMMARY\.md` when research ran and an empty string when it did not/);
    const disclose = body.indexOf('Replacing research files:');
    const clear = body.indexOf('rm -f "{research_dir}/SUMMARY.md"');
    const spawn = body.indexOf('Spawn {N} parallel');
    assert.ok(disclose !== -1 && clear !== -1 && spawn !== -1, 'the disclosure, the removal, and the spawn must all exist');
    assert.ok(disclose < clear && clear < spawn, 'the replacement must be disclosed before the files are removed, and removal precedes the researcher spawn');
    assert.match(body, /earlier contents will be lost; only committed copies remain in git/);
    assert.match(body, /`rm -f "\{research_dir\}\/STACK\.md"`, `rm -f "\{research_dir\}\/FEATURES\.md"`, `rm -f "\{research_dir\}\/ARCHITECTURE\.md"`, and `rm -f "\{research_dir\}\/PITFALLS\.md"`/,
      'the removal must cover every dimension file, not only the kept ones');
    assert.doesNotMatch(body.slice(body.indexOf('Replacing research files:'), body.indexOf('Spawn {N} parallel')),
      /left in place and never read/, 'no stale file may be left behind for the synthesizer or self-heal');
    assert.match(body, /When `agents_installed` is false the parallel research spawn is skipped and the roadmap is generated inline \(Step 7\)/,
      'the clearing must be conditional on the spawn actually going ahead');
    assert.match(body, /do not print the spawn banner below, do not run the `mkdir` below, and do not remove anything — the earlier research files stay on disk/,
      'the agents_installed=false path must not print the banner, must not run the mkdir, and must leave the earlier research files on disk');
    assert.match(body, /research did not run: leave `\{research_summary_line\}` empty and take Step 9's "research was skipped" branch/,
      'the agents_installed=false path must state that research did not run, so Step 9 takes the skipped branch and the roadmapper gets no SUMMARY.md');
    const guard = body.indexOf('When `agents_installed` is false the parallel research spawn is skipped');
    const banner = body.indexOf('◆ Spawning {N} researcher(s)');
    assert.ok(guard !== -1 && banner !== -1 && guard < banner,
      'the agents_installed guard must precede the spawn banner, so the no-spawn path never shows it');
    const mkdir = body.indexOf('mkdir -p "{research_dir}"');
    assert.ok(guard !== -1 && mkdir !== -1 && guard < mkdir,
      'the agents_installed guard must precede the mkdir, so the no-spawn path never creates the directory');
    assert.ok(guard < body.indexOf('Skipping: {dimension(s)}'),
      'the agents_installed guard must precede the dimension-skip disclosure, so the no-spawn path never announces skipped dimensions');
    const removal = body.indexOf('Only when this run actually spawns researchers,');
    assert.notEqual(removal, -1,
      'the removal paragraph must state that it runs only when this run actually spawns researchers');
    assert.ok(guard < removal,
      'the conditional removal must come after the guard, so the no-spawn path removes nothing');
    const noticeStart = body.indexOf('Replacing research files:');
    const notice = body.slice(noticeStart, body.indexOf('`', noticeStart));
    for (const file of ['SUMMARY.md', 'STACK.md', 'FEATURES.md', 'ARCHITECTURE.md', 'PITFALLS.md']) {
      assert.ok(notice.includes(`{research_dir}/${file}`), `the replacement notice must name ${file}`);
    }
  });

  test('the Skip branch defines the empty research_summary_line default', () => {
    const skip = body.indexOf('**If "Skip research":**');
    assert.notEqual(skip, -1, 'the Skip research branch is missing');
    assert.match(body.slice(skip, skip + 300),
      /Research did not run: `\{research_summary_line\}` is an empty string/,
      'the Skip branch must define the empty default Step 10 relies on');
  });
});

describe('new-milestone Step 10 roadmapper uses research from this run (#5148)', () => {
  const body = stepBody('## 10. Create Roadmap');

  test('SUMMARY.md is passed only when research ran in Step 8', () => {
    assert.doesNotMatch(body, /SUMMARY\.md \(if exists\)/, 'SUMMARY.md must not be read just because it exists');
    const spawn = body.indexOf('Agent(prompt=');
    assert.notEqual(spawn, -1, 'Step 10 must spawn the roadmapper');
    assert.match(body.slice(0, spawn), /Fill `\{research_summary_line\}` as defined in Step 8, and remove the line when it is empty/);
    assert.match(body.slice(0, spawn), /never a SUMMARY\.md left from earlier runs/);
    assert.match(body.slice(spawn), /<required_reading>\n- \{project_path\}\n- \{requirements_path\}\n\{research_summary_line\}\n/);
  });

  test('the inline-roadmap branch is stated when agents_installed is false (Step 7)', () => {
    const banner = body.indexOf('◆ Spawning roadmapper');
    assert.notEqual(banner, -1, 'Step 10 keeps the spawn banner for the spawn path');
    const inline = body.slice(0, banner);
    assert.match(inline, /do not run the roadmapper spawn/,
      'Step 10 must state before the banner that the no-spawn path does not run the roadmapper spawn');
    assert.match(inline, /`## ROADMAP BLOCKED` cannot occur/,
      'the inline path must state that ROADMAP BLOCKED cannot occur there');
    assert.match(inline, /the orchestrator itself revises ROADMAP\.md, STATE\.md, and REQUIREMENTS\.md traceability/,
      'the inline path must say the orchestrator itself revises the roadmap files on Adjust and loops until approved');
  });
});

describe('new-milestone Step 11 banner uses the resolved research_dir (#5148)', () => {
  const body = stepBody('## 11. Done');

  test('the Research row names {research_dir} and appears only when research ran', () => {
    assert.doesNotMatch(workflow, /\.planning\/research/,
      'no research step may name the literal .planning/research path; init resolves the scoped {research_dir}');
    const researchRow = body.split('\n').find((l) => l.startsWith('| Research'));
    assert.ok(researchRow, 'the Step 11 artifact table must have a Research row');
    assert.match(researchRow, /`\{research_dir\}\/`/);
    assert.doesNotMatch(researchRow, /\.planning/);
    assert.match(body, /Omit the Research row above when research did not run in Step 8/);
  });
});

describe('new-milestone Step 9 requirements use research from this run (#5148)', () => {
  const body = stepBody('## 9. Define Requirements');

  test('FEATURES.md is read only when the features dimension ran', () => {
    assert.doesNotMatch(workflow, /If research exists:\*\* Read FEATURES\.md/, 'FEATURES.md must not be read unconditionally');
    const line = body.split('\n').find((l) => l.includes('FEATURES.md'));
    assert.ok(line, 'Step 9 must say when FEATURES.md is read');
    assert.match(line, /^\*\*If research ran in Step 8:\*\*/);
    assert.match(line, /`\{dimensions kept\}` includes features, read `\{research_dir\}\/FEATURES\.md`/);
    assert.match(line, /otherwise derive them from the milestone goals and SUMMARY\.md/);
    assert.match(line, /Never read research files left from earlier runs/);
  });
});

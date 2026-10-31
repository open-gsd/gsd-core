/**
 * GSD Tools Tests - New Milestone Research Decision (#5148)
 *
 * Structural tests verifying Step 8 of new-milestone.md:
 *  1. research scope covers the existing codebase, not only new features,
 *  2. `(Recommended)` is bound to `research_enabled`,
 *  3. a researcher subset requires user-visible disclosure and the
 *     synthesizer's required_reading lists only files written in this run,
 *  4. Step 9 reads FEATURES.md only when the features dimension ran,
 *  5. researchers are briefed on the milestone's work and the existing
 *     codebase, and research is not offered when agents are not installed,
 *  6. Step 10 passes SUMMARY.md to the roadmapper only when research ran,
 *  7. this run's outputs are cleared first, so an earlier run's file cannot pass
 *     for them, and the synthesizer prompt reads only the files it is given,
 *  8. per-dimension fields and the codebase-map instruction match that scope.
 * The scope is gsd-core/workflows/new-milestone.md only (the #5148 approval).
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
    assert.doesNotMatch(reading, /(STACK|FEATURES|ARCHITECTURE|PITFALLS)\.md/, 'no research file may be named unconditionally');
  });

  test('researcher template scopes the milestone work, not only new features', () => {
    const start = body.indexOf('**Common structure for every researcher:**');
    const end = body.indexOf('subagent_type="gsd-project-researcher"');
    assert.ok(start !== -1 && end > start, 'researcher template is missing');
    const template = body.slice(start, end);
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
    const start = body.indexOf('**Common structure for every researcher:**');
    const template = body.slice(start, body.indexOf('subagent_type="gsd-project-researcher"'));
    const context = template.slice(template.indexOf('<milestone_context>'), template.indexOf('</milestone_context>'));
    assert.match(context, /read the codebase map from `\/gsd:map-codebase` when the project has one; otherwise inspect the source this work touches/);
    assert.doesNotMatch(workflow, /codebase_map_files|\{codebase_map_lines\}/,
      'the approved scope is new-milestone.md only; no new init field feeds the researchers');
  });

  test('placeholders have a deterministic builder and outputs of an earlier run are cleared first', () => {
    assert.match(body, /`\{dimensions kept\}` is the list of dimensions that will run, in the order stack, features, architecture, pitfalls, and `\{N\}` is its count/);
    assert.match(body, /`\{required_reading_lines\}` is one line `- \{research_dir\}\/\{FILE\}` per dimension in `\{dimensions kept\}`/);
    assert.match(body, /`\{research_summary_line\}` is `- \{research_dir\}\/SUMMARY\.md` when research ran and an empty string when it did not/);
    const clear = body.indexOf('rm -f {research_dir}/SUMMARY.md');
    const spawn = body.indexOf('Spawn {N} parallel');
    assert.ok(clear !== -1 && spawn !== -1 && clear < spawn, 'outputs must be cleared before the researchers are spawned');
    assert.match(body, /`rm -f \{research_dir\}\/\{FILE\}` for each dimension in `\{dimensions kept\}`/);
  });

  test('without installed agents, research is skipped without asking', () => {
    const ask = body.indexOf('AskUserQuestion');
    const gate = body.indexOf('**If `agents_installed` is false:** do not ask');
    assert.ok(gate !== -1 && gate < ask, 'the agents_installed gate must precede the research prompt');
    assert.match(body, /continue to Step 9 as if the user chose Skip/);
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
});

describe('new-milestone Step 9 requirements use research from this run (#5148)', () => {
  const body = stepBody('## 9. Define Requirements');

  test('FEATURES.md is read only when the features dimension ran', () => {
    assert.doesNotMatch(workflow, /If research exists:\*\* Read FEATURES\.md/, 'FEATURES.md must not be read unconditionally');
    const line = body.split('\n').find((l) => l.includes('FEATURES.md'));
    assert.ok(line, 'Step 9 must say when FEATURES.md is read');
    assert.match(line, /^\*\*If research ran in Step 8:\*\*/);
    assert.match(line, /`\{dimensions kept\}` includes features, read FEATURES\.md/);
    assert.match(line, /otherwise derive them from the milestone goals and SUMMARY\.md/);
    assert.match(line, /Never read research files left from earlier runs/);
  });
});

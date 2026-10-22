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
 *  7. the synthesizer contract does not require all four research files,
 *  8. per-dimension fields and the codebase-map input match that scope, and
 *     the /gsd-new-milestone command describes it the same way.
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
    const synthStart = body.indexOf('After all complete, spawn synthesizer');
    assert.notEqual(synthStart, -1, 'synthesizer spawn step is missing');
    const synth = body.slice(synthStart);
    assert.match(synth.split('Agent(prompt=')[0], /written by the researchers spawned in this run/);
    assert.match(synth.split('Agent(prompt=')[0], /never files left from earlier runs/);
    const reading = synth.slice(synth.indexOf('<required_reading>'), synth.indexOf('</required_reading>'));
    assert.match(reading, /\{required_reading_lines\}/);
    assert.match(synth, /intentionally skipped; their absence is expected/, 'synthesizer prompt must say skipped dimensions are expected');
    assert.match(synth, /Display key findings from SUMMARY\.md \(omit a line whose dimension was skipped/,
      'RESEARCH COMPLETE must not show findings for a skipped dimension');
    assert.doesNotMatch(reading, /^- \{research_dir\}\/PITFALLS\.md$/m, 'PITFALLS.md must not be unconditional');
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

  test('researchers get the codebase map as an explicit input', () => {
    assert.match(workflow, /`codebase_map_files`/, 'Step 7 must extract codebase_map_files');
    const start = body.indexOf('**Common structure for every researcher:**');
    const template = body.slice(start, body.indexOf('subagent_type="gsd-project-researcher"'));
    const reading = template.slice(template.indexOf('<required_reading>'), template.indexOf('</required_reading>'));
    assert.match(reading, /\{codebase_map_lines\}/);
    assert.match(body.slice(0, start), /Fill `\{codebase_map_lines\}` with one `- \{file\} \(Codebase map\)` line per entry in `codebase_map_files`/);
    assert.match(template, /otherwise inspect the source this work touches/);
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
    assert.match(body.slice(0, spawn), /`\{research_dir\}\/SUMMARY\.md` line only if research ran in Step 8/);
    assert.match(body.slice(0, spawn), /never a SUMMARY\.md left from earlier runs/);
  });
});

describe('gsd-research-synthesizer reads only the files it is given (#5148)', () => {
  for (const name of ['gsd-research-synthesizer.md', 'gsd-research-synthesizer.compact.md']) {
    test(`${name} does not require all four research files`, () => {
      const agent = readFileNormalized(path.join(__dirname, '..', 'agents', name));
      assert.doesNotMatch(agent, /all 4 research files/i);
      assert.match(agent, /^- Read the research files listed in `<required_reading>`/m);
      assert.match(agent, /^- \[ \] Every research file listed in `<required_reading>` read$/m);
      assert.doesNotMatch(agent, /cat \.planning\/research\/(STACK|FEATURES|ARCHITECTURE|PITFALLS)\.md/,
        'Step 1 must not read a fixed set of four files');
      const complete = agent.slice(agent.indexOf('**Files synthesized:**'), agent.indexOf('**Output:**'));
      assert.doesNotMatch(complete, /STACK\.md|FEATURES\.md|ARCHITECTURE\.md|PITFALLS\.md/,
        'SYNTHESIS COMPLETE must list the files actually read, not a fixed four');
      assert.match(agent, /\/gsd:new-milestone/, 'spawned-by must name new-milestone');
    });
  }
});

describe('/gsd-new-milestone command describes the same research scope (#5148)', () => {
  test('command file no longer limits research to new features', () => {
    const command = readFileNormalized(path.join(__dirname, '..', 'commands', 'gsd', 'new-milestone.md'));
    assert.doesNotMatch(command, /NEW features only/);
    assert.match(command, /`\.planning\/research\/` — domain research \(optional; the milestone's features and refactors, and what they couple to in the existing codebase\)/);
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

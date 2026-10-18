/**
 * GSD Tools Tests - New Milestone Research Decision (#5148)
 *
 * Structural tests verifying Step 8 of new-milestone.md:
 *  1. research scope covers the existing codebase, not only new features,
 *  2. `(Recommended)` is bound to `research_enabled`,
 *  3. a researcher subset requires user-visible disclosure and the
 *     synthesizer's required_reading lists only files written in this run,
 *  4. Step 9 reads FEATURES.md only when the features dimension ran.
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
    assert.ok(body.indexOf('Skipping:') < body.indexOf('Spawning {N} researchers'), 'disclosure must precede the spawn banner');
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
    assert.doesNotMatch(reading, /^- \{research_dir\}\/PITFALLS\.md$/m, 'PITFALLS.md must not be unconditional');
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

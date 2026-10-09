// allow-test-rule: source-text-is-the-product
// Workflow .md files — their text IS what the runtime loads. Testing text
// content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - New Milestone Research Decision (#5148)
 *
 * Structural tests verifying Step 8 of new-milestone.md:
 *  1. research scope covers the existing codebase, not only new features,
 *  2. `(Recommended)` is bound to `research_enabled`,
 *  3. a researcher subset requires user-visible disclosure and the
 *     synthesizer's required_reading lists only files that exist.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const NEW_MILESTONE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
const workflow = readFileNormalized(NEW_MILESTONE_PATH);

/** Step 8 body: from its heading up to the next `## ` heading. */
function step8() {
  const start = workflow.indexOf('## 8. Research Decision');
  assert.notEqual(start, -1, 'Step 8 "Research Decision" heading is missing');
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n## \d+\./);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('new-milestone Step 8 research decision (#5148)', () => {
  const body = step8();

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
    const [enabled, disabled] = body.split('**If `research_enabled` is `false`:**');
    const marked = (text) => (text.match(/^- "[^\n]*\(Recommended\)[^\n]*/gm) || []);
    const enabledMarks = marked(enabled);
    assert.equal(enabledMarks.length, 1, 'exactly one option carries (Recommended) when research_enabled is true');
    assert.ok(enabledMarks[0].startsWith('- "Research first (Recommended)"'));
    assert.deepEqual(marked(disabled), [], 'no option may carry (Recommended) when research_enabled is false');
    assert.match(body, /`\(Recommended\)` is bound to `research_enabled`/);
  });

  test('a researcher subset must be disclosed to the user before spawning', () => {
    assert.match(body, /Drop one only when its dimension clearly does not apply/);
    assert.match(body, /tell the user before spawning/);
    assert.match(body, /Skipping: \{dimension\(s\)\}/);
    assert.match(body, /Never drop one silently/);
    assert.doesNotMatch(body, /Spawning 4 researchers/, 'researcher count must not be hardcoded');
  });

  test('synthesizer required_reading lists only files that exist', () => {
    const synth = body.slice(body.indexOf('Synthesize research outputs into SUMMARY.md.'));
    const reading = synth.slice(synth.indexOf('<required_reading>'), synth.indexOf('</required_reading>'));
    assert.match(reading, /only the files that exist/i);
    assert.doesNotMatch(reading, /^- \{research_dir\}\/PITFALLS\.md$/m, 'PITFALLS.md must not be unconditional');
  });
});

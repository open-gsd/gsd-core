// allow-test-rule: source-text-is-the-product
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SYNTHESIZER_PATH = path.join(REPO_ROOT, 'agents', 'gsd-research-synthesizer.md');

function readSynthesizerPrompt() {
  return fs.readFileSync(SYNTHESIZER_PATH, 'utf8');
}

describe('bug #222: research synthesizer must write SUMMARY.md via Write tool', () => {
  test('step 6 has explicit hard-rule block forbidding return-message content fallback', () => {
    const prompt = readSynthesizerPrompt();

    assert.match(
      prompt,
      /canonical output of this agent[\s\S]*existing on disk after you return/i,
      'Step 6 must define SUMMARY.md-on-disk as canonical output.'
    );
    assert.match(
      prompt,
      /Hard rules \(must follow\):/i,
      'Step 6 must contain explicit hard rules block.'
    );
    assert.match(
      prompt,
      /Use the `Write` tool[\s\S]*there are no restrictions/i,
      'Rule 1 must force Write tool usage and reject hallucinated restrictions.'
    );
    assert.match(
      prompt,
      /Do NOT return the SUMMARY\.md content in your response/i,
      'Rule 2 must forbid returning SUMMARY content in the response body.'
    );
    assert.match(
      prompt,
      /Do NOT ask permission to write/i,
      'Rule 3 must forbid write-permission asks for this agent.'
    );
    assert.match(
      prompt,
      /Do NOT use `Bash\(cat << 'EOF'\)` or heredoc/i,
      'Rule 4 must forbid heredoc/Bash file creation fallback.'
    );
    assert.match(
      prompt,
      /If the Write tool errors[\s\S]*Do not silently fall back to returning content/i,
      'Rule 5 must force explicit error reporting for Write failures.'
    );
  });
});

describe('bug #222 recurrence: orchestrator self-heals when synthesizer returns SUMMARY.md inline', () => {
  const WORKFLOWS = [
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'new-project.md'),
    path.join(REPO_ROOT, 'gsd-core', 'workflows', 'new-milestone.md'),
  ];

  for (const wf of WORKFLOWS) {
    const name = path.basename(wf);

    test(`${name} has the #222 synthesizer SUMMARY.md self-heal guard`, () => {
      const text = fs.readFileSync(wf, 'utf8');

      // Marker tying the guard to the issue
      assert.match(text, /#222[^\n]*self-heal|self-heal[^\n]*#222/i,
        `${name} must contain a #222-tagged self-heal guard after the synthesizer returns.`);

      // Verifies the file exists AND is substantive/non-empty
      assert.match(text, /SUMMARY\.md[\s\S]{0,120}?(non-empty|substantive|exists)/i,
        `${name} must verify .planning/research/SUMMARY.md exists AND is substantive — non-empty.`);

      // Truncation/validator guard: references the continuation sentinel OR the verify-summary CLI
      assert.match(text, /gsd:write-continue|verify-summary/i,
        `${name} must guard against truncated/invalid SUMMARY.md (sentinel or verify-summary).`);

      // Self-heal must commit ALL research artifacts, not just SUMMARY.md
      assert.match(text, /--files \.planning\/research\//,
        `${name} self-heal must commit ALL research artifacts, not just SUMMARY.md.`);

      // Persists inline-returned document via Write rather than trusting the agent
      assert.match(text, /returned[\s\S]{0,200}?document[\s\S]{0,200}?Write tool/i,
        `${name} must instruct the orchestrator to persist inline-returned document with the Write tool.`);

      // Must not proceed to roadmapper against a missing or incomplete SUMMARY.md
      assert.match(text, /gsd-roadmapper[\s\S]{0,200}?(missing|incomplete|do NOT)/i,
        `${name} must block spawning gsd-roadmapper when SUMMARY.md is missing or incomplete.`);

      // Must name the FULL SUMMARY template markers so the orchestrator persists the real
      // document, not the brief structured return (resolves the HIGH finding).
      assert.match(text, /# Project Research Summary[\s\S]{0,260}?## Sources/,
        `${name}: self-heal must name the full SUMMARY.md template markers (# Project Research Summary … ## Sources).`);
      // Must reference the brief confirmation marker it must NOT mistake for file content.
      assert.match(text, /## SYNTHESIS COMPLETE/,
        `${name}: self-heal must distinguish the brief ## SYNTHESIS COMPLETE confirmation from the real document.`);
    });

    test(`${name} runs the #222 self-heal AFTER the synthesizer and BEFORE gsd-roadmapper`, () => {
      const text = fs.readFileSync(wf, 'utf8');
      const synthIdx = text.indexOf('subagent_type="gsd-research-synthesizer"');
      const healIdx = text.indexOf('Synthesizer output self-heal (#222)');
      const roadIdx = text.indexOf('subagent_type="gsd-roadmapper"');
      assert.ok(synthIdx >= 0, `${name}: synthesizer dispatch not found`);
      assert.ok(healIdx >= 0, `${name}: #222 self-heal block not found`);
      assert.ok(roadIdx >= 0, `${name}: gsd-roadmapper dispatch not found`);
      assert.ok(healIdx > synthIdx, `${name}: self-heal must come AFTER the synthesizer dispatch`);
      assert.ok(roadIdx > healIdx, `${name}: self-heal must come BEFORE the gsd-roadmapper dispatch`);
    });
  }
});

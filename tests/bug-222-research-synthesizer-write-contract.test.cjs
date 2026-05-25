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

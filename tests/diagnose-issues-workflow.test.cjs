// gsd-core/workflows/diagnose-issues.md is shipped prompt content: the text IS
// what the runtime loads, so the debugger-prompt contract can only be asserted
// against the text (#5203).

'use strict';

/**
 * #5203: `diagnose-issues.md` told the orchestrator to "fill the
 * debug-subagent-prompt template", a file #4540 deleted. With no body to fill,
 * the orchestrator improvised the `gsd-debugger` prompt and could omit
 * `symptoms_prefilled: true` and the debug-session file target.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const TEMPLATES_DIR = path.join(ROOT, 'gsd-core', 'templates');
const workflow = fs.readFileSync(path.join(WORKFLOWS_DIR, 'diagnose-issues.md'), 'utf-8');

/** The spawn_agents step's inline prompt: the <objective> after "fill this prompt" to the end of its <debug_file>. */
function inlinePrompt(text) {
  const anchor = text.indexOf('fill this prompt');
  const start = anchor === -1 ? -1 : text.indexOf('<objective>', anchor);
  const closeTag = '</debug_file>';
  const end = text.indexOf(closeTag, start);
  return start === -1 || end === -1 ? '' : text.slice(start, end + closeTag.length);
}

describe('diagnose-issues.md debugger prompt (#5203)', () => {
  test('does not reference the removed debug-subagent-prompt template', () => {
    assert.ok(!/debug-subagent-prompt/.test(workflow), 'the removed template is still named');
  });

  test('the inline debugger prompt carries the pre-filled-symptoms mode and the debug file target', () => {
    const prompt = inlinePrompt(workflow);
    assert.notEqual(prompt, '', 'no inline <objective> prompt block found in the workflow');
    assert.match(prompt, /symptoms_prefilled: true/);
    assert.match(prompt, /goal: find_root_cause_only/);
    assert.match(prompt, /<debug_file>\s*Create: \.planning\/debug\/\{slug\}\.md\s*<\/debug_file>/);
  });

  test('the inline prompt uses every documented placeholder', () => {
    const prompt = inlinePrompt(workflow);
    for (const placeholder of ['truth', 'expected', 'actual', 'errors', 'reproduction', 'timeline', 'slug']) {
      assert.ok(prompt.includes(`{${placeholder}}`), `inline prompt lacks {${placeholder}}`);
    }
  });

  test('the debug session file is named {slug}.md everywhere the workflow mentions it', () => {
    assert.ok(!/DEBUG-\{slug\}/.test(workflow), 'a DEBUG-{slug}.md name contradicts the real .planning/debug/{slug}.md target');
  });

  test('the Agent() call passes the inline prompt under one consistent variable name', () => {
    assert.ok(workflow.includes('prompt=filled_debug_prompt + '), 'Agent() does not pass filled_debug_prompt');
    assert.ok(!workflow.includes('filled_debug_subagent_prompt'), 'the old variable name is still used');
  });
});

describe('workflow template references (#5203)', () => {
  test('every template a shipped workflow tells the model to fill resolves under gsd-core/templates/', () => {
    const dangling = [];
    for (const rel of fs.readdirSync(WORKFLOWS_DIR, { recursive: true })) {
      if (!String(rel).endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(WORKFLOWS_DIR, String(rel)), 'utf-8');
      for (const m of text.matchAll(/fill (?:the |this |that )?([a-z0-9_-]+) template/gi)) {
        if (!fs.existsSync(path.join(TEMPLATES_DIR, `${m[1]}.md`))) {
          dangling.push(`${String(rel).split(path.sep).join('/')}: "${m[0]}" -> templates/${m[1]}.md`);
        }
      }
    }
    assert.deepEqual(dangling, []);
  });
});

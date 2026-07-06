// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard for #2012: AskUserQuestion is Claude Code-only — non-Claude
 * runtimes (OpenAI Codex, Gemini, etc.) render it as a markdown code block
 * instead of triggering the interactive TUI, so the session stalls.
 *
 * Every workflow that calls AskUserQuestion MUST include a TEXT_MODE fallback
 * instruction so that, when `workflow.text_mode` is true (or `--text` is
 * passed), all AskUserQuestion calls are replaced with plain-text numbered
 * lists that any runtime can handle.
 *
 * The canonical fallback phrase is:
 *   "TEXT_MODE" (or "text_mode") paired with "plain-text" (or "plain text")
 * near the first AskUserQuestion reference in the file.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');

/**
 * Return true if the file content contains a TEXT_MODE / text_mode fallback
 * instruction for AskUserQuestion calls.
 *
 * Acceptable forms (case-insensitive on key terms):
 *   - "TEXT_MODE" + "plain-text" or "plain text"
 *   - "text_mode" + "plain-text" or "plain text"
 *   - "text mode" + "plain-text" or "plain text"
 */
function hasTextModeFallback(content) {
  const lower = content.toLowerCase();
  const hasTextMode =
    lower.includes('text_mode') ||
    lower.includes('text mode');
  const hasPlainText =
    lower.includes('plain-text') ||
    lower.includes('plain text') ||
    lower.includes('numbered list');
  return hasTextMode && hasPlainText;
}

describe('AskUserQuestion text-mode fallback (#2012)', () => {
  test('every workflow that uses AskUserQuestion includes a TEXT_MODE plain-text fallback', () => {
    const violations = [];

    const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));

    for (const fname of files) {
      const fpath = path.join(WORKFLOWS_DIR, fname);
      const content = fs.readFileSync(fpath, 'utf-8');

      if (!content.includes('AskUserQuestion')) continue;

      if (!hasTextModeFallback(content)) {
        violations.push(fname);
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      [
        'AskUserQuestion is Claude Code-only (issue #2012).',
        'Every workflow that uses AskUserQuestion must include a TEXT_MODE fallback',
        'so non-Claude runtimes (OpenAI Codex, Gemini, etc.) can present questions',
        'as plain-text numbered lists instead of stalling on an unexecuted tool call.',
        '',
        'Add this near the argument-parsing section of each workflow:',
        '  Set TEXT_MODE=true if --text is present in $ARGUMENTS OR text_mode from',
        '  init JSON is true. When TEXT_MODE is active, replace every AskUserQuestion',
        '  call with a plain-text numbered list and ask the user to type their choice',
        '  number.',
        '',
        'Workflows missing the fallback:',
        ...violations.map(v => '  gsd-core/workflows/' + v),
      ].join('\n')
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-17-askuserquestion-option-cap.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-17-askuserquestion-option-cap (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #17)
// Workflow markdown is the shipped runtime contract; validating its AskUserQuestion
// option limits is a behavioral guard, not an implementation-detail assertion.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'gsd-core', 'workflows');
const ASK_USER_QUESTION_OPTION_CAP = 4;

function walkMarkdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

function findBalancedClose(text, openIndex, openCh, closeCh) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function getLineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function collectOptionCapViolations(file, text) {
  const violations = [];
  const askRe = /\bAskUserQuestion\s*\(\s*\[/g;
  let askMatch;

  while ((askMatch = askRe.exec(text)) !== null) {
    const askStart = askMatch.index;
    const arrayOpen = text.indexOf('[', askStart);
    if (arrayOpen === -1) continue;
    const arrayClose = findBalancedClose(text, arrayOpen, '[', ']');
    if (arrayClose === -1) continue;
    const askBlock = text.slice(arrayOpen, arrayClose + 1);
    const blockOffset = arrayOpen;

    const optionsRe = /\boptions\s*:\s*\[/g;
    let optionsMatch;
    while ((optionsMatch = optionsRe.exec(askBlock)) !== null) {
      const openInBlock = optionsMatch.index + optionsMatch[0].length - 1;
      const closeInBlock = findBalancedClose(askBlock, openInBlock, '[', ']');
      if (closeInBlock === -1) continue;
      const optionsBody = askBlock.slice(openInBlock, closeInBlock + 1);
      const labelCount = (optionsBody.match(/\blabel\s*:\s*"[^"]+"/g) || []).length;
      if (labelCount > ASK_USER_QUESTION_OPTION_CAP) {
        const globalIdx = blockOffset + optionsMatch.index;
        violations.push({
          file,
          line: getLineNumber(text, globalIdx),
          count: labelCount,
        });
      }
    }
  }

  return violations;
}

describe('bug #17: AskUserQuestion options arrays respect runtime cap', () => {
  test('every AskUserQuestion options array in workflows has at most 4 options', () => {
    const files = walkMarkdownFiles(ROOT);
    const violations = [];

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      violations.push(...collectOptionCapViolations(file, text));
    }

    assert.equal(
      violations.length,
      0,
      [
        `Found ${violations.length} AskUserQuestion options-array cap violation(s).`,
        `Runtime cap is ${ASK_USER_QUESTION_OPTION_CAP} options per question.`,
        ...violations.map((v) => {
          const rel = path.relative(path.join(__dirname, '..'), v.file);
          return `  ${rel}:${v.line} -> ${v.count} options`;
        }),
      ].join('\n')
    );
  });
});
  });
}

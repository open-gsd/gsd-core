/**
 * Regression guard — Bug #21
 *
 * Both STATE.md template files must include a YAML frontmatter block in their
 * "File Template" section so that an AI agent creating .planning/STATE.md from
 * the template produces a file that frontmatter consumers can read immediately
 * (before the first `state.*` mutation calls syncStateFrontmatter).
 *
 * Prior to the fix, the template's File Template section began with
 * `# Project State` (no frontmatter), leaving the init→first-write window
 * without `gsd_state_version`, `status`, or `progress` keys.
 *
 * Acceptance criteria:
 * 1. The template body extracted from each state.md file's File Template code
 *    block must begin with `---`.
 * 2. The frontmatter must contain at minimum: `gsd_state_version` and `status`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const TEMPLATE_PATHS = [
  path.join(REPO_ROOT, 'get-shit-done', 'templates', 'state.md'),
  path.join(REPO_ROOT, 'sdk', 'prompts', 'templates', 'state.md'),
];

/**
 * Extract the content of the first ```markdown ... ``` code block from a
 * template file. Returns the raw string (including any leading/trailing
 * whitespace within the block).
 *
 * @param {string} fileContent - Full text of the template file.
 * @returns {string} The extracted code block body.
 */
function extractFileTemplate(fileContent) {
  const match = fileContent.match(/```markdown\r?\n([\s\S]*?)```/);
  assert.ok(match, 'No ```markdown code block found in template file');
  return match[1];
}

/**
 * Minimal YAML frontmatter parser: returns the set of top-level keys present
 * in the first --- ... --- block at the start of `text`. Does not parse nested
 * keys. Returns an empty Set when the text has no frontmatter.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function parseFrontmatterKeys(text) {
  const keys = new Set();
  if (!text.trimStart().startsWith('---')) return keys;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '---') { inBlock = true; continue; }
      break; // frontmatter must be at the very start
    }
    if (trimmed === '---') break; // end of block
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      keys.add(trimmed.slice(0, colonIdx).trim());
    }
  }
  return keys;
}

describe('bug #21 — STATE.md template must carry YAML frontmatter', () => {
  for (const templatePath of TEMPLATE_PATHS) {
    const label = path.relative(REPO_ROOT, templatePath);

    test(`${label} — File Template block starts with frontmatter`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);

      // The template body must open with a YAML frontmatter delimiter.
      assert.ok(
        body.trimStart().startsWith('---'),
        `${label}: File Template must start with '---' (YAML frontmatter), ` +
        `but starts with: ${JSON.stringify(body.slice(0, 60))}`,
      );
    });

    test(`${label} — frontmatter contains gsd_state_version`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('gsd_state_version'),
        `${label}: frontmatter must include 'gsd_state_version', found keys: ${[...keys].join(', ')}`,
      );
    });

    test(`${label} — frontmatter contains status`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('status'),
        `${label}: frontmatter must include 'status', found keys: ${[...keys].join(', ')}`,
      );
    });
  }
});

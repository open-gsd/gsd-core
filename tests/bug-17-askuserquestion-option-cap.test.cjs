'use strict';

// allow-test-rule: source-text-is-the-product
// Workflow markdown is the shipped runtime contract; validating its AskUserQuestion
// option limits is a behavioral guard, not an implementation-detail assertion.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'get-shit-done', 'workflows');
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

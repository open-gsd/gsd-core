/**
 * Tests for issue #2912 — /gsd-progress can use stale CLAUDE.md project block
 * instead of GSD tracking files as authoritative source.
 *
 * Fix: the `report` step in gsd-core/workflows/progress.md must contain
 * an explicit "context authority" directive establishing PROJECT.md, STATE.md,
 * and ROADMAP.md as the authoritative sources for the progress report, and
 * forbidding the use of CLAUDE.md `## Project` blocks as a source for any
 * report field.
 *
 * These tests parse the workflow markdown structurally (locate the
 * <step name="report"> ... </step> block, then locate the blockquote-style
 * directive inside it). They do NOT use `.includes()` over the whole file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'progress.md'
);

/** Extract the body of a <step name="..."> ... </step> block by parsing tags. */
function extractStep(workflow, stepName) {
  const openTag = `<step name="${stepName}">`;
  const start = workflow.indexOf(openTag);
  if (start === -1) return null;
  const bodyStart = start + openTag.length;
  // Find the matching </step> — workflow steps in this file do not nest.
  const end = workflow.indexOf('</step>', bodyStart);
  if (end === -1) return null;
  return workflow.slice(bodyStart, end);
}

/**
 * Extract contiguous markdown blockquote blocks from a chunk of markdown.
 * A blockquote is a run of consecutive lines starting with '>' (after any
 * leading whitespace). Returns the joined text of each blockquote with the
 * leading '>' markers stripped.
 */
function extractBlockquotes(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*>\s?(.*)$/);
    if (m) {
      if (current === null) current = [];
      current.push(m[1]);
    } else {
      if (current !== null) {
        blocks.push(current.join('\n'));
        current = null;
      }
    }
  }
  if (current !== null) blocks.push(current.join('\n'));
  return blocks;
}

describe('#2912: progress report step has explicit context-authority directive', () => {
  test('progress.md workflow file exists and is readable', () => {
    const stat = fs.statSync(WORKFLOW_PATH);
    assert.ok(stat.isFile(), 'workflow file should exist');
  });

  test('progress.md has a <step name="report"> section', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'workflow should contain a report step');
    assert.ok(reportStep.length > 0, 'report step body should not be empty');
  });

  test('report step contains a blockquote directive about context authority', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must be present');

    const blockquotes = extractBlockquotes(reportStep);
    assert.ok(
      blockquotes.length > 0,
      'report step should contain at least one blockquote (the context-authority directive)'
    );

    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(
      authorityBlock,
      'report step should contain a blockquote whose text includes "Context authority"'
    );
  });

  test('context-authority directive names PROJECT.md, STATE.md, and ROADMAP.md as authoritative', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must exist');
    const blockquotes = extractBlockquotes(reportStep);
    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(authorityBlock, 'authority blockquote must exist');

    assert.match(
      authorityBlock,
      /PROJECT\.md/,
      'directive should name PROJECT.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /STATE\.md/,
      'directive should name STATE.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /ROADMAP\.md/,
      'directive should name ROADMAP.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /authoritative/i,
      'directive should describe these files as authoritative'
    );
  });

  test('context-authority directive forbids using CLAUDE.md project block as a source', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must exist');
    const blockquotes = extractBlockquotes(reportStep);
    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(authorityBlock, 'authority blockquote must exist');

    assert.match(
      authorityBlock,
      /CLAUDE\.md/,
      'directive should explicitly mention CLAUDE.md'
    );
    // Must explicitly forbid CLAUDE.md as a source — look for a NOT/do not directive
    // co-located with the CLAUDE.md mention.
    assert.match(
      authorityBlock,
      /(do\s+NOT|do\s+not|must\s+NOT|must\s+not|never)/i,
      'directive should contain an explicit prohibition (do NOT / must not / never)'
    );
    assert.match(
      authorityBlock,
      /## Project/,
      'directive should call out the CLAUDE.md "## Project" block specifically'
    );
  });
});

'use strict';

/**
 * Registry submission docs parity — registry-docs-approved-issue-parity.test.cjs
 *
 * #5299: the registry submission process must say an approved issue comes
 * first, and the docs that state it must agree. The truth for the accepted
 * labels is APPROVAL_LABELS in the auto-close workflow, read here as data.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = '.github/workflows/auto-close-unsolicited-prs.yml';
const README = 'docs/registries/README.md';
const ENTRY = '.github/PULL_REQUEST_TEMPLATE/registry-entry.md';
const DOCS = [
  README,
  ENTRY,
  'docs/how-to/list-your-reviewer-lane.md',
  'docs/how-to/take-over-a-capability-or-eos.md',
];

function parseApprovalLabels(yamlText) {
  const m = /APPROVAL_LABELS:\s*'([^']+)'/.exec(yamlText);
  if (!m) throw new Error('APPROVAL_LABELS not found in the workflow text');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// files: { repo-relative path: text }. Returns failure strings; [] = parity.
function checkApprovedIssueParity(files, labels) {
  const out = [];
  for (const p of DOCS) {
    const text = files[p];
    if (typeof text !== 'string' || text === '') {
      out.push(`${p}: file missing or empty`);
      continue;
    }
    if (!/approved[ -]issue/i.test(text)) out.push(`${p}: no approved-issue-first requirement`);
  }
  for (const p of [README, ENTRY]) {
    const text = files[p];
    if (typeof text !== 'string') continue;
    for (const l of labels) {
      if (!text.includes(l)) out.push(`${p}: label ${l} not named`);
    }
    const stray = (text.match(/\bapproved-[a-z]+\b/gi) || []).filter(
      (t) => t.toLowerCase() !== 'approved-issue' && !labels.includes(t),
    );
    for (const t of new Set(stray)) out.push(`${p}: label ${t} is outside APPROVAL_LABELS`);
  }
  const readme = files[README];
  if (typeof readme === 'string') {
    for (const needle of ['Closes #<issue#>', 'docs(#<issue#>): summary']) {
      if (!readme.includes(needle)) out.push(`${README}: step 6 no longer says ${needle}`);
    }
  }
  return out;
}

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, 'utf8');
}

const readDocs = () => Object.fromEntries(DOCS.map((p) => [p, readRepoFile(p)]));

describe('registry submission docs: approved issue first (#5299)', () => {
  const labels = parseApprovalLabels(readRepoFile(WORKFLOW));

  test('the workflow yields the three accepted labels', () => {
    assert.deepEqual(labels, ['approved-feature', 'approved-enhancement', 'confirmed-bug']);
  });

  test('the four docs agree on the gate, the label set, Closes and the title shape', () => {
    const files = readDocs();
    assert.deepEqual(checkApprovedIssueParity(files, labels), []);
  });

  test('negative control: a README without the gate is reported', () => {
    const files = readDocs();
    files[README] = 'There is no separate account, package publish, or approval queue.';
    const failures = checkApprovedIssueParity(files, labels);
    assert.ok(failures.includes(`${README}: no approved-issue-first requirement`));
  });
});

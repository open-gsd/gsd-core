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
const LANE = 'docs/how-to/list-your-reviewer-lane.md';
const DOCS = [
  README,
  ENTRY,
  LANE,
  'docs/how-to/take-over-a-capability-or-eos.md',
];
// The PR step of each doc that walks the process; the gate must come before it.
// ENTRY has none: the template is the PR itself.
const PR_STEP = {
  [README]: '6. **Open a PR**',
  [LANE]: '## Open the PR',
  'docs/how-to/take-over-a-capability-or-eos.md': 'open one PR',
};

function parseApprovalLabels(yamlText) {
  const m = /APPROVAL_LABELS:\s*'([^']+)'/.exec(yamlText);
  if (!m) throw new Error('APPROVAL_LABELS not found in the workflow text');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const changesetTypes = (line) => [...new Set(line.match(/`(?:Added|Changed|Deprecated|Removed)`/g))].sort().join();

// files: { repo-relative path: text }. Returns failure strings; [] = parity.
function checkApprovedIssueParity(files, labels) {
  const out = [];
  for (const p of DOCS) {
    const text = files[p];
    if (typeof text !== 'string' || text === '') {
      out.push(`${p}: file missing or empty`);
      continue;
    }
    const gate = text.search(/approved[ -]issue/i);
    if (gate === -1) out.push(`${p}: no approved-issue-first requirement`);
    else if (p in PR_STEP && !(gate < text.indexOf(PR_STEP[p]))) out.push(`${p}: approved issue not required before the PR step`);
  }
  for (const p of [README, ENTRY]) {
    const text = files[p];
    if (typeof text !== 'string') continue;
    for (const l of labels) {
      if (!text.includes(l)) out.push(`${p}: label ${l} not named`);
    }
    const stray = (text.match(/\bapproved-[a-z]+\b/gi) || []).filter((t) => {
      const k = t.toLowerCase();
      return k !== 'approved-issue' && !labels.includes(k);
    });
    for (const t of new Set(stray)) out.push(`${p}: label ${t} is outside APPROVAL_LABELS`);
  }
  const readme = files[README];
  if (typeof readme === 'string') {
    const step6 = (readme.match(/^6\. .*$/m) || [''])[0];
    for (const needle of ['Closes #<issue#>', 'docs(#<issue#>): summary']) {
      if (!step6.includes(needle)) out.push(`${README}: step 6 no longer says ${needle}`);
    }
    const item = (files[ENTRY] || '').split('\n').find((l) => l.includes('`.changeset/` fragment')) || '';
    if (changesetTypes(item) !== changesetTypes(step6)) out.push(`${ENTRY}: changeset item types differ from ${README} step 6`);
  }
  return out;
}

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, 'utf8');
}

const readDocs = () => Object.fromEntries(DOCS.map((p) => [p, readRepoFile(p)]));
const readLabels = () => parseApprovalLabels(readRepoFile(WORKFLOW) ?? '');

describe('registry submission docs: approved issue first (#5299)', () => {
  test('the workflow yields the three accepted labels', () => {
    assert.deepEqual(readLabels(), ['approved-feature', 'approved-enhancement', 'confirmed-bug']);
  });

  test('the docs state the gate before their PR step; README and template name the labels; README step 6 and the template agree on Closes, the title and the changeset types', () => {
    assert.deepEqual(checkApprovedIssueParity(readDocs(), readLabels()), []);
  });

  test('negative control: a README without the gate is reported', () => {
    const files = readDocs();
    files[README] = 'There is no separate account, package publish, or approval queue.';
    const failures = checkApprovedIssueParity(files, readLabels());
    assert.ok(failures.includes(`${README}: no approved-issue-first requirement`));
  });

  test('negative control: a missing doc is reported', () => {
    const files = readDocs();
    delete files[ENTRY];
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: file missing or empty`));
  });

  test('negative control: a how-to that names the approved issue only after its PR step is reported', () => {
    const files = readDocs();
    files[LANE] = '## Open the PR\n\nLink your approved issue.';
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${LANE}: approved issue not required before the PR step`));
  });

  test('negative control: a template missing an accepted label is reported', () => {
    const files = readDocs();
    files[ENTRY] = files[ENTRY].replaceAll('confirmed-bug', 'confirmed');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: label confirmed-bug not named`));
  });

  test('negative control: a stray approved-* label is reported, in any case', () => {
    const files = readDocs();
    files[README] += '\nAlso `Approved-Foo`.\n';
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: label Approved-Foo is outside APPROVAL_LABELS`));
  });

  test('an accepted label in another case is not reported as stray', () => {
    const files = readDocs();
    files[README] += '\nAlso `Approved-Feature`.\n';
    assert.ok(!checkApprovedIssueParity(files, readLabels()).some((f) => f.includes('outside APPROVAL_LABELS')));
  });

  test('negative control: Closes outside README step 6 is reported', () => {
    const files = readDocs();
    files[README] = `${files[README].replace('Closes #<issue#>', 'Refs #<issue#>')}\nCloses #<issue#>\n`;
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: step 6 no longer says Closes #<issue#>`));
  });

  test('negative control: a template changeset item without Changed is reported', () => {
    const files = readDocs();
    files[ENTRY] = files[ENTRY].replace(/^- \[ \] `\.changeset\/` fragment.*$/m, '- [ ] `.changeset/` fragment added with an `Added` type');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: changeset item types differ from ${README} step 6`));
  });
});

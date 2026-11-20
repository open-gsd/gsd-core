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
const fc = require('./helpers/fast-check-setup.cjs');

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
// README steps and template items are found by their text, not their number,
// so a renumbered list keeps its meaning.
const ISSUE_STEP = '**Open an issue for the change**';
const PR_STEP_TITLE = '**Open a PR**';
const LABEL_ITEM = 'Linked issue has the';
const CHANGESET_ITEM = '`.changeset/` fragment';
// The gate wording. The space form only, so no `approved-*` token reads as a label.
const GATE = /approved issue/i;
const { ALLOWED_TYPES } = require('../scripts/changeset/parse.cjs');
// The types a registry PR may use: a new entry, an update, a removal (take-over mode T4).
const CHANGESET_TYPES = '`Added`,`Changed`,`Removed`';
// The PR step of each how-to that walks the process; the gate must come before it.
// README and ENTRY have none here: checkReadmeSteps reads the README, and the template is the PR itself.
const PR_STEP = {
  [LANE]: '## Open the PR',
  'docs/how-to/take-over-a-capability-or-eos.md': 'open one PR',
};

function parseApprovalLabels(yamlText) {
  const m = /APPROVAL_LABELS:\s*'([^']+)'/.exec(yamlText);
  if (!m) throw new Error('APPROVAL_LABELS not found in the workflow text');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const TYPE_RE = new RegExp(`\`(?:${[...ALLOWED_TYPES].join('|')})\``, 'g');
const changesetTypes = (line) => [...new Set(line.match(TYPE_RE))].sort().join();
const lineWith = (text, needle) => text.split('\n').find((l) => l.includes(needle));
const editLine = (text, needle, fn) => text.split('\n').map((l) => (l.includes(needle) ? fn(l) : l)).join('\n');

// Each check takes files ({ repo-relative path: text }) and returns failure strings; [] = parity.
function checkGate(files) {
  const out = [];
  for (const p of DOCS) {
    const text = files[p];
    if (typeof text !== 'string' || text === '') {
      out.push(`${p}: file missing or empty`);
      continue;
    }
    const gate = text.search(GATE);
    if (gate === -1) {
      out.push(`${p}: no approved-issue-first requirement`);
      continue;
    }
    if (!(p in PR_STEP)) continue;
    const at = text.indexOf(PR_STEP[p]);
    if (at === -1) out.push(`${p}: PR step anchor not found`);
    else if (gate >= at) out.push(`${p}: approved issue not required before the PR step`);
  }
  return out;
}

function checkReadmeSteps(files) {
  const readme = files[README];
  if (typeof readme !== 'string') return [];
  const out = [];
  const issue = lineWith(readme, ISSUE_STEP);
  const pr = lineWith(readme, PR_STEP_TITLE);
  if (issue === undefined) out.push(`${README}: issue step anchor not found`);
  else {
    if (!GATE.test(issue)) out.push(`${README}: issue step no longer requires an approved issue`);
    if (pr !== undefined && readme.indexOf(issue) > readme.indexOf(pr)) out.push(`${README}: issue step comes after the PR step`);
  }
  if (pr === undefined) out.push(`${README}: PR step anchor not found`);
  else {
    for (const needle of ['Closes #<issue#>', 'docs(#<issue#>): summary']) {
      if (!pr.includes(needle)) out.push(`${README}: PR step no longer says ${needle}`);
    }
  }
  return out;
}

function checkLabels(files, labels) {
  const out = [];
  for (const [p, item] of [[README, ISSUE_STEP], [ENTRY, LABEL_ITEM]]) {
    const text = files[p];
    if (typeof text !== 'string') continue;
    const span = lineWith(text, item);
    if (span === undefined) out.push(`${p}: label anchor not found`);
    else {
      for (const l of labels) {
        if (!span.includes(l)) out.push(`${p}: label ${l} not named`);
      }
    }
    const stray = (text.match(/\bapproved-[a-z]+\b/gi) || []).filter((t) => !labels.includes(t.toLowerCase()));
    for (const t of new Set(stray)) out.push(`${p}: label ${t} is outside APPROVAL_LABELS`);
  }
  return out;
}

function checkChangeset(files) {
  const readme = files[README];
  const pr = typeof readme === 'string' ? lineWith(readme, PR_STEP_TITLE) : undefined;
  if (pr === undefined) return []; // checkReadmeSteps reports the missing step
  const out = [];
  if (changesetTypes(pr) !== CHANGESET_TYPES) out.push(`${README}: PR step changeset types are not exactly Added, Changed, Removed`);
  const item = lineWith(files[ENTRY] || '', CHANGESET_ITEM);
  if (item === undefined) out.push(`${ENTRY}: changeset item not found`);
  else if (changesetTypes(item) !== changesetTypes(pr)) out.push(`${ENTRY}: changeset item types differ from ${README} PR step`);
  return out;
}

const checkApprovedIssueParity = (files, labels) => [
  ...checkGate(files),
  ...checkReadmeSteps(files),
  ...checkLabels(files, labels),
  ...checkChangeset(files),
];

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, 'utf8');
}

const readDocs = () => Object.fromEntries(DOCS.map((p) => [p, readRepoFile(p)]));
const readLabels = () => parseApprovalLabels(readRepoFile(WORKFLOW) ?? '');
const sorted = (list) => [...list].sort();

describe('parseApprovalLabels', () => {
  test('property: gives back any list of labels joined with random spaces and empty entries', () => {
    const label = fc.stringMatching(/^[a-z]+(-[a-z]+)*$/);
    const pad = fc.stringMatching(/^ {0,3}$/);
    const entry = fc.tuple(pad, fc.oneof(label, fc.constant('')), pad);
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1 }), (entries) => {
        const value = entries.map((e) => e.join('')).join(',');
        fc.pre(value !== '');
        const expected = entries.map((e) => e[1]).filter(Boolean);
        assert.deepEqual(parseApprovalLabels(`APPROVAL_LABELS: '${value}'`), expected);
      }),
    );
  });

  test('zero, one and many labels', () => {
    assert.deepEqual(parseApprovalLabels("APPROVAL_LABELS: ','"), []);
    assert.deepEqual(parseApprovalLabels("APPROVAL_LABELS: 'a-b'"), ['a-b']);
    assert.deepEqual(parseApprovalLabels("APPROVAL_LABELS: ' a , b-c ,, d '"), ['a', 'b-c', 'd']);
  });

  test('throws when the key is missing or its value is empty', () => {
    assert.throws(() => parseApprovalLabels('OTHER_KEY: x'), /APPROVAL_LABELS not found/);
    assert.throws(() => parseApprovalLabels("APPROVAL_LABELS: ''"), /APPROVAL_LABELS not found/);
  });
});

describe('registry submission docs: approved issue first (#5299)', () => {
  test('the workflow yields the three accepted labels', () => {
    assert.deepEqual(sorted(readLabels()), ['approved-enhancement', 'approved-feature', 'confirmed-bug']);
  });

  test('the how-tos state the approved-issue gate before their PR step', () => {
    assert.deepEqual(checkGate(readDocs()), []);
  });

  test('README names the gate in its issue step, before the PR step, and the PR step says Closes and the title', () => {
    assert.deepEqual(checkReadmeSteps(readDocs()), []);
  });

  test('README issue step and the template name every accepted label and no other', () => {
    assert.deepEqual(checkLabels(readDocs(), readLabels()), []);
  });

  test('README PR step lists exactly the Added, Changed and Removed types and the template agrees', () => {
    assert.deepEqual(checkChangeset(readDocs()), []);
  });

  test('negative control: a PR step that also names Fixed is reported', () => {
    const files = readDocs();
    files[README] = editLine(files[README], PR_STEP_TITLE, (l) => `${l} Or \`Fixed\`.`);
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: PR step changeset types are not exactly Added, Changed, Removed`));
  });

  test('negative control: a README without the gate is reported', () => {
    const files = readDocs();
    files[README] = 'There is no separate account, package publish, or approval queue.';
    const failures = checkApprovedIssueParity(files, readLabels());
    assert.ok(failures.includes(`${README}: no approved-issue-first requirement`));
  });

  test('negative control: an issue step without the gate is reported although a later step names it', () => {
    const files = readDocs();
    files[README] = editLine(files[README], ISSUE_STEP, (l) => l.replaceAll('approved issue', 'issue'));
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: issue step no longer requires an approved issue`));
  });

  test('negative control: an issue step placed after the PR step is reported', () => {
    const files = readDocs();
    const lines = files[README].split('\n');
    const [issue] = lines.splice(lines.findIndex((l) => l.includes(ISSUE_STEP)), 1);
    lines.splice(lines.findIndex((l) => l.includes(PR_STEP_TITLE)) + 1, 0, issue);
    files[README] = lines.join('\n');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: issue step comes after the PR step`));
  });

  test('negative control: a README without the PR step title reports the anchor, not a gate order', () => {
    const files = readDocs();
    files[README] = files[README].replace(PR_STEP_TITLE, 'Open a PR');
    const failures = checkApprovedIssueParity(files, readLabels());
    assert.ok(failures.includes(`${README}: PR step anchor not found`));
    assert.ok(!failures.some((f) => f.includes('comes after')));
  });

  test('a README with a step inserted before the PR step still has parity', () => {
    const files = readDocs();
    const lines = files[README].split('\n');
    lines.splice(lines.findIndex((l) => l.includes(PR_STEP_TITLE)), 0, 'An extra step.');
    assert.notEqual(lines.join('\n'), files[README]);
    files[README] = lines.join('\n');
    assert.deepEqual(checkApprovedIssueParity(files, readLabels()), []);
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

  test('negative control: a how-to without its PR step anchor reports the anchor', () => {
    const files = readDocs();
    files[LANE] = 'Get an approved issue first.';
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${LANE}: PR step anchor not found`));
  });

  test('negative control: a template missing an accepted label is reported', () => {
    const files = readDocs();
    files[ENTRY] = files[ENTRY].replaceAll('confirmed-bug', 'confirmed');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: label confirmed-bug not named`));
  });

  test('negative control: a label named only outside the issue step is reported', () => {
    const files = readDocs();
    files[README] = `${editLine(files[README], ISSUE_STEP, (l) => l.replaceAll('approved-enhancement', 'x'))}\nLater: approved-enhancement.\n`;
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: label approved-enhancement not named`));
  });

  test('negative control: a template without its label item reports the anchor', () => {
    const files = readDocs();
    files[ENTRY] = files[ENTRY].replace(LABEL_ITEM, 'Linked issue is approved by');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: label anchor not found`));
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

  test('negative control: Closes outside the PR step is reported', () => {
    const files = readDocs();
    files[README] = `${files[README].replace('Closes #<issue#>', 'Refs #<issue#>')}\nCloses #<issue#>\n`;
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: PR step no longer says Closes #<issue#>`));
  });

  test('negative control: a template changeset item without Changed is reported', () => {
    const files = readDocs();
    files[ENTRY] = editLine(files[ENTRY], CHANGESET_ITEM, () => '- [ ] `.changeset/` fragment added with an `Added` type');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: changeset item types differ from ${README} PR step`));
  });

  test('negative control: a README and template that both lost their types are reported', () => {
    const files = readDocs();
    const strip = (l) => l.replace(/`(?:Added|Changed|Removed)`/g, 'a type');
    files[README] = editLine(files[README], PR_STEP_TITLE, strip);
    files[ENTRY] = editLine(files[ENTRY], CHANGESET_ITEM, strip);
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${README}: PR step changeset types are not exactly Added, Changed, Removed`));
  });

  test('negative control: a template without its changeset item is reported', () => {
    const files = readDocs();
    files[ENTRY] = files[ENTRY].replace(CHANGESET_ITEM, 'changeset fragment');
    assert.ok(checkApprovedIssueParity(files, readLabels()).includes(`${ENTRY}: changeset item not found`));
  });
});

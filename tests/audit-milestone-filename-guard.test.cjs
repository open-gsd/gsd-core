'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3796 — the audit-milestone report writer and its readers must agree on
// the report's filename.
//
// The single writer line created `.planning/v{version}-v{version}-MILESTONE
// -AUDIT.md` (a doubled version segment) while every downstream reference —
// the step's own heading, the Report pointers, the `cat`, and the completion
// checklist — reads `v{version}-MILESTONE-AUDIT.md`. The report landed at a
// path no reader ever looked at.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectSection, extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { auditMilestoneMd, workflowMd, openWorkStep, codeSpans, openWorkYamlFields, successCriteria } = require('./helpers/audit-milestone-step.cjs');

// audit-milestone.md is shipped workflow text — the bytes ARE what the
// runtime loads; a structural scan over it tests the deployed contract.
test('#3796: the audit report writer and readers agree on the single-version filename', () => {
  const md = auditMilestoneMd();
  assert.ok(
    !md.includes('v{version}-v{version}'),
    '#3796: no doubled version segment may appear anywhere in the workflow',
  );
  const writer = /^Create `\.planning\/v\{version\}-MILESTONE-AUDIT\.md` with:$/m;
  assert.ok(
    writer.test(md),
    '#3796: the writer line must create exactly .planning/v{version}-MILESTONE-AUDIT.md',
  );
  const readers = md.match(/v\{version\}-MILESTONE-AUDIT\.md/g) || [];
  assert.ok(
    readers.length >= 5,
    `the single-version readers (heading, Report pointers, cat, checklist) must remain; found ${readers.length}`,
  );
});

// #5482: the audit lists the same open work milestone close would refuse on,
// before it can report `passed`. The dry-run's would_refuse is that listing.
test('#5482: audit lists open ship:pre gate work (would_refuse) and blocks passed on it', () => {
  const step = openWorkStep();
  assert.ok(step, '#5482: an audit step 5.6 must list open work');
  // The typed tokens the step names: the dry-run command, the JSON field it reads and the reason the CLI refuses with.
  const spans = codeSpans(step);
  for (const token of ['would_refuse', 'gaps_found', 'gaps.open_work', ERROR_REASON.MILESTONE_GATE_BLOCKED]) {
    assert.ok(spans.includes(token), `step 5.6 names \`${token}\``);
  }
  assert.equal(extractFencedBlock(step, 'bash'), 'gsd_run query milestone complete {version} --dry-run');
});

// #5482: the entries step 5.6 reports need a slot in the report: the step-6 YAML, the gaps_found
// output and the success criteria must name the same fields the step does.
test('#5482: open-work entries have a slot in the YAML, the gaps_found output and the success criteria', () => {
  const md = auditMilestoneMd();
  // The report schema is the YAML example's `open_work` item (parsed); the step, the report line and the criteria follow it.
  const fields = openWorkYamlFields();
  assert.deepEqual(fields, ['cap_id', 'phase', 'reason', 'details', 'gate_message']);
  const stepSpans = codeSpans(openWorkStep());
  const section = collectSection(md, (h) => h.text === 'Open Work');
  assert.ok(section, '#5482: the gaps_found output needs an Open Work section');
  const reportLine = extractFencedBlock(section.body, 'text');
  assert.ok(reportLine, '#5482: the Open Work report line sits in a text code fence');
  for (const f of fields) {
    assert.ok(stepSpans.includes(f), `step 5.6 names \`${f}\``);
    // gate_message and details are untrusted command output: the report line shows them inside a code fence.
    assert.ok(reportLine.includes(`{${f}}`), `the report line carries {${f}}`);
  }
  const unfenced = collectSection(md, (h) => h.text === 'Open Work', { stripFences: true });
  for (const f of ['gate_message', 'details']) {
    assert.ok(!unfenced.body.includes(`{${f}}`), `{${f}} must sit inside a code fence in the Open Work section`);
  }
  assert.ok(successCriteria().some((line) => ['ship:pre', 'gaps_found'].every((token) => codeSpans(line).includes(token))), 'a success criterion ties the ship:pre listing to gaps_found');
});

// #5482: a dry-run that evaluated no gate (gate_warnings) must not read as clean, in the audit and in the close preview.
test('#5482: audit step 5.6 and the close preview both name a non-empty gate_warnings', () => {
  assert.ok(codeSpans(openWorkStep()).includes('gate_warnings'));
  const preview = splitLines(workflowMd('complete-milestone.md')).find((l) => codeSpans(l).includes('would_refuse'));
  assert.ok(preview, 'the close preview must read would_refuse');
  assert.ok(codeSpans(preview).includes('gate_warnings'));
});

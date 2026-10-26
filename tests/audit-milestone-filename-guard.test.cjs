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
const fs = require('node:fs');
const path = require('node:path');

const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { auditMilestoneMd, openWorkStep, openWorkStepFields } = require('./helpers/audit-milestone-step.cjs');

const AUDIT_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'audit-milestone.md');

// audit-milestone.md is shipped workflow text — the bytes ARE what the
// runtime loads; a structural scan over it tests the deployed contract.
test('#3796: the audit report writer and readers agree on the single-version filename', () => {
  const md = fs.readFileSync(AUDIT_MD, 'utf-8');
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
  assert.match(step, /milestone complete \{version\} --dry-run/);
  assert.match(step, /would_refuse/);
  assert.match(step, /gaps_found/);
});

// #5482: the entries step 5.6 reports need a slot in the report: the step-6 YAML, the gaps_found
// output and the success criteria must name the same fields the step does.
test('#5482: open-work entries have a slot in the YAML, the gaps_found output and the success criteria', () => {
  const md = auditMilestoneMd();
  const named = openWorkStepFields();
  assert.deepEqual(named, ['cap_id', 'phase', 'gate_message']);
  const yaml = md.match(/^ {2}open_work:[^\n]*\n((?: {4,}[^\n]*\n)+)/m);
  assert.ok(yaml, '#5482: the step-6 YAML gaps: block needs an open_work list');
  const section = collectSection(md, (h) => h.text === 'Open Work');
  assert.ok(section, '#5482: the gaps_found output needs an Open Work section');
  for (const f of named) {
    assert.match(yaml[1], new RegExp(`\\b${f}:`), `YAML open_work names ${f}`);
    assert.ok(section.body.includes(`{${f}}`), `Open Work section names {${f}}`);
  }
  assert.match(md.match(/<success_criteria>[\s\S]*<\/success_criteria>/)[0], /open work/i);
});

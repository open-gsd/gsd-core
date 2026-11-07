'use strict';

// The audit-milestone workflow text and its step 5.6 (Open Work, #5482), shared by the tests that pin it.
const fs = require('node:fs');
const path = require('node:path');
const { collectSection, scanInlineCodeSpans } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

const AUDIT_MD = path.join(__dirname, '..', '..', 'gsd-core', 'workflows', 'audit-milestone.md');

function auditMilestoneMd() {
  return fs.readFileSync(AUDIT_MD, 'utf-8');
}

function openWorkStep() {
  return collectSection(auditMilestoneMd(), (h) => h.text.startsWith('5.6.'))?.body;
}

// The entry field names step 5.6 tells the agent to report.
function openWorkStepFields() {
  const sentence = splitLines(openWorkStep()).find((l) => l.includes('Report each entry ('));
  const list = sentence.slice(sentence.indexOf('Report each entry (') + 'Report each entry ('.length);
  return scanInlineCodeSpans(list.slice(0, list.indexOf(')'))).map((span) => span.content);
}

// The lines between <success_criteria> and </success_criteria> of the workflow.
function successCriteria() {
  const lines = splitLines(auditMilestoneMd());
  const open = lines.indexOf('<success_criteria>');
  const close = lines.indexOf('</success_criteria>');
  if (open < 0 || close < open) throw new Error('audit-milestone.md lacks a <success_criteria> block');
  return lines.slice(open + 1, close);
}

module.exports = { auditMilestoneMd, openWorkStep, openWorkStepFields, successCriteria };

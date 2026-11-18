'use strict';

// The audit-milestone workflow text and its step 5.6 (Open Work, #5482), shared by the tests that pin it.
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { collectSection, scanInlineCodeSpans } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

const WORKFLOWS = path.join(__dirname, '..', '..', 'gsd-core', 'workflows');

function workflowMd(name) {
  return fs.readFileSync(path.join(WORKFLOWS, name), 'utf-8');
}

function auditMilestoneMd() {
  return workflowMd('audit-milestone.md');
}

function openWorkStep() {
  return collectSection(auditMilestoneMd(), (h) => h.text.startsWith('5.6.'))?.body;
}

// The contents of the inline code spans of a text: the typed tokens (field, reason and command names) it names.
function codeSpans(text) {
  return scanInlineCodeSpans(text).map((span) => span.content);
}

// The entry fields of the report schema: the keys of the `open_work` item in the step-6 YAML example, read by a YAML parser.
function openWorkYamlFields() {
  const lines = splitLines(collectSection(auditMilestoneMd(), (h) => h.text.startsWith('6.'))?.body ?? '');
  const slot = lines.findIndex((l) => l.startsWith('  open_work:'));
  if (slot < 0) throw new Error('audit-milestone.md step 6 lacks an open_work list in its YAML example');
  const entry = [];
  for (let i = slot + 1; i < lines.length && lines[i].startsWith('    '); i++) entry.push(lines[i].slice('    '.length));
  return Object.keys(yaml.load(entry.join('\n'))[0]);
}

// The lines between <success_criteria> and </success_criteria> of the workflow.
function successCriteria() {
  const lines = splitLines(auditMilestoneMd());
  const open = lines.indexOf('<success_criteria>');
  const close = lines.indexOf('</success_criteria>');
  if (open < 0 || close < open) throw new Error('audit-milestone.md lacks a <success_criteria> block');
  return lines.slice(open + 1, close);
}

module.exports = { workflowMd, auditMilestoneMd, openWorkStep, codeSpans, openWorkYamlFields, successCriteria };

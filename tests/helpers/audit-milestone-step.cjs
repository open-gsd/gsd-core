'use strict';

// The audit-milestone workflow text and its step 5.6 (Open Work, #5482), shared by the tests that pin it.
const fs = require('node:fs');
const path = require('node:path');
const { collectSection } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

const AUDIT_MD = path.join(__dirname, '..', '..', 'gsd-core', 'workflows', 'audit-milestone.md');

function auditMilestoneMd() {
  return fs.readFileSync(AUDIT_MD, 'utf-8');
}

function openWorkStep() {
  return collectSection(auditMilestoneMd(), (h) => h.text.startsWith('5.6.'))?.body;
}

// The entry field names step 5.6 tells the agent to report.
function openWorkStepFields() {
  return openWorkStep().match(/Report each entry \(([^)]*)\)/)[1].match(/`([a-z_]+)`/g).map((f) => f.slice(1, -1));
}

module.exports = { auditMilestoneMd, openWorkStep, openWorkStepFields };

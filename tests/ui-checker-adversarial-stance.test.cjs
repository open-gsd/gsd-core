'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('gsd-ui-checker has an adversarial_stance with FORCE + BLOCK/FLAG/PASS (#16)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-ui-checker.md'), 'utf8');
  assert.match(src, /<adversarial_stance>/, 'missing <adversarial_stance>');
  assert.match(src, /FORCE stance/, 'missing FORCE stance line');
  assert.match(src, /go soft/i, 'missing go-soft failure list');
  assert.match(src, /BLOCK\b/, 'missing BLOCK tier');
  assert.match(src, /FLAG\b/, 'missing FLAG tier');
});

test('gsd-ui-checker has a third-person named-persona block (#16, 2505.23840)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-ui-checker.md'), 'utf8');
  // Named reviewer referred to in third person
  assert.match(src, /The Auditor/i, 'missing named third-person reviewer "The Auditor"');
  // Third-person verdict phrasing
  assert.match(src, /The Auditor['']s verdict/i, "missing third-person verdict phrasing \"The Auditor's verdict\"");
  // Objective (not hostile) framing per 2506.04975
  assert.match(src, /independent/i, 'missing independent/objective framing');
  assert.match(src, /not\s+a\s+standalone\s+accuracy\s+guarantee/i, 'missing limitation on persona efficacy claim');
});

test('gsd-ui-checker has an anti-capitulation rule (#16)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-ui-checker.md'), 'utf8');
  assert.match(src, /anti.?capitulat/i, 'missing anti-capitulation rule');
  // Disagreement alone is not grounds to downgrade a BLOCK
  assert.match(src, /concrete fix/i, 'missing "concrete fix" requirement for BLOCK downgrade');
  assert.match(src, /Self-correction is allowed/i, 'missing carve-out for evidence-backed self-correction');
  assert.match(src, /prior dimension application was mistaken/i, 'missing mistaken-prior-application carve-out');
});

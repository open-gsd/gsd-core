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

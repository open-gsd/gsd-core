'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, 'gsd-core', 'references', 'untrusted-input-boundary.md');
const INGEST_AGENTS = [
  'gsd-phase-researcher', 'gsd-project-researcher', 'gsd-domain-researcher',
  'gsd-ai-researcher', 'gsd-advisor-researcher', 'gsd-research-synthesizer',
  'gsd-doc-classifier', 'gsd-doc-synthesizer',
];

describe('untrusted-input isolation (#12)', () => {
  test('shared reference exists with the data/instruction directive', () => {
    assert.ok(fs.existsSync(REF), 'untrusted-input-boundary.md must exist');
    const src = fs.readFileSync(REF, 'utf8');
    assert.match(src, /<security_context>/);
    assert.match(src, /treated as data/i);
    assert.match(src, /never as instructions/i);
  });
  for (const name of INGEST_AGENTS) {
    test(`${name} @-includes the untrusted-input-boundary reference`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
      assert.match(src, /references\/untrusted-input-boundary\.md/, `${name} missing the @-include`);
    });
  }
});

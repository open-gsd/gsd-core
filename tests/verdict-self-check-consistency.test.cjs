'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, 'gsd-core', 'references', 'verdict-self-check.md');
const CRITICS = ['gsd-verifier', 'gsd-plan-checker', 'gsd-code-reviewer'];

describe('critic verdict self-check (#5/#25)', () => {
  test('shared reference exists and is verdict-directed', () => {
    assert.ok(fs.existsSync(REF), 'verdict-self-check.md must exist');
    const src = fs.readFileSync(REF, 'utf8');
    assert.match(src, /false PASS/i);
    assert.match(src, /strongest argument/i);
  });
  for (const name of CRITICS) {
    test(`${name} includes verdict-self-check and a self-check step`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
      assert.match(src, /references\/verdict-self-check\.md/, `${name} missing @-include`);
      assert.match(src, /Verdict self-check/i, `${name} missing self-check step`);
    });
  }
});

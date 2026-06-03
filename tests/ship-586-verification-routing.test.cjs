'use strict';
// allow-test-rule: runtime-contract-is-the-product
// The ship.md verification gate is LLM-executed prose; its routing message text
// IS the user-facing product surface (RULESET.TESTS.no-source-grep.exemption:
// "reserved for tests where the file content IS the product surface ... agent .md").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');
const ship = fs.readFileSync(SHIP_MD, 'utf8');

// Narrow to the preflight verification gate so we don't match the PR-body
// template lower in the file that also mentions VERIFICATION.md.
const start = ship.indexOf('**Verification passed?**');
const end = ship.indexOf('**Clean working tree?**');
assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate the verification gate block');
const gate = ship.slice(start, end);

test('gate captures the status value (capture-then-route, not membership check)', () => {
  assert.match(gate, /grep\s+"\^status:"/, 'gate must extract the status via grep "^status:"');
});

test('gate routes gaps_found to /gsd:plan-phase --gaps', () => {
  assert.match(gate, /gaps_found/);
  assert.match(gate, /\/gsd:plan-phase[^\n]*--gaps/);
});

test('gate routes human_needed to the UAT manual-test step', () => {
  assert.match(gate, /human_needed/);
  assert.match(gate, /UAT\.md/);
});

test('gate routes a missing VERIFICATION.md to re-running execute-phase', () => {
  assert.match(gate, /\/gsd:execute-phase/);
});

test('gate still blocks with PHASE_VERIFICATION_INCOMPLETE', () => {
  assert.match(gate, /PHASE_VERIFICATION_INCOMPLETE/);
});

test('the dead `pass` status arm is gone — only `passed` is accepted', () => {
  assert.doesNotMatch(gate, /status:\s*pass(?!ed)/i, 'no bare `status: pass` arm may remain');
  assert.doesNotMatch(gate, /`pass`\s*\/\s*`passed`/, 'the `pass` / `passed` either-arm must be removed');
  assert.match(gate, /passed/);
});

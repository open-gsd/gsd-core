'use strict';

// Issue #966 — behavior-dependent must-haves must not pass on symbol presence.
// Content-assertion contract for the gsd-verifier agent: the
// PRESENT_BEHAVIOR_UNVERIFIED per-truth state, its routing to human_needed,
// the behavior-verified score split, and the parity invariant that the new
// per-truth state never leaks into the overall-status vocabulary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const verifierPath = path.join(ROOT, 'agents', 'gsd-verifier.md');
const verifier = fs.readFileSync(verifierPath, 'utf-8');
const standaloneTemplatePath = path.join(ROOT, 'gsd-core', 'templates', 'verification-report.md');
const standalone = fs.readFileSync(standaloneTemplatePath, 'utf-8');

test('Step 3 defines the PRESENT_BEHAVIOR_UNVERIFIED per-truth state', () => {
  assert.match(verifier, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(verifier, /present[^\n]*wired|wired[^\n]*present/i);
});

test('behavior-dependent trigger names transition + cancellation/cleanup/ordering invariants', () => {
  assert.match(verifier, /state transition/i);
  assert.match(verifier, /cancellation|cleanup|ordering/i);
  assert.match(verifier, /invariant/i);
});

test('PRESENT_BEHAVIOR_UNVERIFIED routes to human verification', () => {
  assert.match(verifier, /PRESENT_BEHAVIOR_UNVERIFIED[\s\S]{0,400}?human/i);
});

test('PRESENT_BEHAVIOR_UNVERIFIED is the only truth excluded from the verified score', () => {
  assert.match(
    verifier,
    /(do not count it toward the verified score)|(only[^\n]*excluded from `verified_truths`)|(only truths excluded)/i,
  );
});

test('score still credits PASSED (override) truths (override contract preserved)', () => {
  // The Step 9 score definition must count override-passed truths in verified_truths.
  assert.match(
    verifier,
    /verified_truths[\s\S]{0,200}?PASSED \(override\)/,
    'Step 9 score must count PASSED (override) truths in verified_truths',
  );
});

test('behavior-unverified truths get a structured frontmatter list that survives gaps_found', () => {
  assert.match(verifier, /behavior_unverified_items/);
  // and it must NOT be gated only to human_needed (must mention it is emitted regardless of status / when count > 0)
  assert.match(
    verifier,
    /behavior_unverified_items[\s\S]{0,160}?(regardless of (overall )?status|count > 0)/i,
  );
});

test('Step 9 / template carry the behavior_unverified score-split field', () => {
  assert.match(verifier, /behavior_unverified/);
});

test('critical_rules calibrates "presence is not behavior" without dropping the speed guard', () => {
  assert.match(verifier, /presence is not behavior/i);
  assert.match(verifier, /Keep verification fast/);
});

test('PARITY: per-truth state never leaks into the overall-status vocabulary', () => {
  assert.doesNotMatch(verifier, /→ \*\*status:\s*present_behavior_unverified\*\*/i);
  const unionLines = verifier.match(/^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$/gm) || [];
  assert.ok(unionLines.length > 0, 'expected at least one status union line');
  for (const line of unionLines) {
    assert.doesNotMatch(line, /present_behavior_unverified/i);
    // The real invariant is that the per-truth state is NOT in the union (above).
    // Membership (order-independent) avoids brittleness on a future legitimate reorder.
    for (const s of ['passed', 'gaps_found', 'human_needed']) {
      assert.ok(line.includes(s), `status union must still contain ${s}: ${line}`);
    }
  }
});

test('overall-status enum in verification.cts is unchanged (no per-truth leak)', () => {
  const cts = fs.readFileSync(path.join(ROOT, 'src', 'verification.cts'), 'utf-8');
  const m = cts.match(/VERIFIER_STATUSES[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'VERIFIER_STATUSES array must be present');
  assert.doesNotMatch(m[1], /present_behavior_unverified/i);
  for (const s of ['passed', 'gaps_found', 'human_needed']) {
    assert.match(m[1], new RegExp(`'${s}'`));
  }
});

test('VERIFICATION.md templates carry behavior_unverified + the new truth-state', () => {
  assert.match(verifier, /behavior_unverified/);
  assert.match(standalone, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(standalone, /behavior_unverified/);
  assert.match(verifier, /behavior_unverified_items/);
  assert.match(standalone, /behavior_unverified_items/);
});

const verifyPhase = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'verify-phase.md'), 'utf-8');
const planningArtifacts = fs.readFileSync(path.join(ROOT, 'docs', 'reference', 'planning-artifacts.md'), 'utf-8');

test('shipped verify-phase workflow mirrors the behavior-unverified calibration', () => {
  assert.match(verifyPhase, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(verifyPhase, /behavior_unverified/);
  assert.match(verifyPhase, /state transition/i);
});

test('planning-artifacts reference documents the behavior-unverified calibration', () => {
  assert.match(planningArtifacts, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(planningArtifacts, /behavior_unverified/);
});

test('Step 9 keeps gaps_found precedence and preserves behavior-unverified items', () => {
  assert.match(verifier, /gaps_found's precedence|gaps_found[\s\S]{0,160}?precedence/i);
  assert.match(verifier, /behavior_unverified_items[\s\S]{0,120}?(never lost|survive|regardless)/i);
});

test('shipped workflow flags behavior-unverified truths even on infrastructure phases', () => {
  assert.match(
    verifyPhase,
    /PRESENT_BEHAVIOR_UNVERIFIED[\s\S]{0,400}?infrastructure|infrastructure[\s\S]{0,400}?PRESENT_BEHAVIOR_UNVERIFIED/i,
  );
});

test('standalone template per-truth guideline respects gaps_found precedence', () => {
  assert.match(standalone, /becomes `human_needed`[\s\S]{0,80}?gaps_found/i);
});

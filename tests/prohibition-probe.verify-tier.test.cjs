// allow-test-rule: runtime-contract-is-the-product — the verify-time disposition of a test-tier
// prohibition is the deployed safety contract; this pins its fail-closed default to the code.
//
// RED-first SAFETY HALF of ADR-550 Decision 5(d) [maintainer decision 2026-06-12 "B-with-guard"].
// A WELL-FORMED test-tier prohibition (statement + status: resolved + verification: test) with NO
// wired enforcement evidence MUST yield a NON-GREEN / flagged-unverified disposition — proving an
// unwired test-tier item can NEVER be silently skipped (fail-closed default).
//
// This lives in its OWN test file (not the schema file) because it asserts a verify-disposition
// behavior — a different production module than frontmatter. The deterministic disposition helper
// does not exist yet (plan 01-04 implements the fail-closed default; the seam mirrors
// projectProhibitions in probe-core) — assert its expected contract so this is RED now.
//
// This is the cheap safety-guarantee half; the heavy "real negative-test enforcement mechanism" half
// is OUT of #644 scope (follow-up PR). No `polarity` key; no LLM judgment asserted (ADR-550 D5).
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROBE_CORE_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');

describe('prohibition-probe verify-tier: test-tier fail-closed safety (PROB-12 / ADR-550 D5d)', () => {
  test('probe-core exports a deterministic prohibition-disposition helper', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.equal(typeof pc.dispositionForProhibition, 'function',
      'probe-core must export dispositionForProhibition() — the deterministic verify-time disposition (ADR-550 D5d)');
  });

  test('a well-formed test-tier item with NO enforcement evidence is flagged non-green (fail-closed)', () => {
    const pc = require(PROBE_CORE_LIB);

    // Synthetic, well-formed test-tier prohibition with NO wired enforcement evidence.
    const unwiredTestTier = {
      requirement_id: 'R1',
      category: 'safety',
      status: 'resolved',
      verification: 'test',
      resolution: null,
      reason: null,
      statement: 'MUST NOT store raw SSN in plaintext',
      // deliberately: no enforcement evidence wired (no test reference / no proof)
    };

    const disposition = pc.dispositionForProhibition(unwiredTestTier, { enforcementEvidence: [] });

    // The disposition must NOT be a silent pass. Accept any explicit non-green signal the helper
    // chooses, but it must be unambiguously NOT 'green'/'pass' and must carry a flag.
    assert.ok(disposition && typeof disposition === 'object', 'disposition must be a structured object');
    assert.notEqual(disposition.status, 'green', 'an unwired test-tier item must NEVER be green (fail-closed)');
    assert.notEqual(disposition.status, 'pass', 'an unwired test-tier item must NEVER pass silently (fail-closed)');
    assert.ok(disposition.flagged === true || /unverified|unwired|flag/i.test(String(disposition.status)),
      'an unwired test-tier item must be flagged unverified — it can never be silently skipped');
  });
});

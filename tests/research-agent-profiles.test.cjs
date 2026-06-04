// allow-test-rule: <runtime-contract-is-the-product> research agent .md content is the governed surface
// The 7 researcher agent .md files are the deployed AI agent definitions — their
// frontmatter and @-includes ARE what the runtime loads. Asserting on their content
// is asserting on the deployed contract, not the test author's source code.

'use strict';

/**
 * research-agent-profiles.test.cjs — drift guard for the 7 researcher agents.
 *
 * Behavioral contract (DEFECT.GENERATIVE-FIX):
 *   1. The profiles table covers exactly the 7 researcher agents (no missing, no extra).
 *   2. Every agent passes the profile check (frontmatter + includes + seam-calls +
 *      output-contract markers all match the profile).
 *
 * If an agent's frontmatter/includes/seam-calls drift from its profile, this test fails.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { PROFILES, checkAgent } = require('../scripts/gen-research-agents.cjs');

const ROOT = path.resolve(__dirname, '..');

// The canonical set of 7 researcher agent names
const EXPECTED_AGENT_NAMES = new Set([
  'gsd-project-researcher',
  'gsd-phase-researcher',
  'gsd-advisor-researcher',
  'gsd-ai-researcher',
  'gsd-domain-researcher',
  'gsd-ui-researcher',
  'gsd-research-synthesizer',
]);

// ─── Profile coverage ─────────────────────────────────────────────────────────

describe('research-agent-profiles: coverage', () => {
  test('profiles covers exactly the 7 researcher agents — no missing agents', () => {
    const profileNames = new Set(PROFILES.map((p) => p.name));
    const missing = [];
    for (const name of EXPECTED_AGENT_NAMES) {
      if (!profileNames.has(name)) missing.push(name);
    }
    assert.deepEqual(
      missing,
      [],
      'These researcher agents are missing from PROFILES: ' + missing.join(', '),
    );
  });

  test('profiles covers exactly the 7 researcher agents — no extra agents', () => {
    const profileNames = PROFILES.map((p) => p.name);
    const extra = profileNames.filter((n) => !EXPECTED_AGENT_NAMES.has(n));
    assert.deepEqual(
      extra,
      [],
      'PROFILES contains unexpected agent names: ' + extra.join(', '),
    );
  });

  test('profiles contains exactly 7 entries', () => {
    assert.equal(
      PROFILES.length,
      7,
      'PROFILES should have 7 entries, got ' + PROFILES.length,
    );
  });
});

// ─── Per-agent parity check ───────────────────────────────────────────────────

describe('research-agent-profiles: parity', () => {
  for (const profile of PROFILES) {
    test(profile.name + ' matches its profile', () => {
      const agentPath = path.join(ROOT, 'agents', profile.name + '.md');
      assert.ok(
        fs.existsSync(agentPath),
        'Agent file not found: ' + agentPath,
      );

      const failures = checkAgent(profile);
      assert.deepEqual(
        failures,
        [],
        profile.name + ' has profile mismatches:\n' + failures.join('\n'),
      );
    });
  }
});

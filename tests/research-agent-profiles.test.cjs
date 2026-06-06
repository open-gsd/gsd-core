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
 *   3. (DEFECT.GENERATIVE-FIX parity guard) Every provider id in PROVIDER_WATERFALL
 *      has a dispatch mapping in the Step-C section of BOTH seam-wired researcher agents.
 *   4. checkAgent returns a clear failure string for malformed profiles (not a thrown TypeError).
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

// ─── Provider dispatch parity (DEFECT.GENERATIVE-FIX) ────────────────────────
//
// Every provider id in PROVIDER_WATERFALL must have a dispatch mapping in the
// Step-C section of gsd-phase-researcher.md and gsd-project-researcher.md.
// This guard fails when code adds a new provider without updating the agents.

describe('research-agent-profiles: provider dispatch parity', () => {
  // The two seam-wired researcher agents that contain a Step-C dispatch table.
  const SEAM_AGENTS = ['gsd-phase-researcher', 'gsd-project-researcher'];

  // Load PROVIDER_WATERFALL from the compiled seam module.
  const { PROVIDER_WATERFALL } = require('../gsd-core/bin/lib/research-provider.cjs');

  // Compute the union of all provider ids across all waterfall kinds.
  const allProviderIds = new Set();
  for (const ids of Object.values(PROVIDER_WATERFALL)) {
    for (const id of ids) {
      allProviderIds.add(id);
    }
  }

  // Extract the Step-C section from an agent file.
  // We look for the section between "### Step C" and "### Step D".
  function extractStepC(agentPath) {
    const content = fs.readFileSync(agentPath, 'utf8');
    const stepCStart = content.indexOf('### Step C');
    if (stepCStart === -1) return '';
    const stepDStart = content.indexOf('### Step D', stepCStart);
    if (stepDStart === -1) return content.slice(stepCStart);
    return content.slice(stepCStart, stepDStart);
  }

  for (const agentName of SEAM_AGENTS) {
    for (const providerId of allProviderIds) {
      test(agentName + ' Step-C dispatch table covers provider: ' + providerId, () => {
        const agentPath = path.join(ROOT, 'agents', agentName + '.md');
        assert.ok(
          fs.existsSync(agentPath),
          'Agent file not found: ' + agentPath,
        );
        const stepC = extractStepC(agentPath);
        assert.ok(
          stepC.includes('`' + providerId + '`') || stepC.includes('"' + providerId + '"'),
          agentName + ' Step-C dispatch table is missing provider "' + providerId + '".\n' +
          'Add a row for this provider in the Step-C dispatch table.\n' +
          'Step-C section content:\n' + stepC,
        );
      });
    }
  }
});

// ─── checkAgent handles malformed profiles without throwing ──────────────────

describe('research-agent-profiles: checkAgent malformed profile', () => {
  test('checkAgent returns clear failure string when requiredSeamCalls is missing (not a thrown TypeError)', () => {
    const malformedProfile = {
      name: 'gsd-phase-researcher',
      description: 'some description',
      color: 'cyan',
      tools: 'Read',
      requiredIncludes: [],
      // requiredSeamCalls intentionally omitted
      outputContract: [],
    };

    let result;
    let threw = false;
    try {
      result = checkAgent(malformedProfile);
    } catch (err) {
      threw = true;
    }

    assert.ok(
      !threw,
      'checkAgent threw a TypeError instead of returning a failure string. ' +
      'Add array validation at the top of checkAgent().',
    );
    assert.ok(
      Array.isArray(result),
      'checkAgent should return an array, got: ' + typeof result,
    );
    // Should contain a clear failure message about the missing field
    const combined = result.join('\n');
    assert.ok(
      combined.includes('requiredSeamCalls') || combined.includes('missing required array field'),
      'checkAgent should return a message mentioning the missing field "requiredSeamCalls", got: ' + combined,
    );
  });
});

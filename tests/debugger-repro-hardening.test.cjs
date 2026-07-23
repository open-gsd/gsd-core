// allow-test-rule: source-text-is-the-product (see #1962)
// Agent .md + reference .md + template .md files — their text IS what the
// runtime loads. Testing text content tests the deployed repro-hardening
// contract. Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 3A.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-repro-hardening.md');
const DEBUG_TEMPLATE = path.join(ROOT, 'gsd-core/templates/DEBUG.md');

describe('regression-test hardening — shrinking + oracle + boundaries (#1962, epic #1957 Phase 3A)', () => {
  describe('reference extract exists and is wired in', () => {
    test('gsd-core/references/debugger-repro-hardening.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-repro-hardening.md reference must exist');
    });

    test('gsd-debugger.md @-includes the repro-hardening reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-repro-hardening.md'),
        'gsd-debugger.md must @-include the repro-hardening reference (from Minimal Reproduction or Test-First Debugging)'
      );
    });
  });

  describe('shrinking-based repro minimization (criterion 1)', () => {
    test('reference documents property-based shrinking for JS/TS and Python', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/shrink/i.test(content), 'must document shrinking');
      assert.ok(/fast-check/i.test(content), 'must name fast-check (JS/TS shrinker)');
      assert.ok(/hypothesis/i.test(content), 'must name Hypothesis (Python shrinker)');
    });

    test('reference states the minimized counterexample becomes the regression seed', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/minimi[sz]/i.test(content), 'must reference minimization');
      assert.ok(/regression seed|seed|store.*minimi|minimi.*store/i.test(content),
        'must state the minimized counterexample is stored as the regression seed');
    });

    test('reference documents graceful degradation when no PBT framework is available', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/no.*(?:pbt|property|framework)|framework.*absent|unavailable/i.test(content),
        'must document degradation when no PBT framework is present');
      assert.ok(/manual minimi/i.test(content),
        'degradation must fall back to manual minimization (not silently skip)');
    });
  });

  describe('explicit oracle classification (criterion 2)', () => {
    test('reference names the four oracle types', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/specified/i.test(content), 'oracle: specified');
      assert.ok(/derived/i.test(content), 'oracle: derived (contract/model)');
      assert.ok(/metamorphic/i.test(content), 'oracle: metamorphic');
      assert.ok(/implicit/i.test(content), 'oracle: implicit (crash)');
    });

    test('reference flags implicit (crash) as the weakest — never the silent default', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/implicit.*(?:crash|weakest|weaker)|(?:crash|weakest|weaker).*implicit/i.test(content),
        'must flag implicit/crash as the weakest oracle (force justification, never default silently)');
    });

    test('DEBUG.md template Resolution records the oracle type', () => {
      const content = fs.readFileSync(DEBUG_TEMPLATE, 'utf8');
      assert.ok(/oracle_type/.test(content), 'DEBUG.md Resolution must carry an oracle_type field');
    });
  });

  describe('boundary neighbors (criterion 3)', () => {
    test('reference documents the boundary-neighbor categories', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/off-by-one|off by one|n\s*[+-]\s*1/i.test(content), 'boundary: off-by-one (N±1)');
      assert.ok(/min\/max|empty\/singleton|boundary/i.test(content), 'boundary: min/max or empty/singleton');
    });

    test('reference ties boundary neighbors to the fixed defect\'s equivalence class', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/equivalence class|fixed defect|adjacent/i.test(content),
        'must tie boundary neighbors to the fixed defect\'s equivalence class (not generic edge cases)');
    });
  });

  describe('integration with Phase 1A (mutation guardrail) — the seed must bite', () => {
    test('reference notes the minimized seed + oracle strengthen the Phase 1A mutation check', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/mutation|guardrail|kill.*mutant|root[\s-]?cause check/i.test(content),
        'must note that a minimized seed + a real oracle make the regression test a root-cause check (what Phase 1A needs to bite)');
    });
  });
});

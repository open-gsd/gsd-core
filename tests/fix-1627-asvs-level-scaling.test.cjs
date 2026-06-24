// allow-test-rule: source-text-is-the-product #1627
// Agent .md / reference .md files — their text IS what the runtime loads.
// Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Fix #1627 — ASVS level scaling
 *
 * Asserts that `workflow.security_asvs_level` now scales both planner
 * threat-disposition rigor and auditor verification depth rather than
 * being display-only.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const REFS_DIR = path.join(ROOT, 'gsd-core', 'references');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'INVENTORY-MANIFEST.json');

describe('SECURE: ASVS level scaling (#1627)', () => {
  // ── 1. New reference file ────────────────────────────────────────────────

  describe('security-asvs-levels.md reference', () => {
    const refPath = path.join(REFS_DIR, 'security-asvs-levels.md');

    test('file exists', () => {
      assert.ok(fs.existsSync(refPath), 'gsd-core/references/security-asvs-levels.md must exist');
    });

    test('defines all three levels', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      assert.ok(content.includes('L1'), 'must define L1');
      assert.ok(content.includes('L2'), 'must define L2');
      assert.ok(content.includes('L3'), 'must define L3');
    });

    test('L1 describes opportunistic scope and planner disposition', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      assert.ok(
        content.toLowerCase().includes('opportunistic'),
        'L1 must be described as opportunistic'
      );
      assert.ok(
        content.includes('mitigate') && content.includes('accept'),
        'must describe mitigate/accept dispositions'
      );
    });

    test('L2 requires explicit rationale for accepted threats', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      // L2 must require documented rationale for accepted risks
      assert.ok(
        content.includes('rationale') || content.includes('documented'),
        'L2 must require documented rationale for accepted threats'
      );
    });

    test('L3 describes deep/comprehensive verification', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      const lower = content.toLowerCase();
      assert.ok(
        lower.includes('deep') || lower.includes('comprehensive') || lower.includes('exhaustive'),
        'L3 must describe deep/comprehensive verification'
      );
    });

    test('mentions that higher levels are supersets of lower', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      const lower = content.toLowerCase();
      assert.ok(
        lower.includes('superset') || lower.includes('higher level') || lower.includes('includes all'),
        'must note that higher levels are supersets of lower'
      );
    });

    test('describes distinct auditor verification depth for each level', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      // All three audit depth keywords should appear
      assert.ok(content.includes('grep') || content.includes('PRESENT'), 'L1 audit depth must mention grep/presence check');
      assert.ok(content.includes('boundary') || content.includes('addresses'), 'L2 audit depth must mention boundary/addresses');
      assert.ok(content.includes('end-to-end') || content.includes('bypass'), 'L3 audit depth must mention end-to-end or bypass check');
    });
  });

  // ── 2. gsd-planner.md — no hardcoded L1 in disposition ──────────────────

  describe('gsd-planner.md security disposition', () => {
    const plannerPath = path.join(AGENTS_DIR, 'gsd-planner.md');

    test('planner security instruction does not hardcode "ASVS L1"', () => {
      const content = fs.readFileSync(plannerPath, 'utf-8');
      // The old bug: "mitigate if ASVS L1 requires it" — must be gone
      assert.ok(
        !content.includes('ASVS L1 requires it'),
        'planner must not hardcode "ASVS L1 requires it"; it must reference the configured level'
      );
    });

    test('planner references the configured OWASP ASVS level', () => {
      const content = fs.readFileSync(plannerPath, 'utf-8');
      assert.ok(
        content.includes('OWASP ASVS level') || content.includes('configured OWASP'),
        'planner must reference the configured OWASP ASVS level'
      );
    });

    test('planner @-references security-asvs-levels.md', () => {
      const content = fs.readFileSync(plannerPath, 'utf-8');
      assert.ok(
        content.includes('security-asvs-levels.md'),
        'planner must @-reference security-asvs-levels.md'
      );
    });

    test('planner is under the 49152-char cap', () => {
      const content = fs.readFileSync(plannerPath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      assert.ok(
        content.length < 49152,
        `gsd-planner.md must be < 49152 chars (LF-normalized); got ${content.length}`
      );
    });
  });

  // ── 3. gsd-security-auditor.md — scaled verification depth ──────────────

  describe('gsd-security-auditor.md verification depth', () => {
    const auditorPath = path.join(AGENTS_DIR, 'gsd-security-auditor.md');

    test('auditor scales verification depth by asvs_level', () => {
      const content = fs.readFileSync(auditorPath, 'utf-8');
      assert.ok(
        content.includes('asvs_level') || content.includes('ASVS level'),
        'auditor must reference asvs_level to scale verification'
      );
    });

    test('auditor describes L1/L2/L3 depth differences', () => {
      const content = fs.readFileSync(auditorPath, 'utf-8');
      // All three levels must appear in context of depth scaling
      assert.ok(content.includes('L1'), 'auditor must mention L1 depth');
      assert.ok(content.includes('L2'), 'auditor must mention L2 depth');
      assert.ok(content.includes('L3'), 'auditor must mention L3 depth');
    });

    test('auditor @-references security-asvs-levels.md', () => {
      const content = fs.readFileSync(auditorPath, 'utf-8');
      assert.ok(
        content.includes('security-asvs-levels.md'),
        'auditor must @-reference security-asvs-levels.md'
      );
    });

    test('auditor still echoes ASVS Level in structured output', () => {
      const content = fs.readFileSync(auditorPath, 'utf-8');
      assert.ok(
        content.includes('ASVS Level:') && content.includes('{1/2/3}'),
        'auditor must still emit ASVS Level in SECURED/OPEN_THREATS output'
      );
    });
  });

  // ── 4. secure-phase.md — ASVS-aware short-circuit ──────────────────────

  describe('secure-phase.md short-circuit conditioned on asvs_level', () => {
    const wfPath = path.join(ROOT, 'gsd-core', 'workflows', 'secure-phase.md');

    test('short-circuit to Step 6 is gated on asvs_level == 1', () => {
      const content = fs.readFileSync(wfPath, 'utf-8');
      // The condition must reference asvs_level so that L2/L3 don't skip the auditor
      assert.ok(
        content.includes('asvs_level == 1'),
        'secure-phase.md must gate the skip-to-Step-6 short-circuit on asvs_level == 1'
      );
    });

    test('auditor runs at L2/L3 even when threats_open is 0 (asvs_level >= 2 branch present)', () => {
      const content = fs.readFileSync(wfPath, 'utf-8');
      // The >= 2 branch must explicitly say the auditor is spawned for L2/L3 deep verification
      assert.ok(
        content.includes('asvs_level >= 2'),
        'secure-phase.md must include asvs_level >= 2 branch that does NOT skip the auditor'
      );
      // The >= 2 branch must make clear the auditor is spawned (not skipped)
      assert.ok(
        content.includes('L2/L3 deep verification') || content.includes('L2 boundary') || content.includes('L3 end-to-end'),
        'secure-phase.md asvs_level >= 2 branch must reference L2/L3 deep verification'
      );
    });
  });

  // ── 5. security-asvs-levels.md — L1 medium-severity gap closed ──────────

  describe('security-asvs-levels.md L1 medium-severity is specified', () => {
    const refPath = path.join(REFS_DIR, 'security-asvs-levels.md');

    test('L1 explicitly handles medium-severity threats (no gap)', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      // L1 section must say something about medium-severity
      assert.ok(
        content.includes('medium-severity') || content.includes('medium severity'),
        'L1 must explicitly specify disposition for medium-severity threats (no ambiguity gap)'
      );
    });

    test('L1 medium-severity disposition is conditional (trust-boundary-aware)', () => {
      const content = fs.readFileSync(refPath, 'utf-8');
      // L1 must distinguish between medium on primary trust boundary vs not
      assert.ok(
        content.includes('trust boundary') || content.includes('primary trust'),
        'L1 medium-severity rule must reference trust boundary to disambiguate disposition'
      );
    });
  });

  // ── 6. Inventory manifest ─────────────────────────────────────────────────

  describe('inventory manifest', () => {
    test('security-asvs-levels.md is registered in INVENTORY-MANIFEST.json', () => {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
      const refs = (manifest.families || {}).references || [];
      assert.ok(
        refs.includes('security-asvs-levels.md'),
        'security-asvs-levels.md must appear in families.references of INVENTORY-MANIFEST.json'
      );
    });
  });
});

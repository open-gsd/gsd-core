// allow-test-rule: source-text-is-the-product (see #1963)
// Agent .md + reference .md files — their text IS what the runtime loads.
// Testing text content tests the deployed prevention/postmortem contract.
// Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 3B (#1963).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const SESSION_MGR = path.join(ROOT, 'agents/gsd-debug-session-manager.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-prevention.md');

describe('prevention / blameless-postmortem output (#1963, epic #1957 Phase 3B)', () => {
  describe('reference extract exists and is wired into archive_session', () => {
    test('gsd-core/references/debugger-prevention.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-prevention.md reference must exist');
    });

    test('gsd-debugger.md @-includes the prevention reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-prevention.md'),
        'gsd-debugger.md must @-include the prevention reference from archive_session'
      );
    });
  });

  describe('the Prevention block has three blame-free components (criterion 1)', () => {
    test('reference documents a blameless 5-Whys causal chain', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/5-?\s*whys|five whys|causal chain/i.test(content), 'must document a 5-Whys causal chain');
      assert.ok(/blame|blameless|blame-free/i.test(content), 'must state the chain is blame-free/blameless');
    });

    test('the 5-Whys branches per RCA (Phase 2A), not a single-cause chain', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/branch/i.test(content), 'the postmortem must branch (not chain) per the Phase 2A RCA discipline');
      assert.ok(/single[\s-]?cause|agent error|why was that (?:error|possible)/i.test(content),
        'must treat "agent error" as a prompt for "why was that error possible?" (blame-free), not a terminal cause');
    });

    test('reference documents the "why wasn\'t this caught?" question', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/why (?:wasn'?t|was not|didn'?t).*(?:caught|prevent)/i.test(content) || /why[\s-]?not[\s-]?caught/i.test(content),
        'must document the "why wasn\'t this caught?" question (which existing gate missed it)');
    });

    test('reference documents the recurrence-guard taxonomy', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/recurrence guard|recurrence-guard/i.test(content), 'must name the recurrence guard');
      // The concrete artifact options from the issue
      assert.ok(/regression test/i.test(content), 'guard option: regression test');
      assert.ok(/lint rule|assertion|precondition/i.test(content), 'guard option: lint rule / assertion / precondition');
    });
  });

  describe('knowledge-base entry stores the prevention fields (criterion 2)', () => {
    test('KB entry format in gsd-debugger.md includes why_not_caught + recurrence_guard', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(/why.not.caught/i.test(content), 'KB entry format must include a why_not_caught field');
      assert.ok(/recurrence.guard/i.test(content), 'KB entry format must include a recurrence_guard field');
    });

    test('reference documents backward compatibility (old entries without the fields still load)', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/backward|back.compat|old entries|without.*fields.*load|absent.*field/i.test(content),
        'must document that old KB entries without the new fields still load (additive, no format break)');
    });
  });

  describe('session-manager compact return surfaces the prevention summary (criterion 3)', () => {
    test('gsd-debug-session-manager.md compact summary includes a prevention line', () => {
      const content = fs.readFileSync(SESSION_MGR, 'utf8');
      assert.ok(/prevention|recurrence guard|why not caught/i.test(content),
        'session-manager compact summary must surface the prevention summary (recurrence guard / why-not-caught)');
    });
  });

  describe('scope boundary (Zawinski) — a block, not an incident-management subsystem', () => {
    test('reference states the prevention block reuses existing structures and adds no subsystem', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/reuse|existing|no(?:t| new).*(?:subsystem|framework|command)|block, not/i.test(content),
        'must state the prevention block reuses the existing debug file + knowledge base (no new subsystem)');
    });
  });

  describe('cross-section parity (guards the Critical: Entry-Format fields must also appear in the archive append template)', () => {
    test('every Entry-Format KB field appears in the archive_session append template', () => {
      // DEFECT.GENERATIVE-FIX guard: the <knowledge_base_protocol> Entry Format
      // and the archive_session append template are two parallel surfaces that
      // must agree. A field declared in one but not the other is dead data.
      const content = fs.readFileSync(AGENT, 'utf8');
      const requiredFields = ['Date', 'Error patterns', 'Root cause', 'Fix', 'Files changed', 'Why not caught', 'Recurrence guard'];
      for (const field of requiredFields) {
        const matches = content.match(new RegExp(`\\*\\*${field}`, 'gi'));
        assert.ok(
          matches && matches.length >= 2,
          `KB field "${field}" must appear in BOTH the Entry Format and the archive append template (found ${matches ? matches.length : 0} occurrence(s)) — parallel-surface drift`
        );
      }
    });

    test('Phase 0 consumes the prevention fields (why_not_caught + recurrence_guard) when present', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      // Anchor on the specific Phase 0 heading in investigation_loop (the
      // string "Phase 0" also appears in knowledge_base_protocol prose, which
      // would match the wrong region).
      const phase0Block = content.match(/\*\*Phase 0: Check knowledge base\*\*[\s\S]{0,1500}/);
      assert.ok(phase0Block, 'a Phase 0: Check knowledge base block must exist in investigation_loop');
      assert.ok(/why.?not.?caught/i.test(phase0Block[0]) && /recurrence.?guard/i.test(phase0Block[0]),
        'the Phase 0 Evidence line must include why_not_caught + recurrence_guard (consume when present, absent on old entries)');
    });
  });
});

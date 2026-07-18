// allow-test-rule: source-text-is-the-product
// Agent .md + reference .md + template .md files — their text IS what the
// runtime loads. Testing text content tests the deployed guardrail contract.
// Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 1A (#1958).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const SESSION_MGR = path.join(ROOT, 'agents/gsd-debug-session-manager.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-fix-acceptance.md');
const DEBUG_TEMPLATE = path.join(ROOT, 'gsd-core/templates/DEBUG.md');

describe('fix-acceptance guardrail (#1958, epic #1957 Phase 1A)', () => {
  describe('reference extract exists and is wired into the agent', () => {
    test('gsd-core/references/debugger-fix-acceptance.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-fix-acceptance.md reference must exist');
    });

    test('gsd-debugger.md @-includes the fix-acceptance reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-fix-acceptance.md'),
        'gsd-debugger.md must @-include the fix-acceptance reference'
      );
    });
  });

  describe('all five guardrail signals are documented (Goodhart defense)', () => {
    test('reference names every signal', () => {
      assert.ok(fs.existsSync(REFERENCE), 'reference must exist before signal checks');
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/target test/i.test(content), 'signal 1: target test greens');
      assert.ok(/mutation/i.test(content), 'signal 2: mutation check');
      assert.ok(/no-op|deletion|behavior-deleting/i.test(content), 'signal 3: no-op/deletion detector');
      assert.ok(/adjacent|held-out/i.test(content), 'signal 4: adjacent/held-out tests');
      assert.ok(/revert[\s-]*and[\s-]*reconfirm/i.test(content), 'signal 5: revert-and-reconfirm');
    });
  });

  describe('graceful degradation (Gall — each signal degrades onto the working agent)', () => {
    test('mutation check skips when Stryker is unavailable', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(
        /no Stryker|stryker (?:is )?(?:absent|unavailable|not configured)/i.test(content),
        'must document skip when Stryker is absent'
      );
    });

    test('guardrail reduces when no test suite exists', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/no test suite/i.test(content), 'must document the no-suite reduction path');
    });

    test('a skipped signal is logged, never silently passed', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/skipped.*log|log.*skip|recorded.*skip|skip.*record/i.test(content),
        'skipped signals must be logged/recorded in the debug file');
    });
  });

  describe('FIX REJECTED BY GUARDRAIL return path (independence — any signal can reject)', () => {
    test('gsd-debugger.md defines the FIX REJECTED BY GUARDRAIL structured return', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(content.includes('FIX REJECTED BY GUARDRAIL'),
        'gsd-debugger.md must define the guardrail-rejection structured return');
    });

    test('gsd-debug-session-manager.md handles the guardrail-rejection return', () => {
      const content = fs.readFileSync(SESSION_MGR, 'utf8');
      assert.ok(content.includes('FIX REJECTED BY GUARDRAIL'),
        'session-manager must handle the FIX REJECTED BY GUARDRAIL return in its continuation loop');
    });
  });

  describe('per-signal results recorded to the debug file (Kernighan — auditable)', () => {
    test('reference documents the per-signal verification schema', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/verification/i.test(content),
        'reference must document how per-signal results land in Resolution.verification');
    });

    test('DEBUG.md template acknowledges structured per-signal verification', () => {
      const content = fs.readFileSync(DEBUG_TEMPLATE, 'utf8');
      assert.ok(/per-signal|guardrail|fix-acceptance/i.test(content),
        'DEBUG.md Resolution.verification must note structured per-signal recording');
    });
  });

  describe('acceptance criteria from #1958', () => {
    test('a surviving mutant at the fix site rejects the fix', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/surviv\w+ mutant|mutant.*surviv/i.test(content),
        'must state that a surviving mutant rejects the fix');
    });

    test('a deletion-only diff is rejected unless the RCA justifies removal', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/delet/i.test(content), 'deletion-only diffs are addressed');
      assert.ok(/justif|RCA|root.cause/i.test(content),
        'deletion must require RCA justification to be accepted');
    });

    test('revert-and-reconfirm must run before a fix is accepted', () => {
      const flat = fs.readFileSync(REFERENCE, 'utf8').replace(/\s+/g, ' ');
      assert.ok(/before.*accept|accept.*after.*revert|prior to accept/i.test(flat),
        'revert-and-reconfirm must run before fix acceptance');
    });
  });

  describe('subprocess bounding (CLAUDE.md gauntlet — unbounded subprocess)', () => {
    test('the mutation/Stryker subprocess is bounded', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/timeout|bounded/i.test(content),
        'mutation check subprocess must be bounded (gauntlet: npm 60s)');
    });
  });
});

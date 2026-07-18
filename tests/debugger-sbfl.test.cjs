// allow-test-rule: source-text-is-the-product (see #1959)
// Agent .md + reference .md files — their text IS what the runtime loads.
// Testing text content tests the deployed SBFL contract. The pure-JS Ochiai
// tests below validate the formula the reference documents (criterion 2:
// known-faulty location in top-N). Per CONTRIBUTING.md exception matrix.
// Covers epic #1957 Phase 1B (#1959).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let fc;
try {
  fc = require('fast-check');
} catch {
  fc = null;
}

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-sbfl.md');

// In-test canonical Ochiai implementation — validates the formula the reference
// documents. If the reference's formula drifts from real Ochiai, the contract
// tests (Ochiai named + formula shape) flag the drift, and these correctness
// tests pin what "correct Ochiai" means.
function ochiai(failedExec, passedExec, totalFailed) {
  if (totalFailed <= 0) return 0;
  const denom = Math.sqrt(totalFailed * (failedExec + passedExec));
  return denom === 0 ? 0 : failedExec / denom;
}

function rankByOchiai(elements, totalFailed) {
  return elements
    .map((e) => ({ element: e.element, score: ochiai(e.failedExec, e.passedExec, totalFailed) }))
    .sort((a, b) => b.score - a.score);
}

describe('spectrum-based fault localization (#1959, epic #1957 Phase 1B)', () => {
  describe('reference extract exists and is wired into the agent', () => {
    test('gsd-core/references/debugger-sbfl.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-sbfl.md reference must exist');
    });

    test('gsd-debugger.md @-includes the SBFL reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-sbfl.md'),
        'gsd-debugger.md must @-include the SBFL reference'
      );
    });
  });

  describe('Ochiai contract documented (criterion 1)', () => {
    test('reference names Ochiai and documents the formula', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/ochiai/i.test(content), 'reference must name the Ochiai formula');
      assert.ok(/sqrt/i.test(content), 'reference must document the sqrt-based formula');
      assert.ok(/failed/i.test(content) && /passed/i.test(content),
        'reference must reference failed(s) and passed(s) terms');
    });

    test('reference documents Tarantula as a fallback', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/tarantula/i.test(content), 'reference must mention Tarantula as a documented fallback');
    });

    test('reference documents top-N seeding into the hypothesis space', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/top-?n/i.test(content), 'reference must document top-N shortlist seeding');
    });
  });

  describe('graceful degradation (criterion 3)', () => {
    test('reference documents skip when no coverage / no test suite', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/i.test(content),
        'must document the no-coverage skip path');
      assert.ok(/skip.*log|log.*skip|skip.*note|note.*skip/i.test(content),
        'skip must be logged (not a silent pass) — Kernighan auditability');
    });
  });

  describe('ranking written to the debug file as seed evidence (criterion 4)', () => {
    test('reference documents recording the ranking under Evidence', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/evidence/i.test(content),
        'reference must document that the ranking lands in the Evidence section of the debug file');
    });
  });

  describe('pairs with Phase 2B bug-taxonomy routing', () => {
    test('reference notes SBFL is gated for deterministic (Bohrbug) failures', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/bohrbug|deterministic|flaky|heisenbug|mandelbug/i.test(content),
        'reference must note SBFL suits deterministic bugs and is not trusted on flaky spectra (pairs with Phase 2B)');
    });
  });

  describe('Ochiai formula correctness — behavioral (criterion 2: known-faulty location in top-N)', () => {
    test('score is always in [0, 1] for any non-negative inputs (totalFailed > 0)', () => {
      const fixture = [
        { failedExec: 0, passedExec: 10, totalFailed: 5 },
        { failedExec: 5, passedExec: 0, totalFailed: 5 },
        { failedExec: 3, passedExec: 7, totalFailed: 5 },
        { failedExec: 5, passedExec: 100, totalFailed: 5 },
      ];
      for (const f of fixture) {
        const s = ochiai(f.failedExec, f.passedExec, f.totalFailed);
        assert.ok(s >= 0 && s <= 1, `score ${s} out of [0,1] for failedExec=${f.failedExec} passedExec=${f.passedExec} totalFailed=${f.totalFailed}`);
      }
    });

    test('an element hit by all failing tests and no passing tests scores the maximum (1.0)', () => {
      assert.strictEqual(ochiai(5, 0, 5), 1);
      assert.strictEqual(ochiai(1, 0, 1), 1);
    });

    test('a known-faulty element ranks in the top-N of a representative fixture', () => {
      // Representative fixture: 5 tests (3 failing, 2 passing), 4 code elements.
      // Element "bug" is executed by all 3 failing tests and 0 passing → Ochiai 1.0 → rank #1.
      const totalFailed = 3;
      const elements = [
        { element: 'unrelated-a', failedExec: 1, passedExec: 2 },
        { element: 'bug', failedExec: 3, passedExec: 0 }, // the known fault
        { element: 'unrelated-b', failedExec: 2, passedExec: 2 },
        { element: 'unrelated-c', failedExec: 0, passedExec: 2 },
      ];
      const ranked = rankByOchiai(elements, totalFailed);
      const topN = ranked.slice(0, Math.min(3, ranked.length));
      assert.ok(topN.length > 0, 'ranking must be non-empty');
      assert.strictEqual(ranked[0].element, 'bug', 'the known-faulty element must rank #1');
      assert.ok(topN.some((r) => r.element === 'bug'),
        'the known-faulty element must appear in the top-N (criterion 2)');
      // ranking is non-increasing
      for (let i = 1; i < ranked.length; i++) {
        assert.ok(ranked[i - 1].score >= ranked[i].score, 'ranking must be non-increasing');
      }
    });

    test('degrades cleanly when there are no failing tests (totalFailed = 0 → all scores 0)', () => {
      const elements = [
        { element: 'a', failedExec: 0, passedExec: 5 },
        { element: 'b', failedExec: 0, passedExec: 3 },
      ];
      const ranked = rankByOchiai(elements, 0);
      for (const r of ranked) {
        assert.strictEqual(r.score, 0, 'no failing tests → every suspiciousness score is 0 (clean degradation)');
      }
    });

    if (fc) {
      test('property: ochiai(failedExec, passedExec, totalFailed) ∈ [0, 1] for totalFailed > 0', () => {
        fc.assert(
          fc.property(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 1000 }), (f, p, tf) => {
            const s = ochiai(f, p, tf);
            return s >= 0 && s <= 1;
          }),
          { numRuns: 200 }
        );
      });

      test('property: ranking is non-increasing and stable', () => {
        fc.assert(
          fc.property(
            fc.array(fc.record({ element: fc.string({ minLength: 1, maxLength: 8 }), failedExec: fc.nat(), passedExec: fc.nat() }), { maxLength: 20 }),
            fc.integer({ min: 1, max: 50 }),
            (elements, tf) => {
              const ranked = rankByOchiai(elements, tf);
              for (let i = 1; i < ranked.length; i++) {
                if (ranked[i - 1].score < ranked[i].score) return false;
              }
              return true;
            }
          ),
          { numRuns: 200 }
        );
      });
    }
  });
});

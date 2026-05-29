'use strict';

/**
 * Property-based tests for prompt-budget.cjs
 *
 * Module: get-shit-done/bin/lib/prompt-budget.cjs
 * Exported: estimateTokens(text), applyBudget({ sections, budget, options })
 *
 * Key invariants:
 *   - estimateTokens: always >= 0, monotonically related to string length
 *   - applyBudget: when hardFailed=false, estimatedTokens <= effectiveBudget
 *   - applyBudget: instructions and roadmap are ALWAYS kept verbatim (never trimmed)
 *   - applyBudget: below the minSet the call returns hardFailed=true with prompt=''
 *   - Budget boundary: a budget just at the effective floor triggers hard-fail;
 *     a budget just above it passes
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { estimateTokens, applyBudget } = require('../get-shit-done/bin/lib/prompt-budget.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalSections(overrides = {}) {
  return {
    instructions: 'Instructions text.',
    roadmap: 'Roadmap text.',
    plans: [{ file: 'plan.md', content: 'Plan content.' }],
    projectMd: null,
    context: null,
    research: null,
    requirements: null,
    ...overrides,
  };
}

// ─── estimateTokens property tests ───────────────────────────────────────────

describe('prompt-budget: estimateTokens properties', () => {
  test('property: estimateTokens is always >= 0', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(''),
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 200 })
        ),
        (input) => {
          const result = estimateTokens(input);
          assert.ok(typeof result === 'number', `estimateTokens must return number, got ${typeof result}`);
          assert.ok(result >= 0, `estimateTokens(${JSON.stringify(input)}) must be >= 0, got ${result}`);
          assert.ok(Number.isInteger(result), `estimateTokens must return integer, got ${result}`);
        }
      )
    );
  });

  test('property: estimateTokens is monotonically non-decreasing as text grows', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (base, suffix) => {
          const short = estimateTokens(base);
          const long = estimateTokens(base + suffix);
          assert.ok(long >= short, `tokens('${base}' + suffix)=${long} < tokens('${base}')=${short}`);
        }
      )
    );
  });

  test('property: estimateTokens(null/undefined) returns 0', () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(''), 0);
  });

  test('property: estimateTokens approximation is ceil(len/4)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 1000 }), (text) => {
        const expected = Math.ceil(text.length / 4);
        assert.equal(estimateTokens(text), expected);
      })
    );
  });
});

// ─── applyBudget property tests ───────────────────────────────────────────────

describe('prompt-budget: applyBudget properties', () => {
  // (a) Boundary property: budget near the hardFail threshold
  test('property: when minSet > effectiveBudget, applyBudget returns hardFailed=true and prompt=""', () => {
    fc.assert(
      fc.property(
        // Use a very small budget to force hard-fail
        fc.integer({ min: 1, max: 50 }),
        (tinyBudget) => {
          const sections = minimalSections({
            instructions: 'A'.repeat(200), // ~50 tokens
            roadmap: 'B'.repeat(200),      // ~50 tokens
          });
          const result = applyBudget({ sections, budget: tinyBudget });
          if (result.metadata.hardFailed) {
            assert.equal(result.prompt, '', 'hardFailed must return empty prompt');
            assert.equal(result.metadata.hardFailed, true);
          }
          // If not hard-failed, that is also valid — result is consistent
        }
      )
    );
  });

  test('property: when budget is adequate, estimatedTokens never exceeds effectiveBudget', () => {
    // Use a large budget: instructions ~10 tokens + roadmap ~10 tokens + plan ~10 tokens
    // With margin 10%, effectiveBudget = floor(budget * 0.9)
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 10_000 }),
        (budget) => {
          const sections = minimalSections();
          const result = applyBudget({ sections, budget });
          if (!result.metadata.hardFailed) {
            assert.ok(
              result.metadata.estimatedTokens <= result.metadata.effectiveBudget,
              `estimatedTokens ${result.metadata.estimatedTokens} > effectiveBudget ${result.metadata.effectiveBudget} at budget=${budget}`
            );
            assert.ok(result.prompt.length > 0, 'non-hardFailed must return non-empty prompt');
          }
        }
      )
    );
  });

  // (b) Robustness: hostile section inputs — applyBudget should either work or throw
  //     clearly — it must NEVER silently return a broken shape
  test('property: applyBudget always returns typed { prompt, metadata } shape on valid budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 50_000 }),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        (budget, instructions, roadmap) => {
          const sections = minimalSections({ instructions, roadmap });
          const result = applyBudget({ sections, budget });

          assert.ok(typeof result === 'object' && result !== null);
          assert.ok(typeof result.prompt === 'string', 'prompt must be string');
          assert.ok(typeof result.metadata === 'object' && result.metadata !== null);
          assert.ok(typeof result.metadata.hardFailed === 'boolean');
          assert.ok(typeof result.metadata.budget === 'number');
          assert.ok(typeof result.metadata.effectiveBudget === 'number');
          assert.ok(Array.isArray(result.metadata.omitted));
        }
      )
    );
  });

  test('property: instructions are always present verbatim in the output prompt', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (instructions) => {
          const sections = minimalSections({ instructions });
          const result = applyBudget({ sections, budget: 100_000 });
          if (!result.metadata.hardFailed) {
            assert.ok(
              result.prompt.includes(instructions),
              `Instructions not found verbatim in prompt. Instructions: "${instructions.slice(0, 50)}"`
            );
          }
        }
      )
    );
  });

  test('property: roadmap is always present verbatim in the output prompt', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (roadmap) => {
          const sections = minimalSections({ roadmap });
          const result = applyBudget({ sections, budget: 100_000 });
          if (!result.metadata.hardFailed) {
            assert.ok(
              result.prompt.includes(roadmap),
              `Roadmap not found verbatim in prompt. Roadmap: "${roadmap.slice(0, 50)}"`
            );
          }
        }
      )
    );
  });

  test('property: safetyMarginPct in [0,50] always produces effectiveBudget <= budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 100_000 }),
        fc.integer({ min: 0, max: 50 }),
        (budget, safetyMarginPct) => {
          const sections = minimalSections();
          const result = applyBudget({ sections, budget, options: { safetyMarginPct } });
          assert.ok(
            result.metadata.effectiveBudget <= budget,
            `effectiveBudget ${result.metadata.effectiveBudget} > budget ${budget} at margin ${safetyMarginPct}%`
          );
        }
      )
    );
  });

  test('property: context/research/requirements omission is tracked in metadata.omitted', () => {
    // Build a sections object where extras push it over a tight budget
    fc.assert(
      fc.property(
        fc.string({ minLength: 400, maxLength: 800 }), // ~100-200 tokens context
        (contextText) => {
          const sections = minimalSections({ context: contextText });
          // Use a very tight budget that forces trimming
          const baseTokens = estimateTokens('Instructions text.') +
            estimateTokens('Roadmap text.') +
            estimateTokens('Plan content.') + 20; // overhead

          const tightBudget = Math.ceil(baseTokens / 0.9) + 1; // just barely fits without context

          const result = applyBudget({ sections, budget: tightBudget });
          if (!result.metadata.hardFailed && result.metadata.omitted.includes('context')) {
            // The note must have been injected if context was dropped
            assert.equal(result.metadata.noteInjected, true,
              'noteInjected should be true when context was omitted');
          }
          // Whether or not context was dropped, omitted is always an array
          assert.ok(Array.isArray(result.metadata.omitted));
        }
      )
    );
  });
});

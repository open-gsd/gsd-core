'use strict';

/**
 * Property-based and boundary tests for research-provider.cjs classifyConfidence.
 *
 * Two layers of coverage:
 *   (a) Robustness property — classifyConfidence never throws on arbitrary inputs
 *       and always returns a valid confidence level.
 *   (b) Classification boundary examples — specific inputs assert HIGH vs MEDIUM vs LOW
 *       so that inverting the classification rules makes at least one test go red.
 *
 * RULESET.TESTS.property-based-testing
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyConfidence } = require('../gsd-core/bin/lib/research-provider.cjs');

// ---------------------------------------------------------------------------
// (a) Robustness property: classifyConfidence never throws + always valid type
// ---------------------------------------------------------------------------

describe('research-provider property: classifyConfidence never throws', () => {
  test('classifyConfidence({provider: any, verifiedAgainstOfficial: any, legitimacyVerdict: any}) never throws', () => {
    // Sample legitimacyVerdict from values an agent might supply or that arrive via checkPackages
    const legitimacyVerdictArb = fc.oneof(
      fc.constant('OK'),
      fc.constant('SUS'),
      fc.constant('SLOP'),
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.anything(),
    );
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        legitimacyVerdictArb,
        (provider, verifiedAgainstOfficial, legitimacyVerdict) => {
          let result;
          assert.doesNotThrow(() => {
            result = classifyConfidence({ provider, verifiedAgainstOfficial, legitimacyVerdict });
          });
          // Must return one of the three valid confidence levels
          assert.ok(
            result === 'HIGH' || result === 'MEDIUM' || result === 'LOW',
            `Expected HIGH|MEDIUM|LOW but got: ${String(result)}`
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Classification boundary examples
//
// Classification rules (in priority order):
//   1. legitimacyVerdict 'SLOP'  → LOW  (cap, checked first — overrides authority)
//   2. legitimacyVerdict 'OK' + known authority (!== 'none') → HIGH
//   3. authority === 'official' (context7, ref) → MEDIUM  (no legitimacyVerdict)
//   4. authority === 'scrape'   (jina, firecrawl) → MEDIUM (no legitimacyVerdict)
//   5. legitimacyVerdict 'OK' + unknown provider  → MEDIUM (groundTruth but no authority)
//   6. authority === 'web' (exa/tavily/brave/perplexity/websearch)
//        + verifiedAgainstOfficial === true  → MEDIUM
//   7. everything else (web without verification, unknown provider)  → LOW
// ---------------------------------------------------------------------------

describe('research-provider boundary: HIGH classification', () => {
  // Rule 2: groundTruth + any known authority → HIGH
  test('context7 (official) + OK verdict → HIGH', () => {
    assert.equal(
      classifyConfidence({ provider: 'context7', legitimacyVerdict: 'OK' }),
      'HIGH'
    );
  });

  test('ref (official) + OK verdict → HIGH', () => {
    assert.equal(
      classifyConfidence({ provider: 'ref', legitimacyVerdict: 'OK' }),
      'HIGH'
    );
  });

  test('jina (scrape) + OK verdict → HIGH', () => {
    assert.equal(
      classifyConfidence({ provider: 'jina', legitimacyVerdict: 'OK' }),
      'HIGH'
    );
  });

  test('exa (web) + OK verdict → HIGH', () => {
    assert.equal(
      classifyConfidence({ provider: 'exa', legitimacyVerdict: 'OK' }),
      'HIGH'
    );
  });

  test('tavily (web) + OK verdict → HIGH', () => {
    assert.equal(
      classifyConfidence({ provider: 'tavily', legitimacyVerdict: 'OK' }),
      'HIGH'
    );
  });
});

describe('research-provider boundary: MEDIUM classification', () => {
  // Rule 3: official authority alone (no verdict)
  test('context7, no verdict → MEDIUM (official authority alone)', () => {
    assert.equal(
      classifyConfidence({ provider: 'context7' }),
      'MEDIUM'
    );
  });

  test('ref, no verdict → MEDIUM (official authority alone)', () => {
    assert.equal(
      classifyConfidence({ provider: 'ref' }),
      'MEDIUM'
    );
  });

  // Rule 4: scrape authority alone (no verdict)
  test('jina, no verdict → MEDIUM (scrape authority alone)', () => {
    assert.equal(
      classifyConfidence({ provider: 'jina' }),
      'MEDIUM'
    );
  });

  test('firecrawl, no verdict → MEDIUM (scrape authority alone)', () => {
    assert.equal(
      classifyConfidence({ provider: 'firecrawl' }),
      'MEDIUM'
    );
  });

  // Rule 5: OK verdict + unknown provider → MEDIUM (groundTruth but no authority)
  test('unknown provider + OK verdict → MEDIUM (groundTruth, no authority)', () => {
    assert.equal(
      classifyConfidence({ provider: 'unknown-provider', legitimacyVerdict: 'OK' }),
      'MEDIUM'
    );
  });

  test('undefined provider + OK verdict → MEDIUM (groundTruth, no authority)', () => {
    assert.equal(
      classifyConfidence({ provider: undefined, legitimacyVerdict: 'OK' }),
      'MEDIUM'
    );
  });

  // Rule 6: web authority + verifiedAgainstOfficial === true → MEDIUM
  test('exa + verifiedAgainstOfficial:true (no verdict) → MEDIUM', () => {
    assert.equal(
      classifyConfidence({ provider: 'exa', verifiedAgainstOfficial: true }),
      'MEDIUM'
    );
  });

  test('tavily + verifiedAgainstOfficial:true (no verdict) → MEDIUM', () => {
    assert.equal(
      classifyConfidence({ provider: 'tavily', verifiedAgainstOfficial: true }),
      'MEDIUM'
    );
  });

  test('websearch + verifiedAgainstOfficial:true (no verdict) → MEDIUM', () => {
    assert.equal(
      classifyConfidence({ provider: 'websearch', verifiedAgainstOfficial: true }),
      'MEDIUM'
    );
  });

  // SUS verdict: not OK → does not reach rule 2; official authority → MEDIUM via rule 3
  test('context7 + SUS verdict → MEDIUM (SUS is not OK; official authority applies)', () => {
    assert.equal(
      classifyConfidence({ provider: 'context7', legitimacyVerdict: 'SUS' }),
      'MEDIUM'
    );
  });
});

describe('research-provider boundary: LOW classification', () => {
  // Rule 1: SLOP caps everything — even trusted official providers
  test('context7 + SLOP verdict → LOW (SLOP cap overrides official authority)', () => {
    assert.equal(
      classifyConfidence({ provider: 'context7', legitimacyVerdict: 'SLOP' }),
      'LOW'
    );
  });

  test('ref + SLOP verdict → LOW (SLOP cap overrides official authority)', () => {
    assert.equal(
      classifyConfidence({ provider: 'ref', legitimacyVerdict: 'SLOP' }),
      'LOW'
    );
  });

  test('exa + SLOP verdict → LOW (SLOP cap overrides web authority)', () => {
    assert.equal(
      classifyConfidence({ provider: 'exa', legitimacyVerdict: 'SLOP' }),
      'LOW'
    );
  });

  // Rule 7: web authority without verification and no OK verdict → LOW
  test('exa, no verdict, verifiedAgainstOfficial:false → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: 'exa', verifiedAgainstOfficial: false }),
      'LOW'
    );
  });

  test('websearch, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: 'websearch' }),
      'LOW'
    );
  });

  test('perplexity, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: 'perplexity' }),
      'LOW'
    );
  });

  test('brave, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: 'brave' }),
      'LOW'
    );
  });

  // Rule 7: completely unknown provider, no other signals → LOW
  test('unknown provider, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: 'unknown-provider' }),
      'LOW'
    );
  });

  test('undefined provider, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: undefined }),
      'LOW'
    );
  });

  test('null provider, no verdict → LOW', () => {
    assert.equal(
      classifyConfidence({ provider: null }),
      'LOW'
    );
  });
});

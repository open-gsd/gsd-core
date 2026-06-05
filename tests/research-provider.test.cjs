'use strict';

/**
 * Behavioral tests for research-provider.cjs
 *
 * No source-grep. All tests call exported functions and assert on returned objects.
 * RULESET.TESTS.no-source-grep
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_WATERFALL,
  classifyConfidence,
  providerAvailability,
  planResearch,
} = require('../gsd-core/bin/lib/research-provider.cjs');

// ---------------------------------------------------------------------------
// Shared fake-store helpers
// ---------------------------------------------------------------------------

function makeFakeStore({ hit = false, stale = false, entry = null } = {}) {
  return {
    researchKey: () => 'fake-key-sha256',
    getResearch: () => ({ hit, stale, entry }),
  };
}

const FULL_CONFIG = {
  exa_search: true,
  tavily_search: true,
  brave_search: true,
  firecrawl: true,
  ref_search: true,
  perplexity: true,
};

// ---------------------------------------------------------------------------
// Cycle 1: TRACER — planResearch, docs question, store miss -> context7, no cache
// ---------------------------------------------------------------------------

describe('research-provider: TRACER — docs question, store miss', () => {
  test('picks context7 as first available docs provider', async () => {
    const result = await planResearch({
      questions: [{ text: 'How does React useState work?', kind: 'docs' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    assert.ok(Array.isArray(result.items), 'result.items is an array');
    assert.equal(result.items.length, 1);

    const item = result.items[0];
    assert.equal(item.question, 'How does React useState work?');
    assert.equal(item.fetch.provider, 'context7');
    assert.equal(item.fetch.query, 'How does React useState work?');
    assert.equal(item.cache, undefined, 'no cache on miss');
  });
});

// ---------------------------------------------------------------------------
// Cycle 2: fresh cache hit -> cache present, no fetch
// ---------------------------------------------------------------------------

describe('research-provider: fresh cache hit', () => {
  test('returns cache object and no fetch when hit and not stale', async () => {
    const result = await planResearch({
      questions: [{ text: 'lodash chunk docs', kind: 'docs' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: true, stale: false }),
    });

    const item = result.items[0];
    assert.deepEqual(item.cache, { hit: true, stale: false });
    assert.equal(item.fetch, undefined, 'no fetch on fresh hit');
  });
});

// ---------------------------------------------------------------------------
// Cycle 3: stale cache -> cache present AND fetch present
// ---------------------------------------------------------------------------

describe('research-provider: stale cache', () => {
  test('returns cache with stale:true and fetch when cache is stale', async () => {
    const result = await planResearch({
      questions: [{ text: 'lodash chunk docs', kind: 'docs' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: true, stale: true }),
    });

    const item = result.items[0];
    assert.equal(item.cache.stale, true);
    assert.ok(item.fetch, 'fetch is present on stale');
    assert.equal(item.fetch.provider, 'context7');
  });
});

// ---------------------------------------------------------------------------
// Cycle 4: classifyConfidence mapping
// ---------------------------------------------------------------------------

describe('research-provider: classifyConfidence', () => {
  // Slice 1: core inversion — provider identity alone no longer yields HIGH
  test('context7 (no legitimacyVerdict) -> MEDIUM', () => {
    assert.equal(classifyConfidence({ provider: 'context7' }), 'MEDIUM');
  });

  test('ref (no legitimacyVerdict) -> MEDIUM', () => {
    assert.equal(classifyConfidence({ provider: 'ref' }), 'MEDIUM');
  });

  test('context7 + legitimacyVerdict OK -> HIGH', () => {
    assert.equal(classifyConfidence({ provider: 'context7', legitimacyVerdict: 'OK' }), 'HIGH');
  });

  test('jina -> MEDIUM', () => {
    assert.equal(classifyConfidence({ provider: 'jina' }), 'MEDIUM');
  });

  test('firecrawl -> MEDIUM', () => {
    assert.equal(classifyConfidence({ provider: 'firecrawl' }), 'MEDIUM');
  });

  test('exa without verification -> LOW', () => {
    assert.equal(classifyConfidence({ provider: 'exa', verifiedAgainstOfficial: false }), 'LOW');
  });

  test('exa with verification -> MEDIUM', () => {
    assert.equal(classifyConfidence({ provider: 'exa', verifiedAgainstOfficial: true }), 'MEDIUM');
  });

  test('websearch -> LOW', () => {
    assert.equal(classifyConfidence({ provider: 'websearch' }), 'LOW');
  });

  test('unknown provider zzz -> LOW (never throws)', () => {
    assert.equal(classifyConfidence({ provider: 'zzz' }), 'LOW');
  });

  test('undefined provider -> LOW (never throws)', () => {
    assert.doesNotThrow(() => classifyConfidence({ provider: undefined }));
    assert.equal(classifyConfidence({ provider: undefined }), 'LOW');
  });

  // Slice 2: caps + web + edges
  test('context7 + legitimacyVerdict SLOP -> LOW (cap overrides authority)', () => {
    assert.equal(classifyConfidence({ provider: 'context7', legitimacyVerdict: 'SLOP' }), 'LOW');
  });

  test('exa + legitimacyVerdict OK -> HIGH (verification drives, independent of provider)', () => {
    assert.equal(classifyConfidence({ provider: 'exa', legitimacyVerdict: 'OK' }), 'HIGH');
  });

  test('zzz + legitimacyVerdict OK -> MEDIUM (groundTruth but unknown provider)', () => {
    assert.equal(classifyConfidence({ provider: 'zzz', legitimacyVerdict: 'OK' }), 'MEDIUM');
  });

  test('legitimacyVerdict SUS + context7 -> MEDIUM (SUS is not OK, authority gives MEDIUM)', () => {
    assert.equal(classifyConfidence({ provider: 'context7', legitimacyVerdict: 'SUS' }), 'MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// Cycle 5: providerAvailability + planResearch web question picks tavily
// ---------------------------------------------------------------------------

describe('research-provider: providerAvailability', () => {
  test('exa false, tavily true, context7 always true, websearch always true', () => {
    const avail = providerAvailability({ exa_search: false, tavily_search: true });
    assert.equal(avail.exa, false);
    assert.equal(avail.tavily, true);
    assert.equal(avail.context7, true);
    assert.equal(avail.websearch, true);
  });

  test('planResearch web question with exa disabled picks tavily', async () => {
    const result = await planResearch({
      questions: [{ text: 'latest trends in AI', kind: 'web' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: { exa_search: false, tavily_search: true },
      store: makeFakeStore({ hit: false, stale: false }),
    });

    const item = result.items[0];
    assert.equal(item.fetch.provider, 'tavily');
  });
});

// ---------------------------------------------------------------------------
// Cycle 6: PROVIDER_WATERFALL shape — firecrawl ONLY in scrape
// ---------------------------------------------------------------------------

describe('research-provider: PROVIDER_WATERFALL shape', () => {
  test('docs array exists and contains context7', () => {
    assert.ok(Array.isArray(PROVIDER_WATERFALL.docs));
    assert.ok(PROVIDER_WATERFALL.docs.includes('context7'));
  });

  test('web array exists and contains exa', () => {
    assert.ok(Array.isArray(PROVIDER_WATERFALL.web));
    assert.ok(PROVIDER_WATERFALL.web.includes('exa'));
  });

  test('scrape array exists and contains firecrawl', () => {
    assert.ok(Array.isArray(PROVIDER_WATERFALL.scrape));
    assert.ok(PROVIDER_WATERFALL.scrape.includes('firecrawl'));
  });

  test('firecrawl NOT in docs (Balanced-set decision)', () => {
    assert.ok(!PROVIDER_WATERFALL.docs.includes('firecrawl'));
  });

  test('firecrawl NOT in web (Balanced-set decision)', () => {
    assert.ok(!PROVIDER_WATERFALL.web.includes('firecrawl'));
  });

  test('PROVIDER_WATERFALL has exactly docs, web, scrape keys', () => {
    const keys = Object.keys(PROVIDER_WATERFALL).sort();
    assert.deepEqual(keys, ['docs', 'scrape', 'web']);
  });
});

// ---------------------------------------------------------------------------
// Cycle 7: terminal fallback — all premium flags false -> websearch
// ---------------------------------------------------------------------------

describe('research-provider: terminal fallback to websearch', () => {
  test('web question with all premium providers disabled picks websearch', async () => {
    const noPremiConfig = {
      exa_search: false,
      tavily_search: false,
      brave_search: false,
      firecrawl: false,
      ref_search: false,
      perplexity: false,
    };

    const result = await planResearch({
      questions: [{ text: 'current js bundler comparison', kind: 'web' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: noPremiConfig,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    const item = result.items[0];
    assert.equal(item.fetch.provider, 'websearch');
  });
});

// ---------------------------------------------------------------------------
// FINDING 5 REGRESSION: planResearch skips questions with missing/non-string text
// ---------------------------------------------------------------------------

describe('FINDING-5: planResearch skips questions without non-empty string text', () => {
  test('question without text field → skipped; valid question → emitted (exactly 1 item)', async () => {
    // [{kind:'docs'}, {text:'use zod', kind:'docs'}] → only 1 item (for 'use zod')
    // CURRENTLY emits 2 items (first with question:undefined) — that is the bug.
    const result = await planResearch({
      questions: [
        { kind: 'docs' },                    // no text — must be skipped
        { text: 'use zod', kind: 'docs' },   // valid — must be emitted
      ],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    assert.ok(Array.isArray(result.items), 'result.items must be an array');
    assert.equal(
      result.items.length,
      1,
      `FINDING-5: expected exactly 1 item (text-less question skipped), got ${result.items.length}: ${JSON.stringify(result.items)}`,
    );
    assert.equal(result.items[0].question, 'use zod', 'retained item must be the valid question');
  });

  test('question with text:null → skipped', async () => {
    const result = await planResearch({
      questions: [{ text: null, kind: 'docs' }, { text: 'valid', kind: 'docs' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    assert.equal(result.items.length, 1, `null-text question should be skipped; got ${result.items.length} items`);
    assert.equal(result.items[0].question, 'valid');
  });

  test('question with text:"" (empty string) → skipped', async () => {
    const result = await planResearch({
      questions: [{ text: '', kind: 'docs' }, { text: 'valid2', kind: 'docs' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    assert.equal(result.items.length, 1, `empty-string text question should be skipped; got ${result.items.length} items`);
    assert.equal(result.items[0].question, 'valid2');
  });

  test('all questions lack text → empty items array', async () => {
    const result = await planResearch({
      questions: [{ kind: 'docs' }, { kind: 'web' }],
      ecosystem: 'npm',
      cwd: '/tmp',
      config: FULL_CONFIG,
      store: makeFakeStore({ hit: false, stale: false }),
    });

    assert.equal(result.items.length, 0, `all text-less questions should yield empty items`);
  });
});

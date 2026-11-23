"use strict";
/**
 * Research Provider Module
 *
 * Encodes the Balanced-set provider decision: PROVIDER_WATERFALL constant,
 * classifyConfidence, providerAvailability, and planResearch (with injectable
 * store for testability).
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 */
// ---------------------------------------------------------------------------
// Cycle 1 / Cycle 6: PROVIDER_WATERFALL (Balanced-set decision)
// firecrawl appears ONLY in scrape — demoted to known-URL scrape, NOT in docs/web
// ---------------------------------------------------------------------------
const PROVIDER_WATERFALL = {
    docs: ['context7', 'ref', 'jina', 'websearch'],
    web: ['exa', 'tavily', 'perplexity', 'brave', 'websearch'],
    scrape: ['firecrawl', 'jina'],
};
function authorityOf(provider) {
    switch (provider) {
        case 'context7':
        case 'ref':
            return 'official';
        case 'jina':
        case 'firecrawl':
            return 'scrape';
        case 'exa':
        case 'tavily':
        case 'perplexity':
        case 'brave':
        case 'websearch':
            return 'web';
        default:
            return 'none';
    }
}
function normalizeLegitimacyVerdict(raw) {
    if (typeof raw !== 'string')
        return null;
    const upper = raw.toUpperCase();
    if (upper === 'OK' || upper === 'SUS' || upper === 'SLOP')
        return upper;
    return null;
}
function classifyConfidence(input) {
    try {
        const { provider, verifiedAgainstOfficial, legitimacyVerdict } = input;
        const authority = authorityOf(provider);
        const verdict = normalizeLegitimacyVerdict(legitimacyVerdict);
        const groundTruth = verdict === 'OK';
        // SLOP caps everything — checked first
        if (verdict === 'SLOP')
            return 'LOW';
        // Ground-truth corroboration + known authority → HIGH
        if (groundTruth && authority !== 'none')
            return 'HIGH';
        // Official or scrape provider (authority alone) → MEDIUM
        if (authority === 'official' || authority === 'scrape')
            return 'MEDIUM';
        // Ground-truth but unknown provider → MEDIUM
        if (groundTruth)
            return 'MEDIUM';
        // Web provider with self-reported verification → MEDIUM
        if (authority === 'web' && verifiedAgainstOfficial === true)
            return 'MEDIUM';
        return 'LOW';
    }
    catch {
        return 'LOW';
    }
}
// ---------------------------------------------------------------------------
// Cycle 5: providerAvailability
// ---------------------------------------------------------------------------
function providerAvailability(config) {
    const cfg = config ?? {};
    return {
        context7: true,
        jina: cfg.jina !== undefined ? Boolean(cfg.jina) : true,
        websearch: true,
        exa: Boolean(cfg.exa_search),
        tavily: Boolean(cfg.tavily_search),
        brave: Boolean(cfg.brave_search),
        firecrawl: Boolean(cfg.firecrawl),
        ref: Boolean(cfg.ref_search),
        perplexity: Boolean(cfg.perplexity),
    };
}
// ---------------------------------------------------------------------------
// Lazy-load default store (avoids circular require at module eval time)
// ---------------------------------------------------------------------------
let _defaultStore;
function getDefaultStore() {
    if (!_defaultStore) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy default store; tests inject their own
        _defaultStore = require('./research-store.cjs');
    }
    return _defaultStore;
}
// ---------------------------------------------------------------------------
// Cycle 1–3, 5, 7: planResearch
// ---------------------------------------------------------------------------
function planResearch(options) {
    const { questions, ecosystem = '', cwd, config, clock = Date, homeDir, store = getDefaultStore(), } = options;
    const availability = providerAvailability(config);
    const items = questions.flatMap((q) => {
        const { text, kind, library, version } = q;
        // Skip questions without a non-empty string text — emitting an item with
        // question:undefined / fetch.query:undefined would produce corrupt output.
        if (typeof text !== 'string' || text.length === 0) {
            return [];
        }
        const key = store.researchKey({ ecosystem, library, version, query: text, kind });
        const res = store.getResearch(cwd, key, { clock, homeDir, kind });
        // Fresh cache hit — no fetch needed
        if (res.hit && !res.stale) {
            return { question: text, key, cache: { hit: true, stale: false } };
        }
        // Determine which waterfall to use
        const waterfall = PROVIDER_WATERFALL[kind] ?? PROVIDER_WATERFALL.web;
        // Pick first available provider
        const provider = waterfall.find((p) => availability[p] === true) ?? 'websearch';
        const item = {
            question: text,
            key,
            fetch: { provider, query: text },
        };
        // Stale hit: include cache info
        if (res.hit) {
            item.cache = { hit: true, stale: true };
        }
        return item;
    });
    return { items };
}
module.exports = { PROVIDER_WATERFALL, classifyConfidence, providerAvailability, planResearch };

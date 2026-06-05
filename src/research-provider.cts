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
// Types
// ---------------------------------------------------------------------------

type ProviderKind = 'docs' | 'web' | 'scrape';
type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

interface ProviderWaterfall {
  docs: string[];
  web: string[];
  scrape: string[];
}

interface ClassifyConfidenceInput {
  provider?: unknown;
  verifiedAgainstOfficial?: unknown;
  legitimacyVerdict?: unknown;
}

interface ProviderAvailabilityConfig {
  exa_search?: unknown;
  tavily_search?: unknown;
  brave_search?: unknown;
  firecrawl?: unknown;
  ref_search?: unknown;
  perplexity?: unknown;
  jina?: unknown;
  [key: string]: unknown;
}

interface Question {
  text: string;
  kind: string;
  library?: string;
  version?: string;
}

interface StoreResult {
  hit: boolean;
  stale: boolean;
  entry: unknown;
}

interface ResearchStore {
  researchKey(input: {
    ecosystem?: unknown;
    library?: unknown;
    version?: unknown;
    query?: unknown;
    kind?: unknown;
  }): string;
  getResearch(
    cwd: string,
    key: string,
    opts?: { clock?: typeof Date; homeDir?: string; kind?: string }
  ): StoreResult;
}

interface PlanResearchOptions {
  questions: Question[];
  ecosystem?: string;
  cwd: string;
  config?: ProviderAvailabilityConfig;
  clock?: typeof Date;
  homeDir?: string;
  store?: ResearchStore;
}

interface CacheInfo {
  hit: boolean;
  stale: boolean;
}

interface FetchInfo {
  provider: string;
  query: string;
}

interface ResearchItem {
  question: string;
  key: string;
  cache?: CacheInfo;
  fetch?: FetchInfo;
}

interface PlanResearchResult {
  items: ResearchItem[];
}

// ---------------------------------------------------------------------------
// Cycle 1 / Cycle 6: PROVIDER_WATERFALL (Balanced-set decision)
// firecrawl appears ONLY in scrape — demoted to known-URL scrape, NOT in docs/web
// ---------------------------------------------------------------------------

const PROVIDER_WATERFALL: ProviderWaterfall = {
  docs: ['context7', 'ref', 'jina', 'websearch'],
  web: ['exa', 'tavily', 'perplexity', 'brave', 'websearch'],
  scrape: ['firecrawl', 'jina'],
};

// ---------------------------------------------------------------------------
// Cycle 4: classifyConfidence (evidence-driven)
//
// HIGH = corroborated against an authoritative source (registry ground-truth),
// NOT a correctness guarantee.
//
// Two-axis model:
//   axis-1: authorityOf(provider) → 'official' | 'scrape' | 'web' | 'none'
//   axis-2: groundTruth (legitimacyVerdict normalized to OK|SUS|SLOP)
//
// Decision table (evaluated in order):
//   legitimacyVerdict === 'SLOP'                         → LOW  (caps everything)
//   groundTruth && authority !== 'none'                  → HIGH
//   authority === 'official' || authority === 'scrape'   → MEDIUM
//   groundTruth (authority 'none')                       → MEDIUM
//   authority === 'web' && verifiedAgainstOfficial       → MEDIUM
//   else                                                 → LOW
// ---------------------------------------------------------------------------

type ProviderAuthority = 'official' | 'scrape' | 'web' | 'none';

function authorityOf(provider: unknown): ProviderAuthority {
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

function normalizeLegitimacyVerdict(raw: unknown): 'OK' | 'SUS' | 'SLOP' | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  if (upper === 'OK' || upper === 'SUS' || upper === 'SLOP') return upper;
  return null;
}

function classifyConfidence(input: ClassifyConfidenceInput): ConfidenceLevel {
  try {
    const { provider, verifiedAgainstOfficial, legitimacyVerdict } = input;
    const authority = authorityOf(provider);
    const verdict = normalizeLegitimacyVerdict(legitimacyVerdict);
    const groundTruth = verdict === 'OK';

    // SLOP caps everything — checked first
    if (verdict === 'SLOP') return 'LOW';

    // Ground-truth corroboration + known authority → HIGH
    if (groundTruth && authority !== 'none') return 'HIGH';

    // Official or scrape provider (authority alone) → MEDIUM
    if (authority === 'official' || authority === 'scrape') return 'MEDIUM';

    // Ground-truth but unknown provider → MEDIUM
    if (groundTruth) return 'MEDIUM';

    // Web provider with self-reported verification → MEDIUM
    if (authority === 'web' && verifiedAgainstOfficial === true) return 'MEDIUM';

    return 'LOW';
  } catch {
    return 'LOW';
  }
}

// ---------------------------------------------------------------------------
// Cycle 5: providerAvailability
// ---------------------------------------------------------------------------

function providerAvailability(config?: ProviderAvailabilityConfig): Record<string, boolean> {
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

let _defaultStore: ResearchStore | undefined;

function getDefaultStore(): ResearchStore {
  if (!_defaultStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy default store; tests inject their own
    _defaultStore = require('./research-store.cjs') as ResearchStore;
  }
  return _defaultStore;
}

// ---------------------------------------------------------------------------
// Cycle 1–3, 5, 7: planResearch
// ---------------------------------------------------------------------------

function planResearch(options: PlanResearchOptions): PlanResearchResult {
  const {
    questions,
    ecosystem = '',
    cwd,
    config,
    clock = Date,
    homeDir,
    store = getDefaultStore(),
  } = options;

  const availability = providerAvailability(config);

  const items: ResearchItem[] = questions.flatMap((q) => {
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
    const waterfall: string[] =
      (PROVIDER_WATERFALL as unknown as Record<string, string[]>)[kind] ?? PROVIDER_WATERFALL.web;

    // Pick first available provider
    const provider = waterfall.find((p) => availability[p] === true) ?? 'websearch';

    const item: ResearchItem = {
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = { PROVIDER_WATERFALL, classifyConfidence, providerAvailability, planResearch };

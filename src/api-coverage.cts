/**
 * API-Coverage detector + matrix validator (#1562).
 *
 * The enforcement half of "Full API Coverage by Default — Opt Out, Never Opt In."
 * When a phase integrates an external API/service/SDK, the planner must produce a
 * coverage matrix (COVERAGE.md) enumerating the API's capability surface; every
 * non-integrated capability is an explicit, reasoned opt-out. The seal-time gate
 * (capabilities/ai-integration, verify:pre) consumes this module to (a) detect
 * whether a phase integrates an external API and (b) validate the produced matrix.
 *
 * Design notes (rubber-duck'd):
 *  - DETERMINISTIC + TYPED IR. Both the "does this phase integrate an external
 *    API?" decision and the "is this matrix complete?" decision are pure
 *    functions returning typed IR, not LLM judgments — so the low-false-positive
 *    guarantee (acceptance criterion #4) and the completeness guarantee
 *    (acceptance #2) are testable. Mirrors assumption-delta.cts (#1561).
 *  - COMPOUND SIGNAL for low false positives. A bare word like "api" appears in
 *    countless non-integration phases ("the public API of UserController"). The
 *    detector requires an INTEGRATION VERB and an EXTERNAL-API NOUN in the SAME
 *    CLAUSE (#2365 — same-line co-occurrence across unrelated clauses over-fired;
 *    the clause boundary, not a word-gap cap, is the relationship test), or an
 *    explicit "<Service> API/SDK" phrase naming a real service. Single weak
 *    tokens do not fire. This is the issue's "low false-positive trigger" made
 *    mechanical.
 *  - CODE AND PATHS ARE NOT PROSE. Fenced code blocks and inline code spans are
 *    stripped first (markdown-sectionizer seam), and path-shaped tokens
 *    (`src/app/api/...`, URLs) are masked, so a trigger term inside code or a
 *    first-party route path does not fire (#2365).
 *  - NO-INTEGRATION DECLARATION (#2365 acceptance #5). A COVERAGE.md consisting
 *    of `No external API integration: <reason>` is a valid, reasoned way for a
 *    phase to state that no external surface exists — the alternative to
 *    fabricating a matrix row when the detector is overruled by a human.
 *  - THE DETECTOR IS A FALLBACK. The primary path is the plan:pre contribution
 *    prompting COVERAGE.md creation. The detector runs only when COVERAGE.md is
 *    ABSENT, to catch the "nobody decided" case (acceptance #1). Its precision
 *    therefore matters but is not the only line of defense.
 *  - MATRIX FORMAT. The matrix is a markdown table (human-editable, diff-friendly)
 *    with a header row `| capability | decision | reason |` and one row per
 *    capability. decision ∈ {INTEGRATE, OPT-OUT}. An OPT-OUT row MUST carry a
 *    non-empty reason. A fenced ```coverage JSON block is also accepted for
 *    machine-generated matrices. This dual shape is bijective (parse/render
 *    round-trip) and covered by a fast-check property test.
 *  - ADDITIVE-ONLY VOCABULARY (Hyrum's Law). Once shipped, the verb/noun sets
 *    are depended-upon interfaces; they only grow. Tunable via the `terms`
 *    parameter so teams can widen them without forking.
 *
 * Public API:
 *   detectApiIntegration(text, terms?) -> { detected, signals, terms }
 *   parseCoverageMatrix(text) -> { rows, errors, format }
 *   validateCoverageMatrix(text) -> { valid, errors, counts }
 *   renderCoverageMatrix(rows) -> string
 *   DEFAULT_API_COVERAGE_TERMS
 *
 * CLI:
 *   echo "$SCOPE" | node gsd-core/bin/lib/api-coverage.cjs [--json]
 *     exit 0 = integration detected, 1 = none, 2 = startup error
 */

import { stripFencedCode, scanInlineCodeSpans, extractFencedBlock, scanFencedBlocks } from './markdown-sectionizer.cjs';
import { matchTableSchema, splitTableRow, isDelimiterRow, escapeCell } from './markdown-table.cjs';

// ─── Integration-signal vocabulary ────────────────────────────────────────────

export interface ApiCoverageTermSet {
  verbs: string[];
  nouns: string[];
}

export interface ApiCoverageSignal {
  verb: string;
  noun: string;
  snippet: string;
}

export interface ApiCoverageDetectionResult {
  detected: boolean;
  signals: ApiCoverageSignal[];
  terms: ApiCoverageTermSet;
}

/**
 * Curated default trigger vocabulary. ADDITIVE-ONLY (Hyrum's Law). Tunable via
 * the `terms` parameter.
 *
 * VERBS are deliberately conservative: common verbs like "add", "use", "call",
 * "implement" are EXCLUDED because they appear in nearly every phase and would
 * make the gate fire on prose that has nothing to do with an external API. The
 * verbs kept all connote BRINGING IN an external surface.
 *
 * NOUNS name an external-API surface. Bare "client" is excluded — too ambiguous
 * (client-side UI vs API client). "service" alone is excluded (internal
 * services); a phase integrating an external service virtually always pairs it
 * with "API"/"SDK"/"REST"/etc., which the compound verb+noun rule captures.
 */
export const DEFAULT_API_COVERAGE_TERMS: Readonly<ApiCoverageTermSet> = {
  verbs: [
    'integrate',
    'integrates',
    'integrating',
    'integration',
    'wrap',
    'wraps',
    'wrapping',
    'connect',
    'connects',
    'connecting',
    'consume',
    'consumes',
    'consuming',
    'wire',
    'wires',
    'wiring',
    'onboard',
    'onboarding',
    'adopt',
    'adopts',
    'adopting',
  ],
  nouns: [
    'api',
    'apis',
    'sdk',
    'sdks',
    'rest',
    'graphql',
    'grpc',
    'endpoint',
    'endpoints',
    'oauth',
    'oauth2',
    'webhook',
    'webhooks',
    'mcp',
  ],
};

/** Hardening caps for the tunable vocabulary (hostile `--terms` defense). */
const MAX_TERMS_PER_KIND = 200;
const MAX_TERM_LEN = 32;

/**
 * Field-length caps for matrix cell values. Cell content flows from a
 * semi-trusted COVERAGE.md into the gate `message` that the orchestrator LLM
 * reads, so it is bounded to keep the prompt-injection surface small and to
 * document the format contract (short, single-line prose — not paragraphs).
 */
const CAPABILITY_MAX_LEN = 80;
const REASON_MAX_LEN = 200;

function normalizeTerms(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase().slice(0, MAX_TERM_LEN);
    if (!t || !/[a-z0-9]/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TERMS_PER_KIND) break;
  }
  return out;
}

function resolveTerms(terms?: Partial<ApiCoverageTermSet>): ApiCoverageTermSet {
  const merge = (key: 'verbs' | 'nouns'): string[] => {
    const t = terms && terms[key];
    return Array.isArray(t) ? normalizeTerms(t) : [...DEFAULT_API_COVERAGE_TERMS[key]];
  };
  return { verbs: merge('verbs'), nouns: merge('nouns') };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSnippet(line: string, anchor: string): string {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 120) return cleaned;
  const idx = cleaned.toLowerCase().indexOf(anchor);
  if (idx < 0) return cleaned.slice(0, 120);
  const start = Math.max(0, idx - 50);
  const end = Math.min(cleaned.length, idx + anchor.length + 50);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < cleaned.length ? '…' : '';
  return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}

/** `<Service> API` / `<Service> SDK` — a capitalized proper noun immediately
 *  followed by API/SDK. Strong signal on its own (no verb required).
 *
 *  STOPWORDS guard against the false positive where an ordinary capitalized
 *  sentence starter ("The API …", "An SDK …", "Our REST …") matches the
 *  `[A-Z]\w+ API` shape. Those are common English, not a service name, so they
 *  are rejected before counting as a surface signal (acceptance #4 — low false
 *  positives). */
// Service-name length is bounded ({1,40}) so a hostile "A-A-A-…-A-x" run cannot
// drive the greedy group into O(n^2) backtracking (#2365 review). Nearly all
// vendor names fit; a >41-char service token before API/SDK would be missed by
// this surface path (it would still fire via the compound verb+noun rule) —
// an accepted bound.
const SERVICE_SURFACE_API_RE = /\b([A-Z][A-Za-z0-9_-]{1,40})\s+(API|SDK|REST|GraphQL)\b/;
const SERVICE_STOPWORDS = new Set([
  'the', 'an', 'a', 'our', 'this', 'these', 'that', 'those', 'new', 'add',
  'use', 'your', 'my', 'no', 'some', 'any', 'all', 'each', 'every', 'both',
  'if', 'when', 'while', 'with', 'via', 'using', 'into', 'its', 'their',
  'we', 'you', 'they', 'it',
]);

/** #2365 — the detector is FAIL-CLOSED: it leans toward detecting, because a
 *  false positive is cheaply dismissed by a one-line COVERAGE.md "no external
 *  API integration" declaration, whereas a false NEGATIVE silently lets a real
 *  external-API phase past a BLOCKING gate. So the only prose the detector
 *  actively suppresses is the classes that are unambiguously NOT external
 *  integration: first-party route paths, verb/noun in unrelated clauses, and
 *  descriptive/protocol "<Word> API" prose with no named service.
 *
 *  CLAUSE_BOUNDARY_RE: a verb and a noun form ONE compound action only inside
 *  one grammatical clause — sentence punctuation and table-cell walls (`|`)
 *  end a clause. `-` is deliberately absent (it would split hyphenated words).
 *  There is deliberately NO word-gap cap inside a clause: a cap cannot separate
 *  a genuine long integration clause (F4, 21 words) from a long internal-UI
 *  clause (18 words) — the clause boundary is the only sound signal, and the
 *  declaration handles the residual false positives. */
const CLAUSE_BOUNDARY_RE = /[,;:.!?|()—–]/;
/** Same character class as CLAUSE_BOUNDARY_RE, as a set — for scanning a token's
 *  trailing punctuation without an unanchored `[…]+$` regex, whose backtracking
 *  is O(n^2) on a long punctuation run (#2365 review). */
const CLAUSE_BOUNDARY_CHARS = new Set([',', ';', ':', '.', '!', '?', '|', '(', ')', '—', '–']);

/*  DELIBERATELY NO cross-clause binding. Detection is same-clause only. Binding
 *  a verb in one clause to a noun in another ("Integrate Stripe, exposing its
 *  endpoints"; "Integrate Stripe; use its endpoints") requires knowing "Stripe"
 *  is a vendor and "its" refers to it — a vendor dictionary + coreference, which
 *  trek-e's brief rules out in principle. Every lexical cross-clause rule tried
 *  (word-gap cap, participle continuation) traded a false negative for a false
 *  positive across four review rounds. So a service named ONLY in a clause
 *  separate from its API noun, with no explicit `<Service> API` surface, is a
 *  DOCUMENTED fail-open limitation — cheaply covered by the COVERAGE.md
 *  declaration and rare in real phase prose, which says "integrate the X API". */

/** In the `<Service> API|SDK` surface position, these capture words are NOT a
 *  named third-party service: locality/scope descriptors ("Internal API",
 *  "Public API") and bare protocol names ("REST API", "GraphQL API"). A real
 *  vendor name (Stripe, Shopify) is none of these, so rejecting them costs no
 *  true positives while killing the descriptive-prose false positives (#2365
 *  acceptance #3, review F8). */
const SURFACE_DESCRIPTOR_WORDS = new Set([
  'internal', 'external', 'public', 'private', 'local', 'in-house', 'first-party',
  'generic', 'shared', 'common', 'legacy', 'rest', 'restful', 'graphql', 'grpc',
  'soap', 'rpc', 'http', 'https', 'json', 'xml',
]);

/** Locality qualifiers that, when they immediately precede a `<Service> API`,
 *  mark it as first-party ("internal Payments API") — negative evidence for an
 *  EXTERNAL-API surface signal. Only unambiguously-internal words: "external"
 *  is deliberately absent (an external API IS external). */
const INTERNAL_DESCRIPTORS = new Set(['internal', 'in-house', 'local', 'first-party', 'private']);

/** A capitalized compound modifier ("Resolver-only", "Read-only", "E-commerce"
 *  — lowercase letter right after the hyphen) is an adjective phrase, not a
 *  service name. Real hyphenated services capitalize the second segment
 *  ("T-Mobile"). */
const COMPOUND_MODIFIER_RE = /^[A-Z][A-Za-z0-9]*-[a-z]/;

interface TermMatch {
  term: string;
  start: number;
  end: number;
}

interface LineScan {
  /** The line with path-shaped tokens replaced by same-length space padding
   *  (offsets preserved for the clause logic). */
  masked: string;
  /** Noun-vocabulary terms found inside NON-LOCAL URLs (`https://api.stripe.com`)
   *  — a URL that itself names an API surface is external-dependency evidence,
   *  so it still feeds the compound rule even though the URL is masked from
   *  plain prose matching. */
  urlNouns: TermMatch[];
}

const URL_TOKEN_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_URL_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\/(?:localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;
/** A scheme-less token that STARTS with a dotted hostname whose final label is
 *  alphabetic ("api.stripe.com/v1") — a bare external API host. A first-party
 *  route path ("src/app/api/…") has no dotted head, and an IP host ("127.1/…")
 *  has a numeric final label, so neither matches (#2365 review F2). */
const DOMAIN_HEAD_RE = /^[([<"'`]*(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?=[:/?#]|$)/i;

/** Mask whitespace-delimited tokens with an interior `/` — file paths, framework
 *  routes (`src/app/api/...`), URLs. They are references, not integration prose
 *  (#2365 root cause 2: `/` counted as a word boundary, so first-party route
 *  paths matched the noun vocabulary). Two carve-outs keep genuine signals:
 *   - a slashed token whose segments are ALL noun-vocabulary words ("API/SDK",
 *     "REST/GraphQL") is prose shorthand, not a path — left unmasked;
 *   - a non-local URL is masked, but noun terms inside it are collected as
 *     compound-rule evidence (the old detector caught "connect to
 *     https://api.stripe.com" via the `api` segment; losing that would
 *     fail-open). */
function scanLineTokens(line: string, nounRe: RegExp | null, nounSet: Set<string>): LineScan {
  const urlNouns: TermMatch[] = [];
  let masked = '';
  const tokenRe = /\S+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(line)) !== null) {
    const rawTok = m[0];
    masked += line.slice(last, m.index);
    last = m.index + rawTok.length;
    // Peel trailing clause-boundary punctuation off the token and keep it
    // LITERAL in `masked` — masking it away would erase a clause split and pair
    // unrelated verb/noun across it (#2365 review F6: "…example.com, document…").
    // A backward char scan (not a `[…]+$` regex) keeps this linear.
    let trailLen = 0;
    while (trailLen < rawTok.length && CLAUSE_BOUNDARY_CHARS.has(rawTok[rawTok.length - 1 - trailLen])) {
      trailLen++;
    }
    const trail = trailLen ? rawTok.slice(rawTok.length - trailLen) : '';
    const tok = trailLen ? rawTok.slice(0, rawTok.length - trailLen) : rawTok;
    if (!/\S[\\/]\S/.test(tok)) {
      masked += rawTok;
      continue;
    }
    const segments = tok.split(/[\\/]/).map((s) => s.replace(/[^A-Za-z0-9]/g, ''));
    if (
      segments.every((s) => s.length > 0 && (nounSet.has(s.toLowerCase()) || /^v\d+$/i.test(s))) &&
      segments.some((s) => nounSet.has(s.toLowerCase()))
    ) {
      masked += rawTok; // "API/SDK", "API/v2" — noun shorthand, not a path
      continue;
    }
    // A scheme URL or a bare external hostname is an external dependency
    // reference: mask it from prose but keep it as compound-rule evidence. A
    // first-party route path has neither a scheme nor a dotted host, so it is
    // masked WITHOUT contributing nouns (#2365 root cause 2).
    // A non-local URL that NAMES an API vocabulary word ("api.stripe.com/v1")
    // is external-dependency evidence, so its vocab nouns feed the compound
    // rule. We deliberately do NOT treat every path-bearing URL as an endpoint:
    // that fired on ordinary asset/link URLs ("…/theme.css", "…?next=/x") and
    // recreated routine UI-phase false positives (#2365 review). A bare external
    // host that names no vocabulary word ("graph.microsoft.com") and is not
    // written as "<Service> API" is therefore a DOCUMENTED fail-open limitation.
    const isSchemeUrl = URL_TOKEN_RE.test(tok) && !LOCAL_URL_RE.test(tok);
    const isDomainUrl = !URL_TOKEN_RE.test(tok) && DOMAIN_HEAD_RE.test(tok);
    if (nounRe && (isSchemeUrl || isDomainUrl)) {
      for (const f of collectTermMatches(nounRe, tok)) {
        urlNouns.push({ term: f.term, start: m.index, end: m.index + tok.length });
      }
    }
    masked += ' '.repeat(tok.length) + trail;
  }
  masked += line.slice(last);
  return { masked, urlNouns };
}

/** All term matches in a clause, with offsets. `re` must be global with the
 *  term in group 2 and a consumed leading boundary in group 1. */
function collectTermMatches(re: RegExp, clause: string): TermMatch[] {
  const out: TermMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    const start = m.index + (m[1] || '').length;
    out.push({ term: (m[2] || '').toLowerCase(), start, end: start + (m[2] || '').length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

interface ClauseSpan {
  text: string;
  start: number;
}

/** Split a line into clause segments, keeping each segment's start offset so
 *  line-level spans (masked URL tokens) can be mapped into their clause. */
function splitClauses(masked: string): ClauseSpan[] {
  const out: ClauseSpan[] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || CLAUSE_BOUNDARY_RE.test(masked[i])) {
      out.push({ text: masked.slice(start, i), start });
      start = i + 1;
    }
  }
  return out;
}

/**
 * Detect whether phase-scope prose describes integrating an external API/SDK.
 *
 * FAIL-CLOSED: it leans toward detecting, because a false positive is dismissed
 * by a one-line COVERAGE.md declaration while a false negative silently slips a
 * real external-API phase past a blocking gate. It fires when EITHER:
 *   (a) an integration VERB and an API NOUN share one CLAUSE ("integrate the
 *       Stripe API", "Connect … to api.stripe.com") — the clause boundary is the
 *       whole relationship test, so verb/noun in DIFFERENT clauses do not pair
 *       (#2365 acceptance #2). There is NO cross-clause binding: a service named
 *       only in a clause separate from its API noun is a documented limitation.
 *   (b) an explicit `<Service> API|SDK|REST|GraphQL` surface names a service
 *       that is not a stopword, a locality/protocol descriptor, a compound
 *       modifier, or first-party-qualified ("Stripe API", "Spotify SDK").
 *
 * Fenced code, inline code spans, and path-shaped tokens are excluded before
 * matching. A package-shaped inline span (`@stripe/stripe-js`, `stripe-sdk`)
 * and a URL that NAMES an API vocab word ("api.stripe.com/v1") still count as
 * noun/dependency evidence; a bare host that names none does not.
 *
 * Non-string inputs degrade to `{ detected: false }` without throwing.
 */
export function detectApiIntegration(
  text: unknown,
  terms?: Partial<ApiCoverageTermSet>,
): ApiCoverageDetectionResult {
  const effective = resolveTerms(terms);
  if (typeof text !== 'string') {
    return { detected: false, signals: [], terms: effective };
  }

  const stripped = stripFencedCode(text.replace(/\r\n/g, '\n')).text;
  if (stripped.trim().length === 0) {
    return { detected: false, signals: [], terms: effective };
  }

  const signals: ApiCoverageSignal[] = [];
  const seen = new Set<string>();
  const lines = stripped.split('\n');

  const hasCompoundTerms = effective.verbs.length > 0 && effective.nouns.length > 0;
  // Trailing boundary is a LOOKAHEAD (not consumed) so back-to-back terms
  // separated by one boundary char are both found.
  const verbRe = hasCompoundTerms
    ? new RegExp(
        '(^|[^a-zA-Z0-9])(' + effective.verbs.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)',
        'gi',
      )
    : null;
  const nounRe = hasCompoundTerms
    ? new RegExp(
        '(^|[^a-zA-Z0-9])(' + effective.nouns.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)',
        'gi',
      )
    : null;
  const surfaceRe = new RegExp(SERVICE_SURFACE_API_RE.source, 'g');

  const nounSet = new Set(effective.nouns);

  const emitPair = (vTerm: string, nTerm: string, snippetLine: string): void => {
    const key = `${vTerm}+${nTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({ verb: vTerm, noun: nTerm, snippet: makeSnippet(snippetLine, nTerm) });
  };

  for (const rawLine of lines) {
    // Inline code spans are code, not prose — mask them (length-preserving so
    // offsets keep lining up), but keep package-shaped span content as noun
    // evidence (#2365 review FN-4: `stripe-sdk` names a dependency).
    const inlineSpans = scanInlineCodeSpans(rawLine);
    let line = rawLine;
    const spanNouns: TermMatch[] = [];
    for (const s of inlineSpans) {
      line = line.slice(0, s.start) + ' '.repeat(s.end - s.start) + line.slice(s.end);
      const content = s.content.trim();
      if (content.length === 0 || /\s/.test(content)) continue;
      const segs = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (segs.length < 2) continue; // a bare `api` span is a code identifier
      const hit = segs.find((seg) => nounSet.has(seg));
      if (hit) spanNouns.push({ term: hit, start: s.start, end: s.end });
    }

    // Path-shaped tokens (routes, file names, URLs) are references, not prose.
    const { masked, urlNouns } = scanLineTokens(line, nounRe, nounSet);
    const clauses = splitClauses(masked);
    const extraNouns = urlNouns.concat(spanNouns);

    // (a) compound verb+noun — SAME CLAUSE ONLY. There is no word-gap cap (a cap
    // cannot tell a long genuine clause from a long internal one) and no
    // cross-clause binding (see the note by CLAUSE_BOUNDARY_CHARS): the clause
    // boundary is the whole relationship test. Nouns are NOT filtered on
    // "internal" qualification here — "integrate the internal API" is a
    // fail-closed positive; the declaration dismisses it if wrong.
    if (verbRe && nounRe) {
      for (const clause of clauses) {
        const verbs = collectTermMatches(verbRe, clause.text);
        if (verbs.length === 0) continue;
        const nouns = collectTermMatches(nounRe, clause.text);
        const nounTerms = new Set(nouns.map((t) => t.term));
        for (const u of extraNouns) {
          if (u.start >= clause.start && u.end <= clause.start + clause.text.length) {
            nounTerms.add(u.term);
          }
        }
        if (nounTerms.size === 0) continue;
        for (const vTerm of new Set(verbs.map((t) => t.term))) {
          for (const nTerm of nounTerms) emitPair(vTerm, nTerm, rawLine);
        }
      }
    }

    // (b) explicit <Service> API|SDK|REST|GraphQL surface — scan every candidate
    // in every clause (a rejected first candidate must not shadow a later
    // genuine service; #2365 review C-1).
    for (const clause of clauses) {
      surfaceRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = surfaceRe.exec(clause.text)) !== null) {
        const svc = m[1] || '';
        const svcLower = svc.toLowerCase();
        // Reject capitalized sentence starters ("The API"), locality/protocol
        // descriptors ("Internal API", "REST API"), compound modifiers
        // ("Resolver-only API"), and services qualified first-party
        // ("internal Payments API"). A real vendor name is none of these.
        if (SERVICE_STOPWORDS.has(svcLower)) continue;
        if (SURFACE_DESCRIPTOR_WORDS.has(svcLower)) continue;
        if (COMPOUND_MODIFIER_RE.test(svc)) continue;
        if (isInternallyQualified(masked, clause.start + m.index)) continue;
        const noun = (m[2] || '').toLowerCase();
        const key = `surface+${noun}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({ verb: '(surface)', noun, snippet: makeSnippet(rawLine, svc) });
      }
    }
  }

  return { detected: signals.length > 0, signals, terms: effective };
}


/** True when the word IMMEDIATELY ADJACENT before `offset` is a locality
 *  descriptor ("internal Payments API") — first-party qualification is negative
 *  evidence for an EXTERNAL-API signal. Only plain spaces/tabs may separate the
 *  descriptor from the service: any intervening punctuation means the descriptor
 *  belongs to a prior clause/sentence and must NOT qualify ("The cache is
 *  private. Stripe API …" — `private` is a different sentence; #2365 review).
 *  Looks back through a BOUNDED window, not the whole prefix, to stay linear. */
const QUALIFIER_LOOKBACK = 24; // longest descriptor ("first-party") + separators
function isInternallyQualified(masked: string, offset: number): boolean {
  const from = offset > QUALIFIER_LOOKBACK ? offset - QUALIFIER_LOOKBACK : 0;
  const window = masked.slice(from, offset);
  // Only whitespace and markdown emphasis/wrapper markers (`*_~\`) may separate
  // the descriptor from the service, so "The **internal** Payments API" still
  // qualifies — but NOT a clause/sentence boundary, so "…is private. Stripe API"
  // does not (the descriptor is a different sentence; #2365 review).
  const m = /([A-Za-z0-9'-]+)[\s*_~`]*$/.exec(window);
  if (!m) return false;
  // A word truncated by the window start is not a descriptor match (its real
  // start lies before the window) — fail toward detection.
  if (from > 0 && m.index === 0 && /[A-Za-z0-9'-]/.test(masked[from - 1])) return false;
  return INTERNAL_DESCRIPTORS.has(m[1].toLowerCase());
}

// ─── Coverage matrix parse / validate / render ────────────────────────────────

export type CoverageDecision = 'INTEGRATE' | 'OPT-OUT';

export interface CoverageRow {
  capability: string;
  decision: CoverageDecision;
  reason: string;
}

/** #2365 acceptance #5: a first-class "this phase integrates no external API"
 *  declaration — the legitimate alternative to fabricating a matrix row for a
 *  capability that does not exist. Like an OPT-OUT row, it must carry a
 *  reason: the declaration is a reasoned decision, not a bypass. */
export interface CoverageNoneDeclaration {
  none: true;
  reason: string;
}

export interface CoverageParseResult {
  rows: CoverageRow[];
  errors: string[];
  format: 'table' | 'json' | 'none';
  declaration: CoverageNoneDeclaration | null;
}

export interface CoverageValidationResult {
  valid: boolean;
  errors: string[];
  counts: { surface: number; integrate: number; optout: number };
  /** True when a valid no-integration declaration (and no rows) satisfied the gate. */
  none_declared?: boolean;
}

/** Matches a declaration line such as
 *  `No external API integration: <reason>` (also `**bold**` and em-dash
 *  separators). The reason is REQUIRED — a bare declaration does not parse.
 *  Deliberately NOT matched: blockquoted lines (`> No external …` is quoted
 *  text, not a declaration) and anything inside fenced code or HTML comments
 *  (both stripped before the scan; #2365 review C-3). */
const NO_INTEGRATION_DECLARATION_RE =
  /^\s*(?:\*\*)?no external api integration(?:\*\*)?\s*(?:[:—–-]|--)\s*(\S[^\n]*)$/im;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

const VALID_DECISIONS = new Set<CoverageDecision>(['INTEGRATE', 'OPT-OUT']);

/**
 * True when `cells` are a coverage-matrix header, per the canonical column set
 * registered as `TABLE_SCHEMAS.Coverage`.
 *
 * Compared case-insensitively, and ONLY against the Coverage variants: the
 * pre-#2366 check was `cells[0].toLowerCase() === 'capability'`, so a
 * hand-written `| Capability | Decision | Reason |` has always been accepted.
 * Scoping the parse to a registered schema must not silently narrow that — a
 * header that stopped being recognised would drop every row and surface as a
 * confusing "matrix is empty" block. `matchTableSchema` is exact by contract
 * (other schemas' columns are capitalised and must stay that way), hence the
 * local comparison against the registry rather than a call into it.
 */
/**
 * Test seam (#2374 review m6): exported under an underscore so
 * `tests/markdown-table.test.cjs` can assert this reader and `matchTableSchema`
 * agree on every probe, in both directions — the guard against the two
 * identification paths drifting apart again.
 */
export function _isCoverageHeader(cells: string[]): boolean {
  return isCoverageHeader(cells);
}

function isCoverageHeader(cells: string[]): boolean {
  // Resolved THROUGH the registry seam (`matchTableSchema`), not by a local walk
  // over `TABLE_SCHEMAS`: the local copy was a second identification path for one
  // registered schema, and the two had already diverged — `matchTableSchema`
  // rejected `| Capability | Decision | Reason |` while this reader accepted it
  // (#2374 review m6). The case-folding this reader needs is now an option ON the
  // seam, so there is one matcher and `tests/markdown-table.test.cjs` pins the
  // two callers to the same answer.
  const m = matchTableSchema(cells, { caseInsensitive: true });
  return m !== null && m.id === 'Coverage';
}

/**
 * A STRONG GFM delimiter row: every cell is `---`+ (optionally alignment-colon'd),
 * i.e. at least three dashes. Deliberately stricter than the shared `-{1,}`
 * `isDelimiterRow` — the coverage parser uses this only to detect a SECOND,
 * butted-on table's delimiter mid-rows, where an all-single-dash data row
 * (`| - | - | - |`) must NOT be mistaken for a delimiter and truncate the rows
 * after it (#2366 re-review). Restores the parser's pre-#2366 `-{3,}` heuristic.
 */
function isStrongDelimiterRow(cells: string[]): boolean {
  // TRIM only (not internal-whitespace strip): a real delimiter cell is contiguous
  // dashes (`---`, optionally space-padded), whereas a spaced-dash DATA cell
  // (`- - -`) must NOT collapse to `---` and be misread as a delimiter — that
  // would truncate the rows after it, the very bug this guard fixes (Codex #2366
  // re-review).
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Unwrap balanced inline emphasis/code markers that surround a WHOLE decision
 * cell, before validation.
 *
 * `**OPT-OUT**` renders identically to `OPT-OUT` in every markdown viewer, so
 * rejecting it made the failure invisible to anyone reading the file as
 * rendered output (#2366); the fragment's own example writes decisions
 * backticked (`` `INTEGRATE` ``). Only a matching pair at BOTH ends is removed
 * (repeatedly, so `` **`OPT-OUT`** `` unwraps fully) — an unbalanced or interior
 * marker is left intact, so a genuinely malformed decision like `INTEG_RATE`
 * is NOT silently massaged into the valid `INTEGRATE` and still fails loudly.
 * Applied to the decision cell only — capability names and reasons keep their
 * formatting verbatim.
 */
/**
 * Longest decision cell that is worth normalising. The decisions and their
 * formatted forms are short (`` **`OPT-OUT`** `` is 13 chars); a much longer cell
 * is malformed regardless, so it is left untouched for the enum compare to
 * reject. Bailing early also bounds the normalisation work as defense in depth.
 */
const DECISION_NORMALIZE_MAX = 64;

/**
 * Peel a single code span (`` `x` ``) off a whole cell, or return `null` if the
 * cell is not one. A code span is a leading backtick run and an equal-length
 * trailing run; per CommonMark §6.1 exactly one space is removed from each edge
 * when both edges are a space and the content is not all spaces. The content is
 * returned VERBATIM otherwise — a code span's interior is literal text, never
 * further markdown, which is why the caller must not recurse into it.
 *
 * Implemented as a deterministic edge scan, NOT a regex: `/^(`+)(.*?)(`+)$/` on a
 * long run of opening backticks with no closing run backtracks super-linearly
 * (ReDoS on the unbounded decision cell).
 */
function peelCodeSpan(s: string): string | null {
  let open = 0;
  while (open < s.length && s[open] === '`') open += 1;
  if (open === 0) return null;
  let close = 0;
  while (close < s.length && s[s.length - 1 - close] === '`') close += 1;
  // Equal-length runs, with at least one non-backtick character between them.
  if (open !== close || open + close >= s.length) return null;
  let content = s.slice(open, s.length - close);
  if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
    content = content.slice(1, -1);
  }
  return content;
}

/**
 * Normalise a decision cell by removing the markdown formatting that renders to
 * the same text, before it is validated against {INTEGRATE, OPT-OUT} (#2366).
 *
 * `**OPT-OUT**` renders identically to `OPT-OUT`, and the fragment's own example
 * backticks decisions — both must be accepted. But the normalisation must match
 * what a reader SEES, or it silently accepts decisions the author never wrote:
 *  - Emphasis (`*`, `_`, `**`, `__`) is peeled one layer at a time, and only when
 *    the marker hugs its content — a flanking space disqualifies emphasis in
 *    CommonMark, so `* OPT-OUT *` stays malformed.
 *  - A code span binds tighter than emphasis and its content is LITERAL, so it is
 *    peeled exactly once and returned as-is (no recursion). This is what keeps
 *    `` `*OPT-OUT*` `` malformed — it renders as the literal text `*OPT-OUT*`, not
 *    the enum value — and `` `  OPT-OUT  ` `` malformed (CommonMark strips only one
 *    space per edge, leaving the surrounding spaces the enum compare rejects).
 */
function stripInlineEmphasis(cell: string): string {
  let s = cell.trim();
  if (s.length > DECISION_NORMALIZE_MAX) return s;
  for (;;) {
    const code = peelCodeSpan(s);
    if (code !== null) return code;
    let peeled: string | null = null;
    for (const mark of ['**', '__', '*', '_']) {
      if (s.length <= 2 * mark.length || !s.startsWith(mark) || !s.endsWith(mark)) continue;
      const inner = s.slice(mark.length, s.length - mark.length);
      if (/^\S/.test(inner) && /\S$/.test(inner)) {
        peeled = inner;
        break;
      }
    }
    if (peeled === null) return s;
    s = peeled;
  }
}

/**
 * Parse a coverage matrix from COVERAGE.md. Accepts two bijective formats:
 *
 *  1. Markdown table (canonical, human-editable):
 *       | capability | decision | reason |
 *       |---|---|---|
 *       | search | INTEGRATE | |
 *       | playlists | OPT-OUT | not needed yet |
 *
 *  2. Fenced ```coverage JSON block (machine-generated):
 *       ```coverage
 *       [ {"capability":"search","decision":"INTEGRATE","reason":""}, ... ]
 *       ```
 *
 * Rows are trimmed; decisions upper-cased; missing reason → "". Returns
 * `{ rows: [], errors: [], format: 'none' }` for empty/non-matrix input.
 */
export function parseCoverageMatrix(text: unknown): CoverageParseResult {
  const out: CoverageParseResult = { rows: [], errors: [], format: 'none', declaration: null };
  if (typeof text !== 'string') return out;
  const src = text.replace(/\r\n/g, '\n');

  // #2365 acceptance #5: a "no external API integration" declaration. Scanned
  // on fence-stripped, comment-stripped text so an example inside a code block
  // or an HTML comment does not count.
  const declMatch = NO_INTEGRATION_DECLARATION_RE.exec(
    stripFencedCode(src).text.replace(HTML_COMMENT_RE, ''),
  );
  if (declMatch) {
    out.declaration = { none: true, reason: (declMatch[1] || '').trim() };
  }

  // (1) fenced ```coverage JSON block takes precedence if present.
  // Case-insensitive info string (```coverage and ```Coverage are both legal CommonMark).
  const fenceBody = extractFencedBlock(src, 'coverage');
  if (fenceBody) {
    out.format = 'json';
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenceBody);
    } catch {
      out.errors.push('fenced ```coverage block is not valid JSON');
      return out;
    }
    if (!Array.isArray(parsed)) {
      out.errors.push('fenced ```coverage block must be a JSON array');
      return out;
    }
    for (let i = 0; i < parsed.length; i++) {
      const row = rowFromJson(parsed[i]);
      if ('error' in row) {
        out.errors.push(`row[${i}]: ${row.error}`);
        continue;
      }
      out.rows.push(row);
    }
    return out;
  }

  // (2) markdown table — rows are read ONLY from inside a Coverage-schema table.
  // A COVERAGE.md legitimately carries other tables (a summary of counts, a
  // threat table). Scanning every `|` line file-wide let a foreign table whose
  // 2nd cell happened to read INTEGRATE/OPT-OUT be pushed as a capability row
  // with no error, so the gate reported success over an invented capability
  // (#2366). Table identity comes from the shared TABLE_SCHEMAS registry, the
  // same seam the roadmap/requirements/quick-task/security tables resolve
  // through (ADR-2143 §3 — a table is identified by its registered header,
  // never by position).
  // A coverage table is a well-formed GFM table: a canonical header, then a
  // delimiter row, then contiguous data rows until a blank/non-piped line. This
  // is a 3-state walk rather than a single `inMatrix` latch so the structure is
  // actually enforced — a header with no delimiter, or a stray second delimiter
  // inside the data rows, is a LOUD error (ADR-2143 §3 fail-loud), never a shape
  // that silently absorbs a neighbouring table's rows.
  // `seeking`         — outside any table.
  // `expectDelimiter` — a canonical Coverage header awaits its delimiter row.
  // `inRows`          — inside the Coverage table's data rows.
  // `foreignHeader?`  — a piped line that is NOT a Coverage header: either some
  //                     other table's header (a delimiter follows) or a LOOSE
  //                     row. Undecided until the next line.
  // `foreignRows`     — inside a confirmed non-Coverage table (a summary of
  //                     counts, a threat table): its rows are correctly ignored.
  // `looseRows`       — a run of piped lines belonging to NO table.
  //
  // The last two exist to answer a question `seeking` alone could not (#2374
  // review B1): a piped line outside the Coverage table was skipped by a bare
  // `continue`, so a matrix split by a blank line, a prose line, or an HTML
  // comment silently lost every row after the split — with zero errors, while
  // `validateCoverageMatrix` still sealed it `valid: true`. It cannot simply be
  // an error either: a COVERAGE.md legitimately carries other tables, and a
  // summary header like `| tier | INTEGRATE | OPT-OUT |` is coverage-SHAPED.
  // Distinguishing "row inside another table" from "row inside no table" is what
  // makes the loud error safe.
  type MatrixState =
    | 'seeking'
    | 'expectDelimiter'
    | 'inRows'
    | 'foreignHeader?'
    | 'foreignRows'
    | 'looseRows';
  const lines = src.split('\n');
  // Fenced code (```/~~~) delimits a worked EXAMPLE, not data — the project's own
  // api-coverage-plan-pre.md fragment writes a canonical-shaped table inside a
  // fence. Mark every fenced line (delimiters + content) so the scan treats it as
  // a table-terminating non-pipe line: a fenced example is never parsed as rows.
  // The mask is built from `scanFencedBlocks` — the SAME CommonMark engine
  // stripFencedCode/extractFencedBlock use (correct delimiter char/run-length and
  // valid-closer tracking, so a ``` inside a ~~~ fence, a 4-backtick opener, or an
  // indented fence do not desync) — and applied IN PLACE so line adjacency is
  // preserved. Pre-STRIPPING the lines instead would splice a header to a
  // delimiter that a fence separated and fabricate a phantom table (Codex #2366
  // re-review). An unterminated fence (closeLineIdx -1) masks to EOF.
  const fenced: boolean[] = lines.map(() => false);
  for (const b of scanFencedBlocks(lines)) {
    const end = b.closeLineIdx === -1 ? lines.length - 1 : b.closeLineIdx;
    for (let i = b.openLineIdx; i <= end; i++) fenced[i] = true;
    // An unterminated fence masks every line after it, so a matrix below one
    // vanishes and the author is told the matrix is "empty" — a true statement
    // about a wrong cause (#2374 review m4). `scanFencedBlocks` already knows,
    // so name the real problem and its line.
    if (b.closeLineIdx === -1) {
      out.errors.push(
        `fence: unterminated code fence opened at line ${b.openLineIdx + 1} `
        + '— everything after it is treated as example text, not coverage rows',
      );
    }
  }
  let state: MatrixState = 'seeking';
  let headerCols = 0;
  // A canonical header that never received its delimiter row (the section ends at
  // a blank line, EOF, a short row, or the next header) is not a real table —
  // surface it rather than dropping it silently, which would let an orphan header
  // pass the gate once an earlier section already supplied rows.
  // A piped line held while we wait to learn whether it was a foreign table's
  // header or a loose row.
  let heldRow: string[] | null = null;
  // A loose row that is coverage-SHAPED (`| capability | decision | reason |`
  // with a decision in {INTEGRATE, OPT-OUT}) is a matrix row that fell outside
  // its table — the B1 silent-drop. Report it loudly and name it, so the author
  // is pointed at the split rather than at a mysteriously short matrix. A loose
  // row of any other shape is unrelated markdown and stays ignored.
  const reportLooseRow = (cells: string[]): void => {
    // 3 cells is the canonical width, but a WIDER loose row is reported too
    // (#2374 review n1): a row is most often wide because an unescaped `|` in
    // the reason split it, and a mangled row outside the table is exactly the
    // case the author needs told about. Silently ignoring it while reporting its
    // 3-cell sibling was inconsistent with the fail-loud posture of this rewrite.
    // Narrower rows stay ignored — with fewer than 3 cells there is no decision
    // column to key on, so anything matched would be a guess.
    if (cells.length < 3) return;
    const decision = stripInlineEmphasis(cells[1] || '').toUpperCase();
    if (!VALID_DECISIONS.has(decision as CoverageDecision)) return;
    const width = cells.length === 3
      ? ''
      : ` and has ${cells.length} columns (expected 3 — an unescaped "|" splits a cell)`;
    out.errors.push(
      `row: coverage row ${JSON.stringify(cells[0] || '')} appears outside a coverage table `
      + `(a blank line, comment, or prose line split the matrix)${width}`,
    );
  };
  // A confirmed non-Coverage table whose header is clearly TRYING to be the
  // matrix — an extra column (`| capability | decision | reason | notes |`) or a
  // reordered one — is reported by name. Scoping the parse to the registered
  // schema made these tables invisible, so the author saw "matrix is empty" (or
  // nothing at all) instead of a message about the header they actually wrote
  // (#2374 review M2). Requiring BOTH canonical anchors keeps it off genuinely
  // unrelated tables (`| tier | INTEGRATE | OPT-OUT |`, `| threat | posture | note |`).
  const reportNearMissHeader = (cells: string[]): void => {
    const lower = cells.map((c) => c.toLowerCase().trim());
    if (!lower.includes('capability') || !lower.includes('decision')) return;
    out.errors.push(
      `table: found a table headed ${JSON.stringify(cells.join(' | '))} — not the canonical `
      + 'Coverage schema (capability | decision | reason); its rows are not read',
    );
  };
  const flushPending = (): void => {
    if (state === 'expectDelimiter') {
      out.errors.push('row: coverage header is not followed by a delimiter row');
    }
    // A held line that never got a delimiter was never a header — it was a
    // loose row (the single-row split case, and the end-of-file case).
    if (heldRow !== null) {
      reportLooseRow(heldRow);
      heldRow = null;
    }
  };
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    // A fenced line (a code-block delimiter or its content) ends the current
    // table and is never read as a row.
    if (fenced[lineIdx]) {
      flushPending();
      state = 'seeking';
      continue;
    }
    // A GFM table cannot contain a non-piped line: the first one ends the table.
    if (!trimmed.startsWith('|')) {
      flushPending();
      state = 'seeking';
      continue;
    }
    // CommonMark §4.4: four spaces (or a tab) of indent OUTSIDE a paragraph is
    // an indented CODE BLOCK, so a pipe-shaped line there is sample text, not a
    // row. Scoped to the states outside the matrix on purpose: an indented
    // pipe line while `inRows` is a lazy continuation of the open table and is
    // still parsed as a row, exactly as before.
    //
    // Without this, an unfenced worked example — the shape an author writes when
    // showing the format inline — is held as a loose row and BLOCKS a
    // well-formed COVERAGE.md (Codex round-4 blocker on the B1 fix; reproduced:
    // `    | example | INTEGRATE | shown only as code |` under a valid matrix
    // sealed `valid: false`). The B1 error exists to stop rows going missing; it
    // must never invent a failure on a file whose matrix is complete.
    if ((state === 'seeking' || state === 'foreignHeader?' || state === 'foreignRows' || state === 'looseRows')
      && /^(?: {4}|\t)/.test(line)) {
      flushPending();
      state = 'seeking';
      continue;
    }
    const cells = splitTableRow(line);
    if (isCoverageHeader(cells)) {
      // Every canonical header opens a new matrix section — the previous latch
      // permitted exactly one per file, so a phase that sectioned its matrix
      // ("this phase" / "transferred to 8.1") had its 2nd header parsed as a
      // data row and rejected as decision "DECISION". A prior header still
      // awaiting its delimiter is abandoned here, so flush it first.
      flushPending();
      state = 'expectDelimiter';
      headerCols = cells.length;
      out.format = 'table';
      continue;
    }
    // A piped line outside the Coverage table. Hold it for one line: if a
    // delimiter follows it was some other table's header (`foreignRows` — its
    // rows are legitimately ignored); otherwise it belongs to no table and the
    // run is loose rows, each of which is checked for the B1 split shape.
    if (state === 'seeking') {
      heldRow = cells;
      state = 'foreignHeader?';
      continue;
    }
    if (state === 'foreignHeader?') {
      if (isDelimiterRow(cells)) {
        if (heldRow !== null) reportNearMissHeader(heldRow);
        heldRow = null;
        state = 'foreignRows';
      } else {
        if (heldRow !== null) reportLooseRow(heldRow);
        heldRow = null;
        reportLooseRow(cells);
        state = 'looseRows';
      }
      continue;
    }
    // Rows of a confirmed non-Coverage table are ignored (that scoping IS the
    // #2366 fix); every row of a table-less run is a B1 candidate.
    if (state === 'foreignRows') continue;
    if (state === 'looseRows') {
      reportLooseRow(cells);
      continue;
    }
    if (state === 'expectDelimiter') {
      // GFM requires the delimiter row immediately after the header, with the
      // same column count. Its absence (or a mismatched width) means the header
      // did not open a real table; surface it rather than reading the following
      // lines as data (a header with no delimiter used to parse its data rows
      // anyway, then pass the gate).
      if (!isDelimiterRow(cells)) {
        out.errors.push('row: coverage header is not followed by a delimiter row');
        state = 'seeking';
      } else if (cells.length !== headerCols) {
        out.errors.push(
          `row: delimiter row has ${cells.length} columns, expected ${headerCols}`,
        );
        state = 'seeking';
      } else {
        state = 'inRows';
      }
      continue;
    }
    // state === 'inRows'
    // A SECOND delimiter here means a distinct/adjacent table butted on with no
    // blank line; absorbing its rows would re-open the silent-corruption path
    // #2366 closes. Detect that with a STRONG delimiter (`-{3,}`, the parser's
    // pre-#2366 heuristic) rather than the shared GFM `isDelimiterRow` (`-{1,}`):
    // a real table delimiter is `|---|`, whereas an all-single-dash data row
    // (`| - | - | - |`) is NOT a delimiter — treating it as one would misreport
    // the row and TRUNCATE every row after it in the section (trek-e review). A
    // single-dash row instead falls through to the width/decision checks below
    // and is rejected precisely, without dropping its successors.
    if (isStrongDelimiterRow(cells)) {
      out.errors.push('row: unexpected delimiter row inside the coverage table');
      state = 'seeking';
      continue;
    }
    // A wholly-empty row (`| | | |`) is a blank separator, not data — skip it
    // silently, matching the parser's long-standing tolerance for a trailing
    // blank pipe row.
    if (cells.every((c) => c === '')) continue;
    // A coverage row must be as wide as the header that opened its table. Any
    // other width is malformed — a missing cell, or an unescaped pipe that split
    // a value. Surface it LOUDLY: a short or wide row must never be silently
    // skipped or truncate the rows that follow it.
    //
    // Width comes from `headerCols` (captured when the header matched) rather
    // than a literal 3: every registered `Coverage` variant is 3 columns today,
    // so this is identical now — but a hardcoded 3 would silently reject every
    // row of a second variant the moment one is registered, which is the whole
    // point of resolving table identity through the schema registry (#2374
    // review m5).
    if (cells.length !== headerCols) {
      out.errors.push(
        `row: ${cells.length} columns (expected ${headerCols}: capability | decision | reason)`,
      );
      continue;
    }
    const decisionCell = stripInlineEmphasis(cells[1] || '').toUpperCase();
    if (!VALID_DECISIONS.has(decisionCell as CoverageDecision)) {
      out.errors.push(`row: decision "${decisionCell}" not in {INTEGRATE, OPT-OUT}`);
      continue;
    }
    out.rows.push({
      capability: cells[0] || '',
      decision: decisionCell as CoverageDecision,
      reason: (cells[2] ?? '').trim(),
    });
  }
  // A header on the final line, with the file ending before its delimiter.
  flushPending();
  return out;
}

function rowFromJson(v: unknown): CoverageRow | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'not an object' };
  const o = v as Record<string, unknown>;
  const capability = typeof o['capability'] === 'string' ? o['capability'].trim() : '';
  if (!capability) return { error: 'missing/empty "capability"' };
  const dRaw = typeof o['decision'] === 'string' ? o['decision'].trim().toUpperCase() : '';
  if (!VALID_DECISIONS.has(dRaw as CoverageDecision)) {
    return { error: `decision "${dRaw}" not in {INTEGRATE, OPT-OUT}` };
  }
  const reason = typeof o['reason'] === 'string' ? o['reason'].trim() : '';
  return { capability, decision: dRaw as CoverageDecision, reason };
}

/**
 * Validate a parsed matrix. A matrix is valid when:
 *   - it is non-empty (acceptance #1: "enumerating the API surface"),
 *   - every capability name is non-empty,
 *   - every decision is INTEGRATE or OPT-OUT (enforced by parser, re-checked
 *     here for defense-in-depth),
 *   - every OPT-OUT row carries a non-empty reason (acceptance #2).
 *
 * Un-enumerated remainder is not representable in the format — the gate blocks
 * when an integration is detected and NO matrix exists. This validator catches
 * a malformed/partial matrix that does exist.
 */
export function validateCoverageMatrix(text: unknown): CoverageValidationResult {
  const parsed = parseCoverageMatrix(text);
  const errors = [...parsed.errors];
  const rows = parsed.rows;
  // The JSON-fence path carries RAW author content (no GFM escaping), so a `|`
  // there is still rejected; a `|` from the table path arrived as a correct
  // `\|` escape and is legitimate (#2374 review m7).
  const rawPipesRejected = parsed.format === 'json';

  // #2365 acceptance #5: a reasoned no-integration declaration with no rows
  // satisfies the gate. A declaration ALONGSIDE rows is contradictory — the
  // file must say one thing.
  if (parsed.declaration) {
    if (rows.length > 0) {
      errors.push(
        'declares "no external API integration" but also contains coverage rows — remove the declaration or the rows',
      );
    } else {
      if (parsed.declaration.reason.length > REASON_MAX_LEN) {
        errors.push(`declaration reason exceeds ${REASON_MAX_LEN} chars`);
      }
      const valid = errors.length === 0;
      return {
        valid,
        errors,
        counts: { surface: 0, integrate: 0, optout: 0 },
        none_declared: valid,
      };
    }
  }

  if (rows.length === 0) {
    if (errors.length === 0) errors.push('matrix is empty — no capabilities enumerated');
    return { valid: false, errors, counts: { surface: 0, integrate: 0, optout: 0 } };
  }

  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.capability) {
      errors.push(`row[${i}]: empty capability name`);
    } else {
      // Format contract + prompt-injection bound: cell values must be short and
      // single-line (the matrix is a markdown table whose content flows into the
      // gate message, so a newline could inject unbounded text into the seal
      // message; length is bounded below).
      //
      // A literal `|` from the TABLE path is NOT rejected (#2374 review m7): it
      // normally reaches here only from a correctly GFM-escaped `\|`, so
      // rejecting it blamed the author for writing the table right.
      // `renderCoverageMatrix` escapes on the way back out through the shared
      // `escapeCell`, so the round-trip stays bijective either way.
      //
      // Precisely: `splitTableRow`'s split guard is a single-character lookbehind
      // (`(?<!\\)\|`, markdown-table.cts), so it also keeps a pipe preceded by an
      // ESCAPED backslash (`a\\\\|b`) in one cell, where GFM would treat that pipe
      // as a real column break. That pre-existing seam imprecision is reported
      // separately rather than fixed here (it is shared by every table reader);
      // its only effect on this path is that such a cell is accepted instead of
      // rejected, and it still renders and re-parses losslessly.
      //
      // A raw `|` from the JSON-fence path is still rejected: that is a
      // deliberate hardening decision from an earlier review round (unescaped
      // author content, not correct GFM), and this fix has no mandate to
      // reverse it.
      if (/[\n\r]/.test(row.capability) || (rawPipesRejected && row.capability.includes('|'))) {
        errors.push(`row[${i}]: capability contains a newline or unescaped pipe (unsupported in a table cell)`);
      }
      if (row.capability.length > CAPABILITY_MAX_LEN) {
        errors.push(`row[${i}]: capability exceeds ${CAPABILITY_MAX_LEN} chars`);
      }
    }
    if (row.reason && (/[\n\r]/.test(row.reason) || (rawPipesRejected && row.reason.includes('|')))) {
      errors.push(`row[${i}]: reason contains a newline or unescaped pipe (unsupported in a table cell)`);
    }
    if (row.reason.length > REASON_MAX_LEN) {
      errors.push(`row[${i}]: reason exceeds ${REASON_MAX_LEN} chars`);
    }
    const key = row.capability.toLowerCase();
    if (key && seen.has(key)) errors.push(`row[${i}]: duplicate capability`);
    if (key) seen.add(key);
    if (!VALID_DECISIONS.has(row.decision)) {
      errors.push(`row[${i}]: decision not in {INTEGRATE, OPT-OUT}`);
    }
    if (row.decision === 'OPT-OUT' && !row.reason) {
      errors.push(`row[${i}]: OPT-OUT missing reason`);
    }
  }

  const counts = {
    surface: rows.length,
    integrate: rows.filter((r) => r.decision === 'INTEGRATE').length,
    optout: rows.filter((r) => r.decision === 'OPT-OUT').length,
  };

  return { valid: errors.length === 0, errors, counts };
}

/** Render rows back to the canonical markdown-table format (bijective with parse). */
export function renderCoverageMatrix(rows: readonly CoverageRow[]): string {
  // Cells are escaped through the shared `escapeCell` (the exact inverse of
  // `splitTableRow`'s unescaping), so a reason legitimately containing a `|`
  // round-trips instead of rendering a corrupt table (#2374 review m7).
  const body = rows
    .map((r) => `| ${escapeCell(r.capability)} | ${r.decision} | ${escapeCell(r.reason)} |`)
    .join('\n');
  return `| capability | decision | reason |\n|---|---|---|\n${body}`;
}

// ── CLI entry point ──────────────────────────────────────────────────────────
// Reads phase-scope text from STDIN (not argv) to avoid OS ARG_MAX limits.
// Invoked by workflow bash as: echo "$SCOPE" | node .../api-coverage.cjs [--json]
// Exit 0 = integration detected, 1 = none, 2 = startup error. Mirrors
// assumption-delta.cjs / ui-safety-gate.cjs.

if (require.main === module) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');

  let termsOverride: Partial<ApiCoverageTermSet> | undefined;
  const verbsIdx = argv.indexOf('--verbs');
  const verbsVal = verbsIdx !== -1 ? argv[verbsIdx + 1] : undefined;
  const nounsIdx = argv.indexOf('--nouns');
  const nounsVal = nounsIdx !== -1 ? argv[nounsIdx + 1] : undefined;
  // A non-empty, non-flag value is an override. An EMPTY value ("") restores
  // the curated defaults (does NOT silently zero the vocabulary).
  const verbsOverride = typeof verbsVal === 'string' && verbsVal.length > 0 && !verbsVal.startsWith('-');
  const nounsOverride = typeof nounsVal === 'string' && nounsVal.length > 0 && !nounsVal.startsWith('-');
  if (verbsOverride || nounsOverride) {
    termsOverride = {};
    if (verbsOverride) {
      termsOverride.verbs = verbsVal.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
    if (nounsOverride) {
      termsOverride.nouns = nounsVal.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }

  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = chunks.join('');
    const result = detectApiIntegration(input, termsOverride);
    if (wantJson) {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    process.exit(result.detected ? 0 : 1);
  });
  process.stdin.on('error', (err: Error) => {
    process.stderr.write(`ERROR: api-coverage.cjs stdin read failed: ${err.message}\n`);
    process.exit(2);
  });
}

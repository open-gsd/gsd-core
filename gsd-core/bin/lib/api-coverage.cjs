"use strict";
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
 *    CLAUSE within a bounded word gap (#2365 — same-line co-occurrence alone
 *    over-fired), or an explicit "<Service> API/SDK" phrase in proper-noun
 *    position. Single weak tokens do not fire. This is the issue's "low
 *    false-positive trigger" made mechanical.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_API_COVERAGE_TERMS = void 0;
exports.detectApiIntegration = detectApiIntegration;
exports.parseCoverageMatrix = parseCoverageMatrix;
exports.validateCoverageMatrix = validateCoverageMatrix;
exports.renderCoverageMatrix = renderCoverageMatrix;
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
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
exports.DEFAULT_API_COVERAGE_TERMS = {
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
function normalizeTerms(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string')
            continue;
        const t = raw.trim().toLowerCase().slice(0, MAX_TERM_LEN);
        if (!t || !/[a-z0-9]/.test(t))
            continue;
        if (seen.has(t))
            continue;
        seen.add(t);
        out.push(t);
        if (out.length >= MAX_TERMS_PER_KIND)
            break;
    }
    return out;
}
function resolveTerms(terms) {
    const merge = (key) => {
        const t = terms && terms[key];
        return Array.isArray(t) ? normalizeTerms(t) : [...exports.DEFAULT_API_COVERAGE_TERMS[key]];
    };
    return { verbs: merge('verbs'), nouns: merge('nouns') };
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function makeSnippet(line, anchor) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= 120)
        return cleaned;
    const idx = cleaned.toLowerCase().indexOf(anchor);
    if (idx < 0)
        return cleaned.slice(0, 120);
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
const SERVICE_SURFACE_API_RE = /\b([A-Z][A-Za-z0-9_-]{1,})\s+(API|SDK|REST|GraphQL)\b/;
const SERVICE_STOPWORDS = new Set([
    'the', 'an', 'a', 'our', 'this', 'these', 'that', 'those', 'new', 'add',
    'use', 'your', 'my', 'no', 'some', 'any', 'all', 'each', 'every', 'both',
    'if', 'when', 'while', 'with', 'via', 'using', 'into', 'its', 'their',
    'we', 'you', 'they', 'it',
]);
/** #2365 refinements — the three false-positive classes the detector must not
 *  fire on (first-party route paths, unrelated same-line clauses, descriptive
 *  "<Word> API" prose) while the true-positive path stays intact.
 *
 *  CLAUSE_BOUNDARY_RE: a verb and a noun form ONE compound action only inside
 *  one grammatical clause — sentence punctuation and table-cell walls (`|`)
 *  end a clause. `-` is deliberately absent (it would split hyphenated words).
 *
 *  MAX_COMPOUND_WORD_GAP: even inside one clause, a verb and a noun with many
 *  words between them describe different things. Genuine single-clause
 *  integration prose runs long ("Connect our checkout to Stripe's hosted
 *  payment processing service through its v1 endpoints" — 11 words between);
 *  12 keeps that while still rejecting essay-length lines.
 *
 *  MAX_CROSS_CLAUSE_WORD_GAP: a verb may bind a noun in the IMMEDIATELY
 *  FOLLOWING clause ("Integrate Stripe, exposing its endpoints …") — but only
 *  when the verb's own clause names a service object (a capitalized
 *  non-stopword after the verb), and only within a tight gap. Without the
 *  service-object requirement this would re-admit the "unrelated clauses"
 *  false-positive class (#2365 acceptance #2). */
const CLAUSE_BOUNDARY_RE = /[,;:.!?|()—–]/;
const MAX_COMPOUND_WORD_GAP = 12;
const MAX_CROSS_CLAUSE_WORD_GAP = 6;
/** Locality descriptors — a noun/service qualified as first-party is the
 *  opposite of external-API evidence ("the internal endpoint", "internal
 *  Payments API"). Bounded by design: locality words, not English glue. */
const INTERNAL_DESCRIPTORS = new Set(['internal', 'in-house', 'local', 'first-party']);
/** Object words that corroborate a clause-initial `<Service> API|SDK` as an
 *  integration surface ("Stripe API client for payments." as a whole scope
 *  line): the follower names the thing being built against the surface. */
const SURFACE_OBJECT_FOLLOWERS = new Set([
    'client', 'clients', 'integration', 'wrapper', 'adapter', 'connector', 'bindings',
]);
/** A capitalized compound modifier ("Resolver-only", "Read-only", "E-commerce"
 *  — lowercase letter right after the hyphen) is an adjective phrase, not a
 *  service name. Real hyphenated services capitalize the second segment
 *  ("T-Mobile"). */
const COMPOUND_MODIFIER_RE = /^[A-Z][A-Za-z0-9]*-[a-z]/;
/** Dependency evidence that corroborates a clause-initial `<Word> API` match:
 *  clause-initial capitalization is ordinary English (any sentence starter),
 *  so alone it is not proper-noun evidence — but an actual external address or
 *  package reference on the same line is. */
const SERVICE_CORROBORATION_RES = [
    /\b[a-z][a-z0-9+.-]*:\/\/\S/i,
    /(?:^|[\s`("'])@[a-z0-9][\w.-]*\/[a-z0-9]/i,
    /\b(?:npm|pnpm|yarn|pip|pipx|uv|cargo|gem|composer|go)\s+(?:install|add|get|i)\b/i,
];
function hasDependencyEvidence(line) {
    return SERVICE_CORROBORATION_RES.some((re) => re.test(line));
}
const URL_TOKEN_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_URL_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\/(?:localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;
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
function scanLineTokens(line, nounRe, nounSet) {
    const urlNouns = [];
    let masked = '';
    const tokenRe = /\S+/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(line)) !== null) {
        const tok = m[0];
        masked += line.slice(last, m.index);
        last = m.index + tok.length;
        if (!/\S[\\/]\S/.test(tok)) {
            masked += tok;
            continue;
        }
        const segments = tok.split(/[\\/]/).map((s) => s.replace(/[^A-Za-z0-9]/g, ''));
        if (segments.every((s) => s.length > 0 && (nounSet.has(s.toLowerCase()) || /^v\d+$/i.test(s))) &&
            segments.some((s) => nounSet.has(s.toLowerCase()))) {
            masked += tok; // "API/SDK", "API/v2" — noun shorthand, not a path
            continue;
        }
        if (nounRe && URL_TOKEN_RE.test(tok) && !LOCAL_URL_RE.test(tok)) {
            const found = collectTermMatches(nounRe, tok);
            for (const f of found) {
                urlNouns.push({ term: f.term, start: m.index, end: m.index + tok.length });
            }
        }
        masked += ' '.repeat(tok.length);
    }
    masked += line.slice(last);
    return { masked, urlNouns };
}
/** All term matches in a clause, with offsets. `re` must be global with the
 *  term in group 2 and a consumed leading boundary in group 1. */
function collectTermMatches(re, clause) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clause)) !== null) {
        const start = m.index + (m[1] || '').length;
        out.push({ term: (m[2] || '').toLowerCase(), start, end: start + (m[2] || '').length });
        if (m[0].length === 0)
            re.lastIndex++;
    }
    return out;
}
/** Start offsets of every whitespace-delimited word in `line`. Computed ONCE
 *  per line so each verb/noun pair costs O(log W), not a fresh substring split
 *  — a hostile line repeating a term pair thousands of times must not go
 *  quadratic (#2365 review S-2). */
function computeWordStarts(line) {
    const starts = [];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
        const ws = line[i] === ' ' || line[i] === '\t';
        if (!ws && !inWord)
            starts.push(i);
        inWord = !ws;
    }
    return starts;
}
/** Ordinal (word index) of the word containing/preceding `offset`. */
function wordOrdinalAt(wordStarts, offset) {
    let lo = 0;
    let hi = wordStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (wordStarts[mid] <= offset) {
            ans = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return ans;
}
function groupByTerm(matches, wordStarts) {
    const out = new Map();
    for (const t of matches) {
        const ord = [
            wordOrdinalAt(wordStarts, t.start),
            wordOrdinalAt(wordStarts, Math.max(t.end - 1, t.start)),
        ];
        const g = out.get(t.term);
        if (g) {
            g.ords.push(ord);
            if (t.start < g.first.start)
                g.first = t;
        }
        else {
            out.set(t.term, { ords: [ord], first: t });
        }
    }
    for (const g of out.values())
        g.ords.sort((x, y) => x[0] - y[0]);
    return out;
}
/** Smallest whole-word gap between any match of `a` and any match of `b` —
 *  a linear merge walk over the two position-sorted ordinal lists. */
function minWordGap(a, b) {
    let best = Infinity;
    let j = 0;
    for (const [as, ae] of a.ords) {
        while (j < b.ords.length && b.ords[j][0] < as)
            j++;
        if (j < b.ords.length) {
            const gap = b.ords[j][0] - ae - 1;
            best = Math.min(best, gap > 0 ? gap : 0);
        }
        if (j > 0) {
            const gap = as - b.ords[j - 1][1] - 1;
            best = Math.min(best, gap > 0 ? gap : 0);
        }
        if (best === 0)
            break;
    }
    return best;
}
/** Split a line into clause segments, keeping each segment's start offset so
 *  line-level spans (masked URL tokens) can be mapped into their clause. */
function splitClauses(masked) {
    const out = [];
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
 * Fires when EITHER:
 *   (a) a compound verb+noun signal shares one CLAUSE of a line within a
 *       bounded word gap (#2365 — co-occurrence anywhere on a line is not a
 *       compound action), or the verb's clause names a service object and the
 *       noun sits in the immediately following clause ("Integrate Stripe,
 *       exposing its endpoints …"), OR
 *   (b) an explicit `<Service> API|SDK|REST|GraphQL` surface appears in
 *       proper-noun position (mid-clause), or clause-initial WITH dependency
 *       evidence (a URL / package reference) or an integration-object follower
 *       ("Stripe API client …") on the same line.
 *
 * Fenced code blocks, inline code spans, and path-shaped tokens are excluded
 * before matching — code and file references are not integration prose. A
 * package-shaped inline span (`@stripe/stripe-js`, `stripe-sdk`) still counts
 * as dependency/noun evidence. Nouns qualified as first-party ("the internal
 * endpoint") are negative evidence and never pair.
 *
 * Non-string inputs degrade to `{ detected: false }` without throwing.
 */
function detectApiIntegration(text, terms) {
    const effective = resolveTerms(terms);
    if (typeof text !== 'string') {
        return { detected: false, signals: [], terms: effective };
    }
    const stripped = (0, markdown_sectionizer_cjs_1.stripFencedCode)(text.replace(/\r\n/g, '\n')).text;
    if (stripped.trim().length === 0) {
        return { detected: false, signals: [], terms: effective };
    }
    const signals = [];
    const seen = new Set();
    const lines = stripped.split('\n');
    const hasCompoundTerms = effective.verbs.length > 0 && effective.nouns.length > 0;
    // Trailing boundary is a LOOKAHEAD (not consumed) so back-to-back terms
    // separated by one boundary char are both found.
    const verbRe = hasCompoundTerms
        ? new RegExp('(^|[^a-zA-Z0-9])(' + effective.verbs.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)', 'gi')
        : null;
    const nounRe = hasCompoundTerms
        ? new RegExp('(^|[^a-zA-Z0-9])(' + effective.nouns.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)', 'gi')
        : null;
    const surfaceRe = new RegExp(SERVICE_SURFACE_API_RE.source, 'g');
    const nounSet = new Set(effective.nouns);
    for (const rawLine of lines) {
        // Inline code spans are code, not prose — mask them (length-preserving so
        // offsets keep lining up), but keep package-shaped span content as noun
        // evidence (#2365 review FN-4: `stripe-sdk` names a dependency).
        const inlineSpans = (0, markdown_sectionizer_cjs_1.scanInlineCodeSpans)(rawLine);
        let line = rawLine;
        const spanNouns = [];
        for (const s of inlineSpans) {
            line = line.slice(0, s.start) + ' '.repeat(s.end - s.start) + line.slice(s.end);
            const content = s.content.trim();
            if (content.length === 0 || /\s/.test(content))
                continue;
            const segs = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            if (segs.length < 2)
                continue; // a bare `api` span is a code identifier
            const hit = segs.find((seg) => nounSet.has(seg));
            if (hit)
                spanNouns.push({ term: hit, start: s.start, end: s.end });
        }
        // Path-shaped tokens (routes, file names, URLs) are references, not prose.
        const { masked, urlNouns } = scanLineTokens(line, nounRe, nounSet);
        const clauses = splitClauses(masked);
        const wordStarts = computeWordStarts(masked);
        const extraNouns = urlNouns.concat(spanNouns);
        // (a) compound verb+noun: same clause (bounded gap), or verb clause with a
        // service object binding a noun in the immediately following clause.
        if (verbRe && nounRe) {
            const clauseVerbs = [];
            const clauseNouns = [];
            for (let ci = 0; ci < clauses.length; ci++) {
                const clause = clauses[ci];
                // Line-level offsets throughout so one wordStarts array serves all pairs.
                const verbs = collectTermMatches(verbRe, clause.text).map((t) => ({
                    term: t.term,
                    start: t.start + clause.start,
                    end: t.end + clause.start,
                }));
                const nouns = collectTermMatches(nounRe, clause.text)
                    .map((t) => ({ term: t.term, start: t.start + clause.start, end: t.end + clause.start }))
                    .filter((t) => !isInternallyQualified(masked, t.start));
                for (const u of extraNouns) {
                    if (u.start >= clause.start && u.end <= clause.start + clause.text.length) {
                        nouns.push(u);
                    }
                }
                clauseVerbs.push(verbs);
                clauseNouns.push(nouns);
            }
            // Pairing is by TERM GROUP with a nearest-pair merge walk, not a match×
            // match cross product — a hostile line repeating one pair thousands of
            // times stays linear (#2365 review S-2).
            for (let ci = 0; ci < clauses.length; ci++) {
                const verbGroups = groupByTerm(clauseVerbs[ci], wordStarts);
                if (verbGroups.size === 0)
                    continue;
                const sameGroups = groupByTerm(clauseNouns[ci], wordStarts);
                const crossGroups = ci + 1 < clauses.length && clauseNouns[ci + 1].length > 0
                    ? groupByTerm(clauseNouns[ci + 1], wordStarts)
                    : null;
                for (const [vTerm, vGroup] of verbGroups) {
                    const tryPair = (nTerm, nGroup, cap) => {
                        const key = `${vTerm}+${nTerm}`;
                        if (seen.has(key))
                            return;
                        if (minWordGap(vGroup, nGroup) > cap)
                            return;
                        seen.add(key);
                        signals.push({ verb: vTerm, noun: nTerm, snippet: makeSnippet(rawLine, nTerm) });
                    };
                    for (const [nTerm, nGroup] of sameGroups)
                        tryPair(nTerm, nGroup, MAX_COMPOUND_WORD_GAP);
                    if (crossGroups && clauseHasServiceObjectAfter(clauses[ci], vGroup.first)) {
                        for (const [nTerm, nGroup] of crossGroups) {
                            tryPair(nTerm, nGroup, MAX_CROSS_CLAUSE_WORD_GAP);
                        }
                    }
                }
            }
        }
        // (b) explicit <Service> API|SDK|REST|GraphQL surface — every candidate in
        // every clause (a rejected first candidate must not shadow a later genuine
        // service; #2365 review C-1).
        for (const clause of clauses) {
            surfaceRe.lastIndex = 0;
            let m;
            while ((m = surfaceRe.exec(clause.text)) !== null) {
                const svc = m[1] || '';
                const svcLower = svc.toLowerCase();
                // Reject ordinary capitalized sentence starters ("The API …", "Our REST …")
                // and locality descriptors ("Internal API …" describes first-party code).
                if (SERVICE_STOPWORDS.has(svcLower) || INTERNAL_DESCRIPTORS.has(svcLower))
                    continue;
                // Reject compound modifiers ("Resolver-only API" describes a local
                // interface, not a third-party service).
                if (COMPOUND_MODIFIER_RE.test(svc))
                    continue;
                // Reject services qualified as first-party ("internal Payments API").
                if (isInternallyQualified(masked, clause.start + m.index))
                    continue;
                // Clause-initial capitalization is ordinary English, not proper-noun
                // evidence — require dependency corroboration on the line, or an
                // integration-object follower ("Stripe API client …").
                const clauseInitial = /^[^A-Za-z0-9]*$/.test(clause.text.slice(0, m.index));
                if (clauseInitial && !hasDependencyEvidence(rawLine)) {
                    const followerMatch = /^[^A-Za-z0-9]*([A-Za-z0-9'-]+)/.exec(clause.text.slice(m.index + m[0].length));
                    const follower = followerMatch ? followerMatch[1].toLowerCase() : '';
                    if (!SURFACE_OBJECT_FOLLOWERS.has(follower))
                        continue;
                }
                const noun = (m[2] || '').toLowerCase();
                const key = `surface+${noun}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                signals.push({ verb: '(surface)', noun, snippet: makeSnippet(rawLine, svc) });
            }
        }
    }
    return { detected: signals.length > 0, signals, terms: effective };
}
/** True when the word immediately before `offset` is a locality descriptor
 *  ("the internal endpoint", "internal Payments API") — first-party
 *  qualification is negative evidence for an EXTERNAL-API signal. Looks back
 *  through a BOUNDED window, not the whole prefix — this runs per match and a
 *  full-prefix slice would be quadratic on hostile input (#2365 review S-2). */
const QUALIFIER_LOOKBACK = 24; // longest descriptor ("first-party") + separators
function isInternallyQualified(masked, offset) {
    const from = offset > QUALIFIER_LOOKBACK ? offset - QUALIFIER_LOOKBACK : 0;
    const window = masked.slice(from, offset);
    const m = /([A-Za-z0-9'-]+)[^A-Za-z0-9]*$/.exec(window);
    if (!m)
        return false;
    // A word truncated by the window start is not a descriptor match (its real
    // start lies before the window) — fail toward detection.
    if (from > 0 && m.index === 0 && /[A-Za-z0-9'-]/.test(masked[from - 1]))
        return false;
    return INTERNAL_DESCRIPTORS.has(m[1].toLowerCase());
}
/** True when the clause names a service object after the verb — a capitalized
 *  non-stopword token ("Integrate Stripe, …"). Gates cross-clause verb↔noun
 *  binding so unrelated coordinated clauses do not pair. */
function clauseHasServiceObjectAfter(clause, verb) {
    const after = clause.text.slice(verb.end - clause.start);
    const re = /\b([A-Z][A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(after)) !== null) {
        const tok = m[1].toLowerCase();
        if (!SERVICE_STOPWORDS.has(tok) && !INTERNAL_DESCRIPTORS.has(tok))
            return true;
    }
    return false;
}
/** Matches a declaration line such as
 *  `No external API integration: <reason>` (also `**bold**` and em-dash
 *  separators). The reason is REQUIRED — a bare declaration does not parse.
 *  Deliberately NOT matched: blockquoted lines (`> No external …` is quoted
 *  text, not a declaration) and anything inside fenced code or HTML comments
 *  (both stripped before the scan; #2365 review C-3). */
const NO_INTEGRATION_DECLARATION_RE = /^\s*(?:\*\*)?no external api integration(?:\*\*)?\s*(?:[:—–-]|--)\s*(\S[^\n]*)$/im;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const VALID_DECISIONS = new Set(['INTEGRATE', 'OPT-OUT']);
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
function parseCoverageMatrix(text) {
    const out = { rows: [], errors: [], format: 'none', declaration: null };
    if (typeof text !== 'string')
        return out;
    const src = text.replace(/\r\n/g, '\n');
    // #2365 acceptance #5: a "no external API integration" declaration. Scanned
    // on fence-stripped, comment-stripped text so an example inside a code block
    // or an HTML comment does not count.
    const declMatch = NO_INTEGRATION_DECLARATION_RE.exec((0, markdown_sectionizer_cjs_1.stripFencedCode)(src).text.replace(HTML_COMMENT_RE, ''));
    if (declMatch) {
        out.declaration = { none: true, reason: (declMatch[1] || '').trim() };
    }
    // (1) fenced ```coverage JSON block takes precedence if present.
    // Case-insensitive info string (```coverage and ```Coverage are both legal CommonMark).
    const fenceBody = (0, markdown_sectionizer_cjs_1.extractFencedBlock)(src, 'coverage');
    if (fenceBody) {
        out.format = 'json';
        let parsed;
        try {
            parsed = JSON.parse(fenceBody);
        }
        catch {
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
    // (2) markdown table — collect table rows whose decision column parses.
    const lines = src.split('\n');
    let sawHeader = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|'))
            continue;
        const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : trimmed.length).split('|');
        if (cells.length < 2)
            continue;
        const cleaned = cells.map((c) => c.trim());
        // skip separator rows (|---|---|); require ≥3 dashes so a literal "-" cell
        // is not mistaken for a separator.
        if (cleaned.every((c) => /^:?-{3,}:?$/.test(c)))
            continue;
        const decisionCell = (cleaned[1] || '').toUpperCase();
        // header detection
        if (!sawHeader && cleaned[0].toLowerCase() === 'capability') {
            sawHeader = true;
            out.format = 'table';
            continue;
        }
        if (!VALID_DECISIONS.has(decisionCell)) {
            // A row that otherwise looks like data (≥3 cells, non-empty capability)
            // but carries a malformed decision is a real error, not a row to skip
            // silently — otherwise a single typo'd row collapses the matrix to
            // "empty" and the user sees a confusing message.
            if (cleaned.length >= 3 && cleaned[0]) {
                out.errors.push(`row: decision "${decisionCell}" not in {INTEGRATE, OPT-OUT}`);
            }
            continue;
        }
        if (out.format === 'none')
            out.format = 'table';
        // A coverage row has exactly 3 cells. Extra cells mean an unescaped pipe in
        // a value silently corrupted the row — surface it rather than parse garbage.
        if (cleaned.length > 3) {
            out.errors.push(`row: ${cleaned.length} columns (expected 3 — unescaped pipe in a cell?)`);
        }
        out.rows.push({
            capability: cleaned[0] || '',
            decision: decisionCell,
            reason: (cleaned[2] ?? '').trim(),
        });
    }
    return out;
}
function rowFromJson(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return { error: 'not an object' };
    const o = v;
    const capability = typeof o['capability'] === 'string' ? o['capability'].trim() : '';
    if (!capability)
        return { error: 'missing/empty "capability"' };
    const dRaw = typeof o['decision'] === 'string' ? o['decision'].trim().toUpperCase() : '';
    if (!VALID_DECISIONS.has(dRaw)) {
        return { error: `decision "${dRaw}" not in {INTEGRATE, OPT-OUT}` };
    }
    const reason = typeof o['reason'] === 'string' ? o['reason'].trim() : '';
    return { capability, decision: dRaw, reason };
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
function validateCoverageMatrix(text) {
    const parsed = parseCoverageMatrix(text);
    const errors = [...parsed.errors];
    const rows = parsed.rows;
    // #2365 acceptance #5: a reasoned no-integration declaration with no rows
    // satisfies the gate. A declaration ALONGSIDE rows is contradictory — the
    // file must say one thing.
    if (parsed.declaration) {
        if (rows.length > 0) {
            errors.push('declares "no external API integration" but also contains coverage rows — remove the declaration or the rows');
        }
        else {
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
        if (errors.length === 0)
            errors.push('matrix is empty — no capabilities enumerated');
        return { valid: false, errors, counts: { surface: 0, integrate: 0, optout: 0 } };
    }
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.capability) {
            errors.push(`row[${i}]: empty capability name`);
        }
        else {
            // Format contract + prompt-injection bound: cell values must be short,
            // single-line, pipe-free prose (the matrix is a markdown table whose
            // content flows into the gate message). Pipes/newlines would corrupt the
            // table and let a COVERAGE.md inject unbounded text into the seal message.
            if (/[|\n\r]/.test(row.capability)) {
                errors.push(`row[${i}]: capability contains a pipe or newline (unsupported in a table cell)`);
            }
            if (row.capability.length > CAPABILITY_MAX_LEN) {
                errors.push(`row[${i}]: capability exceeds ${CAPABILITY_MAX_LEN} chars`);
            }
        }
        if (row.reason && /[|\n\r]/.test(row.reason)) {
            errors.push(`row[${i}]: reason contains a pipe or newline (unsupported in a table cell)`);
        }
        if (row.reason.length > REASON_MAX_LEN) {
            errors.push(`row[${i}]: reason exceeds ${REASON_MAX_LEN} chars`);
        }
        const key = row.capability.toLowerCase();
        if (key && seen.has(key))
            errors.push(`row[${i}]: duplicate capability`);
        if (key)
            seen.add(key);
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
function renderCoverageMatrix(rows) {
    const body = rows
        .map((r) => `| ${r.capability} | ${r.decision} | ${r.reason} |`)
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
    let termsOverride;
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
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
        const input = chunks.join('');
        const result = detectApiIntegration(input, termsOverride);
        if (wantJson) {
            process.stdout.write(JSON.stringify(result) + '\n');
        }
        process.exit(result.detected ? 0 : 1);
    });
    process.stdin.on('error', (err) => {
        process.stderr.write(`ERROR: api-coverage.cjs stdin read failed: ${err.message}\n`);
        process.exit(2);
    });
}

/**
 * Pure phase-id parsing/matching helpers — normalize, token match,
 * milestone/phase-dir id parsing, phase-markdown regex builders.
 *
 * Extracted from core.cts (ADR-857 rollout phase 2a / issue #865).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. The core.cjs re-export spine was retired in epic #1267;
 * callers import phase-id helpers from phase-id.cjs directly.
 *
 * Dependencies: none (pure string/regex, no Node built-ins required).
 */

// ─── Phase-id helpers ─────────────────────────────────────────────────────────

function escapeRegex(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// project_code values start with an uppercase letter (e.g. PROJ, APP_CODE);
// leading underscores are not valid project codes per .planning/config.json.
const PROJECT_CODE_PREFIX_STRIP_RE = /^[A-Z][A-Z0-9_]*-(?=\d)/;
const PROJECT_CODE_PREFIX_STRIP_RE_I = /^[A-Z][A-Z0-9_]*-(?=\d)/i;
const PROJECT_CODE_PREFIX_CAPTURE_RE_I = /^([A-Z][A-Z0-9_]*)-(\d.*)/i;
const OPTIONAL_PROJECT_CODE_PREFIX_SOURCE = '(?:[A-Z][A-Z0-9_]*-)?';

// #1729: phase headers may carry a parenthetical tag between the number and the
// colon, e.g. `### Phase 26 (Cluster B): Title`. This optional, non-capturing
// fragment is injected at every phase-header regex call site (immediately after
// the phase-number token, before the colon/space delimiter) so the resolver
// tolerates the tag — mirroring how `[...]` is already tolerated before `Phase`.
// `[^)\n]*` keeps the match single-line (headers are one line) to avoid
// over-consuming across a malformed multi-line document. Injected at the call
// site (not baked into phaseMarkdownRegexSource) so it applies uniformly to
// both the numeric and project-code-exact escaped sources, and so the decimal
// sub-phase patterns can place it after the `.N` segment.
//
// Enumeration/parse call sites that read phase headers from a regex *literal*
// (rather than a `new RegExp` built from an interpolated phase number) cannot
// reference this constant; they inline its literal-regex mirror instead —
// `(?:\s*\([^)\n]{0,200}\))?` — kept character-for-character equivalent to this
// source. Both forms must change together; see the #1729 regression test.
const OPTIONAL_PHASE_TAG_SOURCE = '(?:\\s*\\([^)\\n]{0,200}\\))?';

// #2128: the canonical phase-NUMBER-TOKEN grammar — a phase number with an
// optional single-letter variant suffix and optional dotted sub-phases
// (1, 01, 12A, 12.1, 3.2.1). This is the ENUMERATION/scan counterpart to
// phaseMarkdownRegexSource: use phaseMarkdownRegexSource(n) to build a source
// for ONE KNOWN number; reference this constant when a call site must match ANY
// phase and capture its token. Enumeration/parse sites inline this into a
// `new RegExp(...)` instead of re-deriving the grammar as a literal, so every
// phase-token producer shares one owner. The anti-divergence guard
// (scripts/lint-phase-id-drift.cjs) fails CI if a literal re-derivation is
// introduced outside this module without a `// phase-id-owner:` justification.
const PHASE_NUMBER_TOKEN_SOURCE = '\\d+[A-Z]?(?:\\.\\d+)*';

// #2232: the canonical CONTINUATION-segment grammar — a dash-separated segment
// that extends a phase token (a zero-padded sub-phase or plan number, e.g. the
// "01" in "02-01-setup"). getPhaseDirFromPhaseId writes these zero-padded to
// exactly 2 digits, so the digit RUN of a genuine continuation is exactly 2:
// #2043's `\d{2,}` (2-or-more) over-collected a slug word that merely leads
// with ≥2 digits (a year: "14-2026-photos-…" yielded token "14-2026", so every
// phase-locating verb reported the phase as missing). The `(?!\d)` guard caps
// the run at 2 without anchoring what may follow, so call sites keep their own
// trailing grammar (letter suffixes, dotted sub-phases, segment boundaries).
// POLICY (locked by boundary tests): sub-phase/plan numbers ≥100 are out of the
// dir-token grammar — the LEADING phase number stays unbounded (`\d+`), only
// continuation segments are width-capped. Shared from here so the five #2043
// call sites cannot drift independently (see scripts/lint-phase-id-drift.cjs).
const PHASE_CONTINUATION_SEGMENT_SOURCE = '\\d{2}(?!\\d)';
const PHASE_CONTINUATION_SEGMENT_PREFIX_RE = new RegExp(`^${PHASE_CONTINUATION_SEGMENT_SOURCE}`);
function isPhaseContinuationSegment(seg: string): boolean {
  return PHASE_CONTINUATION_SEGMENT_PREFIX_RE.test(seg);
}

// #2528: extractPhaseToken absorbs a continuation segment only when the WHOLE
// segment is the 2-digit zero-padded form the write side emits
// (getPhaseDirFromPhaseId pads genuine sub-phase/plan numbers to exactly 2
// digits and never appends letters) — so a slug word like "10x" (phase named
// "10x Growth" → dir "14-10x-growth") is a slug word, not a continuation.
// Derived from the owner SOURCE with both ends anchored; the prefix form above
// stays as-is for call sites that append their own trailing grammar.
const PHASE_CONTINUATION_SEGMENT_EXACT_RE = new RegExp(`^${PHASE_CONTINUATION_SEGMENT_SOURCE}$`);

// #2528: the #2043 slug-word class (a segment whose leading digit run has
// width exactly 1) used as a RETROACTIVE signal: when it immediately follows
// absorbed continuation segments, the run was a digit-leading slug (the
// "24/7" / "80/20" / "30-Day" family — see extractPhaseToken).
const SINGLE_DIGIT_RUN_SEGMENT_SOURCE = '\\d(?!\\d)';
const SINGLE_DIGIT_RUN_SEGMENT_RE = new RegExp(`^${SINGLE_DIGIT_RUN_SEGMENT_SOURCE}`);

function stripProjectCodePrefix(value: unknown, caseInsensitive = true): string {
  const input = String(value);
  const re = caseInsensitive ? PROJECT_CODE_PREFIX_STRIP_RE_I : PROJECT_CODE_PREFIX_STRIP_RE;
  return input.replace(re, '');
}

function hasProjectCodePrefix(value: unknown): boolean {
  return PROJECT_CODE_PREFIX_STRIP_RE_I.test(String(value));
}

function normalizePhaseName(phase: unknown): string {
  const str = String(phase);
  // Strip optional project_code prefix (e.g., 'CK-01' → '01')
  const stripped = stripProjectCodePrefix(str, false);
  // Milestone-prefixed phase IDs: M-NN or M-N-N (deep decomposition).
  const milestoneMatch = stripped.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneMatch) {
    const major = milestoneMatch[1].padStart(2, '0');
    const subSegments = milestoneMatch[2].slice(1).split('-').map(s => s.padStart(2, '0'));
    const suffix = milestoneMatch[3] || '';
    return `${major}-${subSegments.join('-')}${suffix}`;
  }
  // Standard numeric phases: 1, 01, 12A, 12.1
  const match = stripped.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (match) {
    const padded = match[1].padStart(2, '0');
    // Preserve original case of letter suffix (#1962).
    const letter = match[2] || '';
    const decimal = match[3] || '';
    return padded + letter + decimal;
  }
  // Custom phase IDs (e.g. PROJ-42, AUTH-101): return as-is
  return str;
}

function getMilestoneFromPhaseId(phaseId: unknown): string | null {
  const stripped = stripProjectCodePrefix(phaseId);
  const m = stripped.match(/^0*(\d+)-\d/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (major === 0 || major === 999) return null;
  return `v${major}.0`;
}

function getPhaseDirFromPhaseId(phaseId: unknown, phaseName: string | null | undefined, projectCode: string | null | undefined): string | null {
  const stripped = stripProjectCodePrefix(phaseId);
  const m = stripped.match(/^0*(\d+)-(0*(\d+(?:-\d+)*))$/);
  if (!m) return null;
  const milestone = String(parseInt(m[1], 10)).padStart(2, '0');
  const subParts = m[2].split('-').map(p => String(parseInt(p, 10)).padStart(2, '0'));
  const sub = subParts.join('-');
  const slug = phaseName
    ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  const parts = [milestone, sub, slug].filter(Boolean);
  const base = parts.join('-');
  return projectCode ? `${projectCode}-${base}` : base;
}

/**
 * Render a regex source fragment matching a phase number against ROADMAP/STATE
 * prose regardless of zero-padding on either side.
 */
function phaseMarkdownRegexSource(phaseNum: unknown): string {
  const stripped = stripProjectCodePrefix(phaseNum);

  // Milestone-prefixed IDs: M-NN or M-N-N (deep).
  const milestoneSegments = stripped.match(/^(\d+)((?:-\d+)*)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneSegments && milestoneSegments[2]) {
    const majorUnpadded = milestoneSegments[1].replace(/^0+/, '') || '0';
    const subParts = milestoneSegments[2].slice(1).split('-');
    const subFragments = subParts.map(s => {
      const unpadded = s.replace(/^0+/, '') || '0';
      return `0*${escapeRegex(unpadded)}`;
    });
    const suffix = milestoneSegments[3] || '';
    const suffixFragment = suffix ? escapeRegex(suffix) : '';
    return `0*${escapeRegex(majorUnpadded)}-${subFragments.join('-')}${suffixFragment}`;
  }

  // Plain numeric phase: 1, 01, 12A, 12.1
  const match = stripped.match(/^0*(\d+)([A-Z])?((?:\.\d+)*)$/i);
  if (!match) return escapeRegex(phaseNum);

  const integer = match[1].replace(/^0+/, '') || '0';
  const letter = match[2] ? escapeRegex(match[2]) : '';
  const decimal = match[3] ? escapeRegex(match[3]) : '';
  return `0*${escapeRegex(integer)}${letter}${decimal}`;
}

/**
 * #3599: when the caller passed a project-code-prefixed ID like `PROJ-42`,
 * return the exact-escaped form.
 */
function phaseMarkdownRegexSourceExact(phaseNum: unknown): string | null {
  const raw = String(phaseNum);
  if (!hasProjectCodePrefix(raw)) return null;
  return escapeRegex(raw);
}

function comparePhaseNum(a: unknown, b: unknown): number {
  // Strip optional project_code prefix before comparing
  const sa = stripProjectCodePrefix(a);
  const sb = stripProjectCodePrefix(b);

  const milestoneA = sa.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  const milestoneB = sb.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);

  if (milestoneA && milestoneB) {
    const segsA = [parseInt(milestoneA[1], 10), ...milestoneA[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const segsB = [parseInt(milestoneB[1], 10), ...milestoneB[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const maxSegs = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < maxSegs; i++) {
      const av = segsA[i] !== undefined ? segsA[i] : 0;
      const bv = segsB[i] !== undefined ? segsB[i] : 0;
      if (av !== bv) return av - bv;
    }
    const sufA = milestoneA[3] || '';
    const sufB = milestoneB[3] || '';
    if (sufA !== sufB) return sufA < sufB ? -1 : 1;
    return 0;
  }

  if (milestoneA || milestoneB) return String(a).localeCompare(String(b));

  const pa = sa.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = sb.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  const aDecParts = pa[3] ? pa[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const bDecParts = pb[3] ? pb[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i++) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Extract the phase token from a directory name.
 */
function extractPhaseToken(dirName: string): string {
  const codePrefixMatch = dirName.match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  let prefix = '';
  let rest = dirName;
  if (codePrefixMatch) {
    prefix = codePrefixMatch[1] + '-';
    rest = codePrefixMatch[2];
  }

  const segments = rest.split('-');
  const tokenSegments: string[] = [];
  // #2043: distinguish a real (zero-padded) phase/sub-phase segment from a
  // single-digit slug word. A pure-numeric leading segment ("46") only
  // continues with exactly-2-digit segments (#2232: a ≥3-digit run is a slug
  // word such as a year — "14-2026-photos-…" yields "14", not "14-2026"), so
  // "46-6-rs-…" yields "46" (the "6" is the
  // slug's first word), not "46-6". Milestone-prefixed ids like "M1-2" reach here
  // with "M1-" already stripped as a project-code prefix (see
  // PROJECT_CODE_PREFIX_CAPTURE_RE_I), so "2" is the leading segment and the same
  // pure-numeric rule applies (M1-46-6-rs → "M1-46"). The firstLetterPrefixed
  // carve-out covers letter+digit leading segments that survive prefix stripping
  // because of punctuation (e.g. "P0.3-2"), whose single-digit continuation is
  // intentionally preserved (unchanged from prior behaviour).
  let firstLetterPrefixed = false;
  let scanStoppedAt = -1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i === 0) {
      if (/^\d/.test(seg)) {
        tokenSegments.push(seg);
      } else if (/^[A-Za-z]{1,3}\d/.test(seg)) {
        tokenSegments.push(seg);
        firstLetterPrefixed = true;
      } else {
        break;
      }
    } else if (
      (firstLetterPrefixed && /^\d/.test(seg)) ||
      (!firstLetterPrefixed && PHASE_CONTINUATION_SEGMENT_EXACT_RE.test(seg))
    ) {
      tokenSegments.push(seg);
    } else {
      scanStoppedAt = i;
      break;
    }
  }

  if (tokenSegments.length === 0) {
    return dirName;
  }

  // #2528: a 2-digit slug word is indistinguishable from a genuine zero-padded
  // continuation by width alone (both are exactly 2 digits — the gap between
  // #2043's 1-digit and #2232's ≥3-digit guards). The tie-breaker is what
  // FOLLOWS the absorbed run: a slug is contiguous, so when the segment that
  // terminated the scan is a 1-digit word (#2043's slug-word class — the
  // "24/7"/"80/20"/"30-Day" naming family: phase 10 named "24/7 Autonomy" →
  // dir "10-24-7[-autonomy]"), the absorbed run re-opens as slug and the token
  // rewinds to the bare leading phase number, keeping the phase resolvable by
  // bare-number lookup. A ≥2-digit-run terminator does NOT rewind: the
  // year-leading-slug shape after a genuine sub-phase ("14-06-2026-photos" →
  // "14-06") is locked by the #2232 metamorphic round-trip tests. The
  // firstLetterPrefixed family keeps its intentionally-preserved single-digit
  // continuations (e.g. "P0.3-2") and is exempt.
  if (
    !firstLetterPrefixed &&
    tokenSegments.length > 1 &&
    scanStoppedAt !== -1 &&
    SINGLE_DIGIT_RUN_SEGMENT_RE.test(segments[scanStoppedAt])
  ) {
    tokenSegments.length = 1;
  }

  return prefix + tokenSegments.join('-');
}

/**
 * Check if a directory name's phase token matches the normalized phase exactly.
 */
function phaseTokenMatches(dirName: string, normalized: string): boolean {
  const token = extractPhaseToken(dirName);
  if (token.toUpperCase() === normalized.toUpperCase()) return true;
  const stripped = stripProjectCodePrefix(dirName);
  if (stripped !== dirName) {
    const strippedToken = extractPhaseToken(stripped);
    if (strippedToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  return false;
}

/**
 * #2528: the CANONICAL phase-directory match selection — the one rule every
 * directory-resolution path (the shared locator plus the `find-phase` and
 * `phase-plan-index` command scans) applies to a candidate dir list. Extracted
 * here because the surrounding scan/ambiguity/shaping code exists per site and
 * had already diverged; the selection itself must not.
 *
 * Two passes:
 *   1. PRIMARY — exact token match (`phaseTokenMatches`), unchanged behavior.
 *   2. BARE-INTEGER FALLBACK — only when the primary pass matched NOTHING and
 *      the query is a bare integer, re-filter by each directory's own LEADING
 *      digit run (zero-padded compare). This catches digit-leading slug shapes
 *      the tokenizer cannot disambiguate from genuine sub-phase segments
 *      (e.g. "05-80-20-cleanup", phase 5 named "80/20 Cleanup", whose token
 *      "05-80-20" is byte-identical in shape to a real deep-decomposition dir).
 *      The fallback can only turn a silent not-found into a resolution or into
 *      a surfaced ambiguity (callers keep their #2237 multi-match guards) —
 *      never override a primary match. Non-bare queries ("46-6", "12A",
 *      "PROJ-42") never enter the fallback, so deep-decomposition and
 *      letter-suffix lookups are untouched.
 *
 * `usedBareFallback` tells callers to derive the displayed phase number from
 * the directory's leading digit run instead of `extractPhaseToken` (whose
 * token for these dirs is the mis-absorbed multi-segment form).
 */
function matchPhaseDirs(dirs: string[], normalized: string): { matches: string[]; usedBareFallback: boolean } {
  const primary = dirs.filter(d => phaseTokenMatches(d, normalized));
  if (primary.length > 0) return { matches: primary, usedBareFallback: false };

  const bare = String(normalized).match(/^0*(\d+)$/);
  if (!bare) return { matches: primary, usedBareFallback: false };
  const want = bare[1];

  const fallback = dirs.filter(d => {
    const m = stripProjectCodePrefix(d).match(/^0*(\d+)(?:-|$)/);
    return m !== null && m[1] === want;
  });
  return { matches: fallback, usedBareFallback: fallback.length > 0 };
}

/**
 * #2528: the display phase number for a directory selected by matchPhaseDirs.
 * Primary matches keep the extracted token; bare-fallback matches use the
 * directory's leading digit run (the whole point of the fallback is that the
 * extracted token is wrong for these dirs).
 */
function phaseNumberForMatch(dirName: string, usedBareFallback: boolean): string {
  if (!usedBareFallback) return extractPhaseToken(dirName);
  const m = stripProjectCodePrefix(dirName).match(/^\d+/);
  return m ? m[0] : extractPhaseToken(dirName);
}

// ─── #2121 canonical surface (ADR-2121) ──────────────────────────────────────

/**
 * Parse a phase identifier from a STATE.md `Phase:` prose field VALUE — the text
 * after the `Phase:` label (e.g. `"3 of 4 (Delta)"`, `"3A — Delta (executing)"`,
 * or `"Milestone v0.5 complete"`).
 *
 * The token is anchored to the START of the value (after an optional literal
 * `Phase ` label and an optional project-code prefix) so a phase is only
 * returned when the value actually begins with one. This is the #2111 fix: the
 * prior unanchored `/\b(\d+[A-Z]?(?:\.\d+)*)\b/i` mined the first numeral
 * anywhere, so `"Milestone v0.5 complete"` collapsed to `"5"` (the minor-version
 * digit) and `"v1.0"` to `"0"` (a reserved sentinel). Here both yield
 * `{ phase: null }` because they do not begin with a phase token. The name
 * extraction (parenthetical or em-dash tail, minus status words) is unchanged.
 */
function parsePhaseFromProse(value: string | null): { phase: string | null; name: string | null } {
  if (!value) return { phase: null, name: null };
  // Coerce defensively so a non-string caller cannot throw on this canonical
  // surface (mirrors the sibling #2121 functions' String(...) handling).
  const str = String(value);
  const phaseMatch = str.match(/^\s*(?:Phase\s+)?(?:[A-Z][A-Z0-9_]*-)?(\d+[A-Z]?(?:\.\d+)*)\b/i);
  // The name-extraction quantifiers are length-bounded so a crafted long
  // unterminated run (many `(` or `—`) in an untrusted STATE.md field value
  // cannot drive O(n^2) regex backtracking (CPU-exhaustion DoS). A real phase
  // name is far shorter than the cap.
  const parenName = str.match(/\(([^)]{1,200})\)/);
  const dashName = str.match(/—\s*([^(\n]{1,200}?)(?:\s*\(|$)/);
  const rawName = parenName?.[1] ?? dashName?.[1] ?? null;
  const name = rawName && !/^(?:complete|executing|not started)$/i.test(rawName.trim())
    ? rawName.trim()
    : null;
  return {
    phase: phaseMatch ? phaseMatch[1] : null,
    name,
  };
}

/**
 * Config-AWARE project-code prefix strip. Unlike the config-blind
 * `stripProjectCodePrefix` (which strips ANY `<CODE>-` shape), this strips the
 * leading `<CODE>-` ONLY when `<CODE>` case-insensitively equals the configured
 * `projectCode`. A foreign prefix (`MEM-01` when the configured code is `LKML`)
 * or an absent/empty `projectCode` is preserved verbatim — this is the #2104
 * fix: a foreign-prefixed id must not collapse to a bare numeric phase and
 * collide with a real one.
 */
function stripConfiguredProjectCodePrefix(value: unknown, projectCode: string | null | undefined): string {
  const input = String(value);
  const configured = typeof projectCode === 'string' ? projectCode.trim() : '';
  if (!configured) return input;
  const m = input.match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  if (!m) return input;
  if (m[1].toUpperCase() !== configured.toUpperCase()) return input;
  return m[2];
}

/**
 * True when `phase` carries a project-code prefix that is NOT the configured
 * `projectCode` (or when no `projectCode` is configured). The canonical
 * predicate the init-command foreign-prefix guard (#2056 / PR #2105) delegates
 * to, so every call site shares one foreign-prefix rule.
 */
function isForeignPrefixedPhaseQuery(phase: unknown, projectCode: unknown): boolean {
  const m = String(phase).match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
  if (!m) return false;
  const configured = typeof projectCode === 'string' ? projectCode.trim() : '';
  return !configured || m[1].toUpperCase() !== configured.toUpperCase();
}

/**
 * Canonical ROADMAP heading lookup-source list (moved here from
 * roadmap-parser.cts so phase-id.cts is the single owner of the ordering).
 * Sources are tried in a fixed, deduplicated order: exact (only when the query
 * itself is project-code-prefixed) → bare numeric / padding-tolerant →
 * prefix-tolerant fallback. The bare numeric source precedes the prefix-tolerant
 * form so a canonical heading (`### Phase 117:`) is preferred over a drifted
 * prefixed one (`### Phase MANIFOLD-117:`) when both exist in one ROADMAP.
 */
function roadmapPhaseLookupSources(phaseNum: unknown): string[] {
  const sources: string[] = [];
  const exactSource = phaseMarkdownRegexSourceExact(phaseNum);
  if (exactSource) sources.push(exactSource);

  const numericSource = phaseMarkdownRegexSource(phaseNum);
  sources.push(numericSource);
  sources.push(`${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${numericSource}`);

  return [...new Set(sources)];
}

export = {
  escapeRegex,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
  PHASE_CONTINUATION_SEGMENT_SOURCE,
  SINGLE_DIGIT_RUN_SEGMENT_SOURCE,
  isPhaseContinuationSegment,
  stripProjectCodePrefix,
  normalizePhaseName,
  getMilestoneFromPhaseId,
  getPhaseDirFromPhaseId,
  phaseMarkdownRegexSource,
  phaseMarkdownRegexSourceExact,
  comparePhaseNum,
  extractPhaseToken,
  phaseTokenMatches,
  matchPhaseDirs,
  phaseNumberForMatch,
  parsePhaseFromProse,
  stripConfiguredProjectCodePrefix,
  isForeignPrefixedPhaseQuery,
  roadmapPhaseLookupSources,
};

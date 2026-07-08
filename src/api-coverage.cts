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
 *    detector requires an INTEGRATION VERB co-occurring with an EXTERNAL-API
 *    NOUN (or an explicit "<Service> API/SDK" phrase). Single weak tokens do not
 *    fire. This is the issue's "low false-positive trigger" made mechanical.
 *  - FENCED CODE BLOCKS ARE STRIPPED first (markdown-sectionizer seam) so a
 *    trigger term inside a code snippet does not fire.
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

import { stripFencedCode } from './markdown-sectionizer.cjs';

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
const SERVICE_SURFACE_API_RE = /\b([A-Z][A-Za-z0-9_-]{1,})\s+(API|SDK|REST|GraphQL)\b/;
const SERVICE_STOPWORDS = new Set([
  'the', 'an', 'a', 'our', 'this', 'these', 'that', 'those', 'new', 'add',
  'use', 'your', 'my', 'no', 'some', 'any', 'all', 'each', 'every', 'both',
  'if', 'when', 'while', 'with', 'via', 'using', 'into', 'its', 'their',
  'we', 'you', 'they', 'it',
]);

/**
 * Detect whether phase-scope prose describes integrating an external API/SDK.
 *
 * Fires when EITHER:
 *   (a) a compound verb+noun signal co-occurs on the same line, OR
 *   (b) an explicit `<Service> API|SDK|REST|GraphQL` surface appears.
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

  // (a) compound verb+noun on the same line.
  if (effective.verbs.length > 0 && effective.nouns.length > 0) {
    const verbRe = new RegExp(
      '(^|[^a-zA-Z0-9])(' + effective.verbs.map(escapeRegex).join('|') + ')([^a-zA-Z0-9]|$)',
      'gi',
    );
    const nounRe = new RegExp(
      '(^|[^a-zA-Z0-9])(' + effective.nouns.map(escapeRegex).join('|') + ')([^a-zA-Z0-9]|$)',
      'gi',
    );
    for (const line of lines) {
      verbRe.lastIndex = 0;
      nounRe.lastIndex = 0;
      const vMatch = verbRe.exec(line);
      if (!vMatch) continue;
      const nMatch = nounRe.exec(line);
      if (!nMatch) continue;
      const verb = (vMatch[2] || '').toLowerCase();
      const noun = (nMatch[2] || '').toLowerCase();
      const key = `${verb}+${noun}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ verb, noun, snippet: makeSnippet(line, noun) });
    }
  }

  // (b) explicit <Service> API|SDK|REST|GraphQL surface.
  for (const line of lines) {
    SERVICE_SURFACE_API_RE.lastIndex = 0;
    const m = SERVICE_SURFACE_API_RE.exec(line);
    if (!m) continue;
    // Reject ordinary capitalized sentence starters ("The API …", "Our REST …").
    if (SERVICE_STOPWORDS.has((m[1] || '').toLowerCase())) continue;
    const noun = (m[2] || '').toLowerCase();
    const key = `surface+${noun}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ verb: '(surface)', noun, snippet: makeSnippet(line, m[1]) });
  }

  return { detected: signals.length > 0, signals, terms: effective };
}

// ─── Coverage matrix parse / validate / render ────────────────────────────────

export type CoverageDecision = 'INTEGRATE' | 'OPT-OUT';

export interface CoverageRow {
  capability: string;
  decision: CoverageDecision;
  reason: string;
}

export interface CoverageParseResult {
  rows: CoverageRow[];
  errors: string[];
  format: 'table' | 'json' | 'none';
}

export interface CoverageValidationResult {
  valid: boolean;
  errors: string[];
  counts: { surface: number; integrate: number; optout: number };
}

const VALID_DECISIONS = new Set<CoverageDecision>(['INTEGRATE', 'OPT-OUT']);

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
  const out: CoverageParseResult = { rows: [], errors: [], format: 'none' };
  if (typeof text !== 'string') return out;
  const src = text.replace(/\r\n/g, '\n');

  // (1) fenced ```coverage JSON block takes precedence if present.
  // Case-insensitive info string (```coverage and ```Coverage are both legal CommonMark).
  // allow-adhoc-markdown: extracting a NAMED ```coverage fence (extraction of one tagged block), not stripping all fences — stripFencedCode/extractTaggedBlocks do not cover named-fence extraction.
  const fenceMatch = src.match(/```coverage\s*\n([\s\S]*?)\n```/i);
  if (fenceMatch && fenceMatch[1]) {
    out.format = 'json';
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenceMatch[1]);
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

  // (2) markdown table — collect table rows whose decision column parses.
  const lines = src.split('\n');
  let sawHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : trimmed.length).split('|');
    if (cells.length < 2) continue;
    const cleaned = cells.map((c) => c.trim());
    // skip separator rows (|---|---|); require ≥3 dashes so a literal "-" cell
    // is not mistaken for a separator.
    if (cleaned.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    const decisionCell = (cleaned[1] || '').toUpperCase();
    // header detection
    if (!sawHeader && cleaned[0].toLowerCase() === 'capability') {
      sawHeader = true;
      out.format = 'table';
      continue;
    }
    if (!VALID_DECISIONS.has(decisionCell as CoverageDecision)) {
      // A row that otherwise looks like data (≥3 cells, non-empty capability)
      // but carries a malformed decision is a real error, not a row to skip
      // silently — otherwise a single typo'd row collapses the matrix to
      // "empty" and the user sees a confusing message.
      if (cleaned.length >= 3 && cleaned[0]) {
        out.errors.push(`row: decision "${decisionCell}" not in {INTEGRATE, OPT-OUT}`);
      }
      continue;
    }
    if (out.format === 'none') out.format = 'table';
    // A coverage row has exactly 3 cells. Extra cells mean an unescaped pipe in
    // a value silently corrupted the row — surface it rather than parse garbage.
    if (cleaned.length > 3) {
      out.errors.push(`row: ${cleaned.length} columns (expected 3 — unescaped pipe in a cell?)`);
    }
    out.rows.push({
      capability: cleaned[0] || '',
      decision: decisionCell as CoverageDecision,
      reason: (cleaned[2] ?? '').trim(),
    });
  }
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

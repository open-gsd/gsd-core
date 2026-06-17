/**
 * Shared parser for CONTEXT.md <decisions> blocks (ADR-457 build-at-publish:
 * the hand-written bin/lib/decisions.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Accepts both numeric (D-42) and alphanumeric (D-INFRA-01) IDs.
 * Returns {id, text, category, tags, trackable} per decision.
 * CJS callers that only use {id, text} safely ignore the extra fields.
 *
 * ADR-1372 T1: rewritten to adopt the markdown-sectionizer seam.
 * - `stripFencedCode` → seam's `stripFencedCode` (CommonMark-correct)
 * - `extractDecisionsBlock` → seam's `extractTaggedBlocks(content,'decisions')`
 * - Markdown-header fallback → seam's `collectSection(content, /decisions?/i, ...)`
 * - Outer bullet loop → seam's `iterateBullets` (for the header-fallback path)
 *
 * Resolves #1364 (markdown-header + em-dash recall) and #1365 (fail-loud gate).
 */

import {
  stripFencedCode,
  extractTaggedBlocks,
  collectSection,
} from './markdown-sectionizer.cjs';

export interface Decision {
  id: string;
  text: string;
  category: string;
  tags: string[];
  trackable: boolean;
}

/**
 * Typed extraction result distinguishing three states the blocking gate cares about:
 * - 'parsed'         — ≥1 decision was successfully extracted
 * - 'none-present'   — content has no decision signals; nothing to check
 * - 'could-not-parse'— content is decision-shaped (has a <decisions> block, a
 *                      /decisions?/i heading, a \bD- token, or an unterminated fence)
 *                      yet 0 decisions were extracted → format mismatch, fail-loud
 */
export type DecisionOutcome = 'parsed' | 'none-present' | 'could-not-parse';

export interface DecisionExtraction {
  decisions: Decision[];
  outcome: DecisionOutcome;
}

const DISCRETION_HEADINGS = new Set([
  "claude's discretion",
  'claudes discretion',
  'claude discretion',
]);
const NON_TRACKABLE_TAGS = new Set(['informational', 'folded', 'deferred']);

// ─── Bullet parsers (decisions-specific grammar) ─────────────────────────────

/**
 * Colon form: `- **D-NN[ [tags]]:** text`
 * (#1343: `[^:*]*` subsumes any pre-colon prose, stops at `:**`)
 */
const bulletColonRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^:*]*:\*\*\s*(.*)$/;

/**
 * Em-dash form: `- **D-NN[ [tags]] — title** body`
 * The em-dash (U+2014) or its lookalike separates the ID+tags group from a title
 * that lives inside the bold markers; the body (which may be empty) follows
 * outside the closing `**`. This form was not handled pre-T1 (bug #1364).
 *
 * Accepts both U+2014 em-dash (—) and U+2013 en-dash (–) for robustness.
 */
const bulletEmDashRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^*]*[—–][^*]*\*\*\s*(.*)$/;

/**
 * Parse decision lines from a block of text (the inner text of a <decisions>
 * or markdown-header section body). Returns the extracted decisions.
 */
function parseDecisionLines(block: string): Decision[] {
  const lines = block.split(/\r?\n/);
  const out: Decision[] = [];
  let category = '';
  let inDiscretion = false;
  let current: Decision | null = null;

  const flush = (): void => {
    if (current) {
      current.text = current.text.trim();
      out.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Track category headings (`### Heading`)
    const headingMatch = trimmed.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      category = headingMatch[1];
      // Strip the full unicode-quote family so any rendering of "Claude's
      // Discretion" (ASCII apostrophe, curly U+2019, U+2018, U+201A, U+201B,
      // double-quote variants U+201C/D/E/F, etc.) collapses to the same key
      // (review F20).
      const normalized = category
        .toLowerCase()
        .replace(/[''‚‛""„‟'"`]/g, '')
        .trim();
      inDiscretion = DISCRETION_HEADINGS.has(normalized);
      continue;
    }

    // Colon form: `- **D-NN[ [tags]]:** text`
    const colonMatch = line.match(bulletColonRe);
    if (colonMatch) {
      flush();
      const id = `D-${colonMatch[1]}`;
      const tags = colonMatch[2]
        ? colonMatch[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      current = { id, text: colonMatch[3], category, tags, trackable };
      continue;
    }

    // Em-dash form: `- **D-NN[ [tags]] — title** body`
    const emDashMatch = line.match(bulletEmDashRe);
    if (emDashMatch) {
      flush();
      const id = `D-${emDashMatch[1]}`;
      const tags = emDashMatch[2]
        ? emDashMatch[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      // The body (emDashMatch[3]) may be empty for the pure title form; the
      // title itself is embedded in the bold run but we report the body as text
      // (consistent with how the gate cares only about coverage, not title/body split).
      current = { id, text: emDashMatch[3] || '', category, tags, trackable };
      continue;
    }

    // Parse-miss guard (#1343): a line that looks like a `D-NN` decision bullet
    // but failed both patterns must NOT be silently dropped — flush before warning.
    if (/^\s*-\s+\*\*D-/.test(line)) {
      flush();
      console.warn(`parseDecisions: ignored unparseable decision bullet: ${trimmed}`);
      continue;
    }

    // Continuation line for current decision (indented with space OR tab,
    // non-bullet, non-empty) — tab indentation must work too (review F12).
    if (current && trimmed !== '' && !trimmed.startsWith('-') && /^[ \t]/.test(line)) {
      current.text += ' ' + trimmed;
      continue;
    }

    // Blank line or unrelated content terminates the current decision
    if (trimmed === '') {
      flush();
    }
  }
  flush();
  return out;
}

// ─── Primary entry point: extractDecisions ────────────────────────────────────

/**
 * Extract decisions from CONTEXT.md content with a typed outcome.
 *
 * Strategy (in priority order):
 * 1. If the content (fence-stripped) contains `<decisions>...</decisions>` blocks,
 *    parse ONLY those blocks (canonical form; markdown-header content outside blocks
 *    is ignored when a block is present — existing behavior preserved).
 * 2. Otherwise, look for a /decisions?/i heading and collect its section body.
 *    This is the T1 recall fix for #1364.
 * 3. If neither is found, return outcome based on decision-shape heuristics.
 */
export function extractDecisions(content: unknown): DecisionExtraction {
  if (!content || typeof content !== 'string') {
    return { decisions: [], outcome: 'none-present' };
  }

  // Apply fence-stripping for block extraction (prevents example blocks inside
  // ``` fences from polluting the parser — review F11).
  const { text: stripped, unterminatedFence } = stripFencedCode(content);

  // ── Path 1: <decisions> blocks present ──────────────────────────────────────
  const taggedBlocks = extractTaggedBlocks(stripped, 'decisions');
  if (taggedBlocks.length > 0) {
    const combined = taggedBlocks.join('\n\n');
    const decisions = parseDecisionLines(combined);
    if (decisions.length > 0) {
      return { decisions, outcome: 'parsed' };
    }
    // Block present but 0 extracted → could-not-parse (format mismatch)
    return { decisions: [], outcome: 'could-not-parse' };
  }

  // ── Path 2: markdown-header fallback (#1364 fix) ─────────────────────────────
  // Use the seam's collectSection to find a /decisions?/i heading section.
  // levelBounded:true → stop at next same-or-higher-level heading.
  // stripFences:true → inner fences inside the section body are stripped.
  const section = collectSection(
    content,
    (h) => /decisions?\b/i.test(h.text),
    { levelBounded: true, stripFences: true },
  );

  if (section !== null) {
    const decisions = parseDecisionLines(section.body);
    if (decisions.length > 0) {
      return { decisions, outcome: 'parsed' };
    }
    // Heading found but 0 extracted → could-not-parse
    return { decisions: [], outcome: 'could-not-parse' };
  }

  // ── Path 3: no blocks, no heading ────────────────────────────────────────────
  // Apply shape heuristics to distinguish none-present from could-not-parse.
  // We re-use the already-computed unterminatedFence and check for D- tokens.
  const hasDecisionToken = /\bD-[A-Za-z0-9]/m.test(stripped);
  if (unterminatedFence || hasDecisionToken) {
    return { decisions: [], outcome: 'could-not-parse' };
  }

  return { decisions: [], outcome: 'none-present' };
}

// ─── parseDecisions: thin delegate (backwards-compatible entry point) ─────────

/**
 * Parse trackable decisions from CONTEXT.md content.
 *
 * Thin delegate over extractDecisions — callers receive the decisions array
 * exactly as before; nothing breaks. Use extractDecisions directly when the
 * outcome enum is needed (e.g. for the fail-loud gate logic).
 *
 * Returns ALL D-NN decisions found (including non-trackable ones, with
 * `trackable: false`). Callers that only want the gate-enforced decisions
 * should filter `.filter(d => d.trackable)`.
 */
export function parseDecisions(content: unknown): Decision[] {
  return extractDecisions(content).decisions;
}

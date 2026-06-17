/**
 * Shared parser for CONTEXT.md <decisions> blocks (ADR-457 build-at-publish:
 * the hand-written bin/lib/decisions.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Accepts both numeric (D-42) and alphanumeric (D-INFRA-01) IDs.
 * Returns {id, text, category, tags, trackable} per decision.
 * CJS callers that only use {id, text} safely ignore the extra fields.
 */

export interface Decision {
  id: string;
  text: string;
  category: string;
  tags: string[];
  trackable: boolean;
}

const DISCRETION_HEADINGS = new Set([
  "claude's discretion",
  'claudes discretion',
  'claude discretion',
]);
const NON_TRACKABLE_TAGS = new Set(['informational', 'folded', 'deferred']);

/**
 * Strip fenced code blocks from `content` so example `<decisions>` snippets
 * inside ```` ``` ```` do not pollute the parser (review F11).
 */
function stripFencedCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
}

/**
 * Extract the inner text of EVERY `<decisions>...</decisions>` block in
 * order, concatenated by `\n\n`. Returns null when no block is present.
 *
 * CONTEXT.md may legitimately contain more than one block (for example, a
 * "current decisions" block plus a "carry-over from prior phase" block);
 * dropping all-but-the-first silently lost the second batch (review F13).
 */
function extractDecisionsBlock(content: string): string | null {
  const cleaned = stripFencedCode(content);
  const matches = [...cleaned.matchAll(/<decisions>([\s\S]*?)<\/decisions>/g)];
  if (matches.length === 0)
    return null;
  return matches.map((m) => m[1]).join('\n\n');
}

/**
 * Parse trackable decisions from CONTEXT.md content.
 *
 * Returns ALL D-NN decisions found inside `<decisions>` (including
 * non-trackable ones, with `trackable: false`). Callers that only want the
 * gate-enforced decisions should filter `.filter(d => d.trackable)`.
 */
export function parseDecisions(content: unknown): Decision[] {
  if (!content || typeof content !== 'string')
    return [];
  const block = extractDecisionsBlock(content);
  if (block === null)
    return [];
  const lines = block.split(/\r?\n/);
  const out: Decision[] = [];
  let category = '';
  let inDiscretion = false;
  // Bullet line: `- **D-NN[ [tags]]:** text`
  // Phase 6 (#3575): aligned to CJS regex — accepts alphanumeric IDs (D-01, D-INFRA-01, D-FOO_BAR)
  // in addition to numeric-only IDs (D-42). The first character after `D-` must
  // be alphanumeric, so malformed shapes like `D--foo` or `D-_bar` are rejected.
  // CJS callers consume {id, text} and ignore the optional extras.
  // #1343: `[^:*]*` replaces the old `\s*` before `:**` so that a freeform run
  // such as `(parenthetical)`, an em-dash, or other prose between the optional
  // bracket-tag group and the closing `:**` is tolerated rather than silently
  // dropping the whole decision. `[^:*]*` subsumes plain whitespace and stops
  // correctly at `:**`. Capture groups 1 (id), 2 (bracket tags), 3 (text) are
  // unchanged.
  const bulletRe = /^\s*-\s+\*\*D-([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s*\[([^\]]+)\])?[^:*]*:\*\*\s*(.*)$/;
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
        .replace(/[‘’‚‛“”„‟'"`]/g, '')
        .trim();
      inDiscretion = DISCRETION_HEADINGS.has(normalized);
      continue;
    }
    const bulletMatch = line.match(bulletRe);
    if (bulletMatch) {
      flush();
      const id = `D-${bulletMatch[1]}`;
      const tags = bulletMatch[2]
        ? bulletMatch[2]
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((t) => NON_TRACKABLE_TAGS.has(t));
      current = { id, text: bulletMatch[3], category, tags, trackable };
      continue;
    }
    // Parse-miss guard (#1343): a line that looks like a `D-NN` decision bullet
    // but failed `bulletRe` (e.g. a `:` or `*` inside the pre-colon run) must NOT
    // be silently dropped — a narrowed trackable set lets a blocking coverage gate
    // report a false pass. Surface it loudly instead.
    if (/^\s*-\s+\*\*D-/.test(line)) {
      // A malformed D-bullet still starts a (failed) new decision, so it ends the
      // previous one — flush before warning so a following continuation line cannot
      // be mis-appended to the prior valid decision.
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

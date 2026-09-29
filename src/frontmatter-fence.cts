/**
 * frontmatter-fence.cts — the one owner of "where does a document's frontmatter block start
 * and stop" (ADR-5057 one-owner rule; found while implementing #5105).
 *
 * Source in src/frontmatter-fence.cts, compiled to gsd-core/bin/lib/frontmatter-fence.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Before this module the answer was re-derived some thirty times across `src/` — regexes such
 * as `/^---\r?\n([\s\S]*?)\r?\n---/`, `indexOf('\n---', 4)` scans, `lines[0].trim() === '---'`
 * checks — and the copies disagreed on a BOM, CRLF, an adjacent empty block, `----`, `--- x`,
 * a `---` inside a value and leading whitespace. Every frontmatter reader and writer in `src/`
 * (planning documents, agent/skill/command files, the installer's converters and injectors),
 * in the runtime hooks, and in the two hand-written entry points that load `bin/lib`
 * (`bin/install.js`, `gsd-core/bin/gsd-tools.cjs`) now reads the fence from
 * `locateFrontmatterFence` — directly for offsets, or through `frontmatterRegion`/
 * `frontmatterBlock`/`extractFrontmatter`/`stripFrontmatter` (`frontmatter.cts`) for content.
 * `scripts/lint-frontmatter-fence-drift.cjs` (run by `lint:ci`) fails on a new hand-rolled
 * fence in any of them.
 *
 * A "genuine leaf" module (CONTEXT.md's term): zero I/O, zero imports, so both
 * `frontmatter.cts` and `shell-command-projection.cts` — which import each other's side of a
 * cycle — can depend on it.
 */

/**
 * Where a document's frontmatter fences are. Every offset is into the text as given (a leading
 * BOM included).
 *
 * - `bom` — the leading UTF-8 BOM (U+FEFF), or ''.
 * - `eol` — the opening fence's line ending.
 * - `openEnd` — the offset right after the opening fence's line ending: where the block's
 *   first content line starts.
 * - `closed` — whether a closing fence was found.
 * - `closingStart` — the offset of the closing fence line (-1 when not closed).
 * - `closingFenceEnd` — the offset right after the closing fence line's text, before its line
 *   ending (-1 when not closed). `text.slice(bom.length, closingFenceEnd)` is the block a writer
 *   publishes; `text.slice(closingFenceEnd)` is everything after it.
 * - `bodyEnd` — the end of the YAML text: before the line ending that precedes the closing
 *   fence, `openEnd` for an adjacent empty block, and `text.length` when not closed.
 *   `text.slice(openEnd, bodyEnd)` is the YAML region.
 */
export interface FrontmatterFence {
  bom: string;
  eol: '\n' | '\r\n';
  openEnd: number;
  closed: boolean;
  closingStart: number;
  closingFenceEnd: number;
  bodyEnd: number;
}

/** A closing fence is a WHOLE line: three dashes, then only spaces or tabs. */
const CLOSING_FENCE_LINE = /^---[ \t]*$/;

/**
 * The lenient closer: a WHOLE line of four or more dashes, then only spaces or tabs. It closes
 * a block only when no exact closer follows the opening fence — the pre-existing lenient parse
 * of a `----`-closed block (#1882, `tests/unusable-input.test.cjs`), kept so such a document
 * still reads its keys instead of reading as unterminated.
 */
const LENIENT_CLOSING_FENCE_LINE = /^-{4,}[ \t]*$/;

/**
 * Locate the frontmatter fences of `text`, or null when it has none.
 *
 * The rules: a single leading BOM is tolerated (#2977); the opening fence is exactly `---`
 * followed by `\n` or `\r\n`, at byte 0 after the BOM — a `---` later in the document (a YAML
 * example, a thematic break) is never frontmatter; the closing fence is the first later line
 * that is `---` plus optional trailing spaces or tabs, ended by `\n`, `\r\n` or the end of the
 * text — `--- x`, `--` and a `---` ended by a lone CR at the end of the text are content, not
 * closers. A closer on the very next line is a closed, EMPTY block. A line of four or more
 * dashes is content while an exact closer follows it, and closes the block when none does
 * (the pre-existing lenient `----` parse, #1882).
 *
 * An opened fence with no closer is reported (`closed: false`) rather than refused: readers
 * differ on what that means (the #1882 truncation probe warns, a writer refuses).
 *
 * `{ allowPreamble: true }` is the effort-sync line editors' reading (#3706 pinned it, and
 * `tests/effort-sync-installed-runtime.test.cjs` holds it): when there is no opening fence at
 * byte 0, the opening fence is the first later WHOLE line that is exactly `---` followed by
 * `\n` or `\r\n` — so a block behind a preamble is still the one they edit. Only where the
 * opening fence may sit changes; the closing rules above are unchanged. No other consumer
 * passes it: to every reader, and to the runtime that loads the file, a block that does not
 * open at byte 0 is not frontmatter.
 */
export interface LocateFrontmatterFenceOptions {
  allowPreamble?: boolean;
}

export function locateFrontmatterFence(text: string, options: LocateFrontmatterFenceOptions = {}): FrontmatterFence | null {
  if (typeof text !== 'string') {
    throw new TypeError(`locateFrontmatterFence: expected a string, got ${typeof text}`);
  }
  const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const openingEolAt = (at: number): '\n' | '\r\n' | null => {
    if (text.startsWith('---\r\n', at)) return '\r\n';
    if (text.startsWith('---\n', at)) return '\n';
    return null;
  };
  let start = bom.length;
  let found = openingEolAt(start);
  if (found === null && options.allowPreamble === true) {
    for (let newline = text.indexOf('\n', start); newline !== -1; newline = text.indexOf('\n', newline + 1)) {
      found = openingEolAt(newline + 1);
      if (found !== null) {
        start = newline + 1;
        break;
      }
    }
  }
  if (found === null) return null;
  const eol: '\n' | '\r\n' = found;
  const openEnd = start + 3 + eol.length;

  const closedAt = (lineStart: number, lineEnd: number): FrontmatterFence => {
    let bodyEnd = openEnd;
    if (lineStart > openEnd) {
      // Back over the line ending that ends the last content line.
      bodyEnd = lineStart - 1;
      if (bodyEnd > openEnd && text[bodyEnd - 1] === '\r') bodyEnd -= 1;
    }
    return { bom, eol, openEnd, closed: true, closingStart: lineStart, closingFenceEnd: lineEnd, bodyEnd };
  };

  let lenient: [number, number] | null = null;
  let lineStart = openEnd;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline > lineStart && text[newline - 1] === '\r' ? newline - 1 : newline;
    const line = text.slice(lineStart, lineEnd);
    if (CLOSING_FENCE_LINE.test(line)) return closedAt(lineStart, lineEnd);
    if (lenient === null && LENIENT_CLOSING_FENCE_LINE.test(line)) lenient = [lineStart, lineEnd];
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (lenient !== null) return closedAt(lenient[0], lenient[1]);
  return { bom, eol, openEnd, closed: false, closingStart: -1, closingFenceEnd: -1, bodyEnd: text.length };
}

"use strict";
/**
 * Markdown Sectionizer — canonical markdown-structure parsing seam
 *
 * Pure functions, Node built-ins only (no external deps). String-in → value-out, no I/O.
 * Promoted from `uat-predicate.cts` `_stripFencedBlocks` (CommonMark-correct state machine)
 * and extended with heading tokenisation, section collection, and bullet iteration.
 *
 * ADR-1372 — T0 foundational seam. Migration tiers T1–T7 progressively adopt this seam.
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/markdown-sectionizer.cjs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripFencedCode = stripFencedCode;
exports.tokenizeHeadings = tokenizeHeadings;
exports.collectSections = collectSections;
exports.collectSection = collectSection;
exports.iterateBullets = iterateBullets;
exports.extractTaggedBlocks = extractTaggedBlocks;
exports.replaceSection = replaceSection;
// ─── stripFencedCode ──────────────────────────────────────────────────────────
/**
 * CommonMark-correct fenced-code-block stripper.
 *
 * Ported from `uat-predicate.cts` `_stripFencedBlocks` — the reference
 * implementation for the repo. DO NOT modify `uat-predicate.cts` (its
 * migration is T5); this is a tracked duplication until T5 lands.
 *
 * Rules:
 * - Opening delimiter: a line whose non-indent portion begins with ≥3 backticks
 *   or tildes (≤3 leading spaces tolerated per CommonMark §4.5).
 * - Closing delimiter: same character, run length ≥ opening, no trailing
 *   non-whitespace text.
 * - A tilde fence inside a backtick fence (or vice versa) is fence *content*,
 *   not a closing delimiter — delimiter char must match.
 * - Both delimiter lines and all content lines are dropped from the output.
 * - CRLF-safe: trailing `\r` is stripped before delimiter matching; the kept
 *   non-fence lines are returned as-is (including any `\r`).
 * - `unterminatedFence` signals EOF inside an open fence.
 */
function stripFencedCode(content) {
    if (typeof content !== 'string') {
        return { text: '', unterminatedFence: false };
    }
    const lines = content.split('\n');
    const kept = [];
    let openFence = null;
    // Matches: optional indent (≤3 spaces per CommonMark), fence run, optional info string
    const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;
    for (const rawLine of lines) {
        // Strip trailing \r for delimiter matching (CRLF safety)
        const line = rawLine.replace(/\r$/, '');
        const m = delimRe.exec(line);
        if (m) {
            const char = m[2][0];
            const len = m[2].length;
            const trailing = m[3];
            if (openFence === null) {
                // CommonMark §4.5: backtick fence info string must not contain a backtick.
                // If it does, this line is NOT a valid fence opener (treat as ordinary content).
                if (char === '`' && trailing.includes('`')) {
                    kept.push(rawLine);
                    continue;
                }
                // Opening delimiter — record fence state, drop this line
                openFence = { char, len };
            }
            else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
                // Closing delimiter (same char, sufficient length, no trailing content) — close and drop
                openFence = null;
            }
            // else: mismatched delimiter inside fence — treat as content, still drop (it's a fence line)
            continue; // all delimiter lines are dropped
        }
        if (openFence === null) {
            kept.push(rawLine); // non-fence content: keep as-is (preserve original \r if any)
        }
        // Lines inside a fence are silently dropped
    }
    return { text: kept.join('\n'), unterminatedFence: openFence !== null };
}
// ─── tokenizeHeadings ─────────────────────────────────────────────────────────
/**
 * Extract all ATX headings from `content` in document order.
 *
 * Only headings OUTSIDE fenced code blocks are returned — `stripFencedCode` is
 * applied first so that a `## heading` inside a ``` fence is not tokenised.
 *
 * Each token records `{ level, text, line, offset }` where `offset` is relative
 * to the ORIGINAL `content` (before fence-stripping), enabling callers to use
 * `collectSection` on the original string.
 */
function tokenizeHeadings(content) {
    if (typeof content !== 'string' || content.length === 0)
        return [];
    // Strip fences first so headings inside code blocks are ignored.
    // We need the original line positions, so we map stripped-text line numbers
    // back to original by tracking which original lines survived stripping.
    const originalLines = content.split('\n');
    const tokens = [];
    // We re-run the fence state machine to know which lines are "kept", so we
    // can map line index in original to whether it survived.
    const delimRe = /^( {0,3})(`{3,}|~{3,})(.*)$/;
    let openFence = null;
    // Accumulate character offset as we iterate lines
    let charOffset = 0;
    for (let i = 0; i < originalLines.length; i++) {
        const rawLine = originalLines[i];
        const line = rawLine.replace(/\r$/, '');
        const dm = delimRe.exec(line);
        if (dm) {
            const char = dm[2][0];
            const len = dm[2].length;
            const trailing = dm[3];
            if (openFence === null) {
                // CommonMark §4.5: backtick fence info string must not contain a backtick.
                if (char === '`' && trailing.includes('`')) {
                    // Not a valid fence opener — check for heading on this line (will fall through)
                }
                else {
                    openFence = { char, len };
                    charOffset += rawLine.length + 1;
                    continue;
                }
            }
            else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
                openFence = null;
                charOffset += rawLine.length + 1;
                continue;
            }
            else {
                // Mismatched/invalid delimiter inside fence — treat as content (still inside fence), skip heading check
                charOffset += rawLine.length + 1;
                continue;
            }
        }
        if (openFence === null) {
            // This line is outside any fence — check for ATX heading.
            // CommonMark: ≤3 leading spaces, then 1–6 `#`, then either EOF (empty heading)
            // or at least one space/tab followed by optional text, with optional closing `#` sequence.
            const headingMatch = /^( {0,3})(#{1,6})([ \t]+.*|[ \t]*)?$/.exec(line);
            if (headingMatch) {
                const hashes = headingMatch[2];
                const rest = headingMatch[3] ?? '';
                // Strip optional closing `#` sequence: trailing whitespace + one or more `#` + optional whitespace
                const rawText = rest.replace(/^[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '');
                tokens.push({
                    level: hashes.length,
                    text: rawText.trim(),
                    line: i + 1, // 1-based
                    offset: charOffset,
                });
            }
        }
        charOffset += rawLine.length + 1;
    }
    return tokens;
}
// ─── collectSections ─────────────────────────────────────────────────────────
/**
 * Collect sections from `content`, calling `stopPredicate` on each heading to
 * decide where sections end.
 *
 * Returns an array of `Section` objects, one per matched heading. The `body`
 * of each section runs from the line after the heading up to (but not
 * including) the next heading that satisfies `stopPredicate`, or EOF.
 *
 * Unlike a greedy-regex approach, this is a line-by-line walk — compatible
 * with the repo's "line-by-line section collection" pattern.
 */
function collectSections(content, stopPredicate) {
    if (typeof content !== 'string' || content.length === 0)
        return [];
    const headings = tokenizeHeadings(content);
    if (headings.length === 0)
        return [];
    const lines = content.split('\n');
    const sections = [];
    // Build a set of line numbers (1-based) that are heading lines
    const headingsByLine = new Map();
    for (const h of headings) {
        headingsByLine.set(h.line, h);
    }
    // Build a byte-offset table: lineOffsets[i] = byte offset of the start of line i+1 (1-based: i=0 → line 1)
    // The body of a section starts at the byte after the heading line's trailing '\n'.
    const lineOffsets = new Array(lines.length);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
        lineOffsets[i] = acc;
        acc += lines[i].length + 1; // +1 for the '\n' we split on
    }
    // lineOffsets[i] is the byte offset of line (i+1) (1-based). EOF sentinel:
    const eofOffset = acc; // === content.length + (content.endsWith('\n') ? 0 : 0) ≈ content.length
    let currentHeading = null;
    let currentBodyStart = 0;
    let bodyLines = [];
    const flush = (_bodyEndOffset) => {
        if (currentHeading !== null) {
            const rawBody = bodyLines.join('\n');
            const body = rawBody.trimEnd();
            // INVARIANT: content.slice(bodyStart, bodyEnd) === body
            // bodyEnd is derived from body.length, NOT from the raw separator offset,
            // so round-trips via replaceSection(content, section, section.body) are exact.
            sections.push({
                heading: currentHeading,
                body,
                bodyStart: currentBodyStart,
                bodyEnd: currentBodyStart + body.length,
            });
            currentHeading = null;
            bodyLines = [];
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1; // 1-based
        const h = headingsByLine.get(lineNo);
        if (h !== undefined && stopPredicate(h)) {
            // This heading is a stop boundary — flush current section, start new one.
            // The body ends at the start of this heading line.
            flush(lineOffsets[i]);
            currentHeading = h;
            // Body starts at the beginning of the line AFTER the heading line
            const headingLineIdx = h.line - 1; // 0-based
            currentBodyStart = lineOffsets[headingLineIdx] + lines[headingLineIdx].length + 1;
        }
        else if (currentHeading !== null) {
            bodyLines.push(lines[i]);
        }
    }
    flush(eofOffset);
    return sections;
}
// ─── collectSection ───────────────────────────────────────────────────────────
/**
 * Collect a single section whose heading satisfies `headingPredicate`.
 *
 * Options:
 * - `levelBounded` (default: `true`): the section ends at the next heading of
 *   the same or higher level (lower level number = higher in the hierarchy).
 *   When `false`, the section body runs until any heading or EOF.
 *   Ignored when `stopAtLevel` is provided.
 * - `stopAtLevel` (optional): when provided, the section ends at the next heading
 *   whose `level <= stopAtLevel`, regardless of the opener's level. This enables
 *   modeling sections like a `##`-opened section that also stops at `###`
 *   (pass `stopAtLevel: 3`). Takes precedence over `levelBounded` when set.
 * - `stripFences` (default: `false`): apply `stripFencedCode` to the body
 *   before returning. The `heading` in the result always refers to the original
 *   heading (pre-strip).
 *
 * Returns `null` when no matching heading is found.
 */
function collectSection(content, headingPredicate, opts = {}) {
    if (typeof content !== 'string' || content.length === 0)
        return null;
    const { levelBounded = true, stopAtLevel, stripFences = false } = opts;
    const headings = tokenizeHeadings(content);
    const targetIdx = headings.findIndex(headingPredicate);
    if (targetIdx === -1)
        return null;
    const target = headings[targetIdx];
    const lines = content.split('\n');
    // Determine which headings act as stops after the target
    const bodyStartLine = target.line + 1; // 1-based, first line of body
    let bodyEndLine = lines.length + 1; // 1-based, exclusive (default: EOF+1)
    for (let j = targetIdx + 1; j < headings.length; j++) {
        const next = headings[j];
        let isStop;
        if (stopAtLevel !== undefined) {
            // stopAtLevel: stop at the next heading whose level <= stopAtLevel
            isStop = next.level <= stopAtLevel;
        }
        else {
            isStop = levelBounded ? next.level <= target.level : true;
        }
        if (isStop) {
            bodyEndLine = next.line; // stop before this line (1-based)
            break;
        }
    }
    // Compute character offsets for bodyStart.
    // lineOffsets[i] = character offset of line (i+1) in content (1-based).
    const lineOffsets = new Array(lines.length);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
        lineOffsets[i] = acc;
        acc += lines[i].length + 1; // +1 for the '\n' separator
    }
    const eofOffset = acc; // byte offset past the last line
    // bodyStart: character offset of first line of body (bodyStartLine is 1-based)
    const bodyStartOffset = bodyStartLine <= lines.length ? lineOffsets[bodyStartLine - 1] : eofOffset;
    // Slice body lines (0-based array: bodyStartLine-1 to bodyEndLine-2 inclusive)
    const bodyRaw = lines.slice(bodyStartLine - 1, bodyEndLine - 1).join('\n').trimEnd();
    const body = stripFences ? stripFencedCode(bodyRaw).text : bodyRaw;
    // INVARIANT: content.slice(bodyStart, bodyEnd) === body
    // bodyEnd is derived from body.length so that replaceSection(content, section, section.body) === content.
    return { heading: target, body, bodyStart: bodyStartOffset, bodyEnd: bodyStartOffset + body.length };
}
// ─── iterateBullets ───────────────────────────────────────────────────────────
/**
 * Extract bullet items from `sectionText`.
 *
 * Recognises three marker families:
 * - **Checkbox**: `- [ ] text` (unchecked) and `- [x] text` / `- [X] text` (checked)
 * - **Dash**: `- text`, `* text`, `+ text` (plain unordered list item)
 * - **Numbered**: `1. text`, `42. text` (ordered list item)
 *
 * Indented continuation lines (lines that are not themselves bullet openers and
 * have at least one leading space or tab) are accumulated into the current
 * bullet's `text`.
 *
 * Blank lines terminate the current bullet (consistent with CommonMark block
 * handling and the repo's existing bullet parsers).
 */
function iterateBullets(sectionText) {
    if (typeof sectionText !== 'string' || sectionText.length === 0)
        return [];
    const lines = sectionText.split('\n');
    const items = [];
    // Checkbox bullet: `<indent>- [ ] text` or `<indent>- [x] text`
    const checkboxRe = /^(\s*)- \[([xX ])\] (.*)$/;
    // Plain dash/asterisk/plus bullet: `<indent>- text`, `<indent>* text`, `<indent>+ text`
    const dashRe = /^(\s*)[-*+] (.*)$/;
    // Numbered bullet: `<indent>1. text`
    const numberedRe = /^(\s*)\d+\. (.*)$/;
    // Continuation: non-empty, indented, NOT a bullet opener
    const continuationRe = /^[ \t]/;
    let current = null;
    const flush = () => {
        if (current !== null) {
            current.text = current.text.trim();
            items.push(current);
            current = null;
        }
    };
    for (const rawLine of lines) {
        // Strip trailing \r (CRLF safety)
        const line = rawLine.replace(/\r$/, '');
        const trimmed = line.trim();
        // Blank line terminates current bullet
        if (trimmed === '') {
            flush();
            continue;
        }
        // Checkbox bullet (checked or unchecked) — must test before dashRe
        const cbm = checkboxRe.exec(line);
        if (cbm) {
            flush();
            const stateChar = cbm[2];
            const checked = stateChar === 'x' || stateChar === 'X';
            current = {
                marker: checked ? 'checkbox-checked' : 'checkbox-unchecked',
                text: cbm[3],
                indent: cbm[1],
                checked,
            };
            continue;
        }
        // Numbered bullet
        const nm = numberedRe.exec(line);
        if (nm) {
            flush();
            current = {
                marker: 'numbered',
                text: nm[2],
                indent: nm[1],
                checked: null,
            };
            continue;
        }
        // Plain dash / asterisk / plus bullet
        const dm = dashRe.exec(line);
        if (dm) {
            flush();
            current = {
                marker: 'dash',
                text: dm[2],
                indent: dm[1],
                checked: null,
            };
            continue;
        }
        // Continuation line (indented, non-bullet) — append to current bullet
        if (current !== null && continuationRe.test(line)) {
            current.text += ' ' + trimmed;
            continue;
        }
        // Non-bullet, non-continuation line (e.g. a paragraph, heading) — flush
        flush();
    }
    flush();
    return items;
}
// ─── extractTaggedBlocks ──────────────────────────────────────────────────────
/**
 * Return the inner text of every `<tagName>…</tagName>` block in `content`,
 * in document order.
 *
 * Designed for extracting structured XML-like annotation blocks that live in
 * markdown prose (e.g. `<decisions>…</decisions>`, `<requirements>…</requirements>`).
 * Returns `[]` when no matching blocks are found.
 *
 * The `tagName` argument is regex-escaped, so names that contain regex
 * metacharacters (e.g. `foo.bar`, `my+tag`) are matched literally.
 *
 * **Input contract:** the caller decides whether to pass raw or fence-stripped
 * content. `extractTaggedBlocks` is a pure block extractor — it does NOT strip
 * fenced code blocks itself. If a `<tagName>` block appears inside a fenced code
 * block and should be excluded, the caller should apply `stripFencedCode` first.
 *
 * **Nested tags are NOT supported.** The underlying regex uses a non-greedy
 * `[\s\S]*?` match, which means it closes at the FIRST `</tagName>` encountered.
 * Given `<x><x>inner</x></x>`, `extractTaggedBlocks(content, 'x')` returns
 * `['<x>inner']` — the inner `<x>` is captured as literal text, and the second
 * `</x>` is left unmatched (or matched as a second block with empty inner text
 * if another `<x>` follows). Callers that need to handle nested tags must
 * pre-process the input or use a proper XML/HTML parser.
 *
 * Generalises `decisions.cts`'s bespoke `matchAll(/<decisions>([\s\S]*?)<\/decisions>/g)`
 * so tier T1 can drop its own copy (tracked duplication until T1 lands).
 */
function extractTaggedBlocks(content, tagName) {
    if (typeof content !== 'string' || content.length === 0)
        return [];
    if (typeof tagName !== 'string' || tagName.length === 0)
        return [];
    // Escape the tag name for safe interpolation into a RegExp.
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`, 'g');
    const results = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
        results.push(match[1]);
    }
    return results;
}
// ─── replaceSection ───────────────────────────────────────────────────────────
/**
 * Splice `newBody` in place of a section's body and return the resulting
 * full content string.
 *
 * Uses the `bodyStart`/`bodyEnd` character offsets carried by the `Section`
 * type to perform a pure string splice — no regex, no line-counting. The
 * heading is preserved verbatim; only the bytes between `bodyStart` and
 * `bodyEnd` are replaced.
 *
 * The `newBody` is inserted as-is between `content.slice(0, bodyStart)` and
 * `content.slice(bodyEnd)`. If `newBody` should end with a trailing newline
 * before the next section's heading, the caller is responsible for including
 * it (consistent with how `trimEnd()` is applied to collected bodies — see
 * `collectSections`/`collectSection`).
 *
 * Typical read-modify-write pattern (T6 state.cts use case):
 * ```
 * const section = collectSection(content, h => h.text === 'Name');
 * if (section) {
 *   content = replaceSection(content, section, newBody);
 * }
 * ```
 *
 * CRLF-safe: the splice is purely character-offset-based, so CRLF sequences
 * are preserved in the surrounding content unchanged.
 */
function replaceSection(content, section, newBody) {
    if (typeof content !== 'string')
        return content;
    if (typeof newBody !== 'string')
        return content;
    return content.slice(0, section.bodyStart) + newBody + content.slice(section.bodyEnd);
}
// Consumers: require('../gsd-core/bin/lib/markdown-sectionizer.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).

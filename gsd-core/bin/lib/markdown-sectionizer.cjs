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
    // Accumulate byte offset as we iterate lines
    let byteOffset = 0;
    for (let i = 0; i < originalLines.length; i++) {
        const rawLine = originalLines[i];
        const line = rawLine.replace(/\r$/, '');
        const dm = delimRe.exec(line);
        if (dm) {
            const char = dm[2][0];
            const len = dm[2].length;
            const trailing = dm[3];
            if (openFence === null) {
                openFence = { char, len };
            }
            else if (char === openFence.char && len >= openFence.len && /^\s*$/.test(trailing)) {
                openFence = null;
            }
            byteOffset += rawLine.length + 1; // +1 for the '\n' we split on
            continue;
        }
        if (openFence === null) {
            // This line is outside any fence — check for ATX heading
            const headingMatch = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
            if (headingMatch) {
                tokens.push({
                    level: headingMatch[1].length,
                    text: headingMatch[2].trim(),
                    line: i + 1, // 1-based
                    offset: byteOffset,
                });
            }
        }
        byteOffset += rawLine.length + 1;
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
    let currentHeading = null;
    let bodyLines = [];
    const flush = () => {
        if (currentHeading !== null) {
            sections.push({ heading: currentHeading, body: bodyLines.join('\n').trimEnd() });
            currentHeading = null;
            bodyLines = [];
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1; // 1-based
        const h = headingsByLine.get(lineNo);
        if (h !== undefined && stopPredicate(h)) {
            // This heading is a stop boundary — flush current section, start new one
            flush();
            currentHeading = h;
        }
        else if (currentHeading !== null) {
            bodyLines.push(lines[i]);
        }
    }
    flush();
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
 * - `stripFences` (default: `false`): apply `stripFencedCode` to the body
 *   before returning. The `heading` in the result always refers to the original
 *   heading (pre-strip).
 *
 * Returns `null` when no matching heading is found.
 */
function collectSection(content, headingPredicate, opts = {}) {
    if (typeof content !== 'string' || content.length === 0)
        return null;
    const { levelBounded = true, stripFences = false } = opts;
    const headings = tokenizeHeadings(content);
    const targetIdx = headings.findIndex(headingPredicate);
    if (targetIdx === -1)
        return null;
    const target = headings[targetIdx];
    const lines = content.split('\n');
    // Determine which headings act as stops after the target
    const bodyStartLine = target.line + 1; // 1-based, exclusive
    let bodyEndLine = lines.length + 1; // 1-based, exclusive (default: EOF)
    for (let j = targetIdx + 1; j < headings.length; j++) {
        const next = headings[j];
        const isStop = levelBounded ? next.level <= target.level : true;
        if (isStop) {
            bodyEndLine = next.line; // stop before this line
            break;
        }
    }
    // Slice body lines (0-based array: bodyStartLine-1 to bodyEndLine-2 inclusive)
    const bodyRaw = lines.slice(bodyStartLine - 1, bodyEndLine - 1).join('\n').trimEnd();
    const body = stripFences ? stripFencedCode(bodyRaw).text : bodyRaw;
    return { heading: target, body };
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
// Consumers: require('../gsd-core/bin/lib/markdown-sectionizer.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).

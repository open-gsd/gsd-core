'use strict';

/**
 * Parses a changeset fragment file (text → typed record).
 *
 *   ---
 *   type: Fixed
 *   pr: 2975
 *   ---
 *   <markdown body>
 *
 * Returns { ok: true, fragment: { type, pr, body, docsExempt } } on success,
 * { ok: false, reason: FRAGMENT_ERROR.X, detail } on failure.
 *
 * `docsExempt` is `null` when the body contains no docs-exempt marker, or the
 * trimmed reason string when the body contains `<!-- docs-exempt: <reason> -->`
 * (#3213). The marker is stripped from `body` at parse time so it never bleeds
 * into the CHANGELOG.md or GitHub release-notes serializers, which append the
 * `(#NNNN)` PR suffix verbatim to the body's last line.
 *
 * The reason field is a frozen enum so tests assert on stable codes,
 * not free-text error messages (CONTRIBUTING.md: "Prohibited: Raw
 * Text Matching on Test Outputs").
 */
const FRAGMENT_ERROR = Object.freeze({
  MISSING_FRONTMATTER: 'missing_frontmatter',
  MISSING_TYPE: 'missing_type',
  INVALID_TYPE: 'invalid_type',
  MISSING_PR: 'missing_pr',
  INVALID_PR: 'invalid_pr',
  EMPTY_BODY: 'empty_body',
});

const ALLOWED_TYPES = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

// HTML comment marking a fragment as exempt from the docs-required lint (#3213).
// Form: `<!-- docs-exempt: <reason> -->`. The reason is the *required* human
// audit trail — without it the exemption has no paper-trail value, so a bare
// `<!-- docs-exempt -->` or empty `<!-- docs-exempt: -->` is intentionally
// rejected (the colon and a non-whitespace first reason char are mandatory).
//
// Anchored with `^...$` + `m` flag so the marker only counts when it occupies
// its own line. Inline mentions inside paragraphs (e.g. backtick-wrapped
// syntax examples in documentation) are not matched — they cannot
// accidentally exempt a fragment.
//
// The trailing `\r?` consumes the CR character of a CRLF line terminator,
// which the `$` boundary (multiline mode) does not — so Windows-authored
// fragments produce the same `body` shape as LF-authored ones. The reason
// character class `[^\r\n>]` excludes `\r` for the same reason: a CRLF
// fragment's reason text never carries a trailing `\r`.
//
// Bounded character class `[^\r\n>]` keeps the regex linear-time — no
// catastrophic backtracking on adversarial input. The leading `\S` anchor
// inside the capture group forces at least one non-whitespace character in
// the reason; trailing whitespace before `-->` is consumed by the outer
// `[ \t]*-->` and is not part of the captured reason.
const DOCS_EXEMPT_RE = /^[ \t]*<!--[ \t]*docs-exempt[ \t]*:[ \t]*(\S[^\r\n>]*?)[ \t]*-->[ \t]*\r?$/im;

function extractDocsExempt(body) {
  const m = body.match(DOCS_EXEMPT_RE);
  if (!m) return { docsExempt: null, body };
  const reason = (m[1] || '').trim();
  // Strip the marker line and tidy up the surrounding whitespace. The cleanup
  // is CRLF-aware so Windows-authored fragments don't leave residual `\r`
  // characters that would shift the `(#NNNN)` PR suffix to a blank line in
  // the rendered CHANGELOG.md / GitHub release-notes bullet.
  //
  // Both leading AND trailing line terminators are stripped. `DOCS_EXEMPT_RE`
  // removes the marker's own text but its `$` anchor (multiline mode) does
  // not consume the `\n` that terminates the marker's line. When the marker
  // is the FIRST line of the body, that leftover `\n` becomes the new first
  // character of `body` — serializeChangelog then emits an empty `- ` bullet
  // followed by an orphaned continuation paragraph, and parseChangelog's
  // bullet-continuation check (which requires a leading `\s`) treats that
  // non-indented paragraph as terminating the bullet, silently dropping the
  // entry's content on re-parse. Stripping leading terminators here closes
  // that gap the same way the trailing strip already does for the opposite
  // (marker-last) position.
  const cleaned = body
    .replace(DOCS_EXEMPT_RE, '')
    .replace(/[ \t\r]+$/gm, '')             // strip trailing \r/spaces on each line
    .replace(/(?:\r?\n){3,}/g, '\n\n')      // collapse 3+ blank lines (CRLF-aware)
    .replace(/^[\r\n]+/, '')                // strip terminators left by a first-line marker
    .replace(/[\r\n]+$/, '');               // strip every trailing line terminator
  return { docsExempt: reason, body: cleaned };
}

/**
 * A self-contained copy of `locateFrontmatterFence` (src/frontmatter-fence.cts, the one
 * frontmatter fence owner). Kept here, not required from the built
 * `gsd-core/bin/lib/frontmatter-fence.cjs`, because this module runs before any build: the
 * `changeset-lint` job in .github/workflows/changeset-required.yml checks out and runs
 * `node scripts/changeset/lint.cjs` with no `npm ci` and no `build:lib`. Found while
 * implementing #5105: tests/frontmatter-fence.test.cjs ("kept frontmatter fence copies agree
 * with the owner") pins this copy to the owner over a fixture corpus and a property test, and
 * scripts/lint-frontmatter-fence-drift.cjs allowlists exactly this function.
 */
function locateFrontmatterFence(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`locateFrontmatterFence: expected a string, got ${typeof text}`);
  }
  const closingFenceLine = /^---[ \t]*$/;
  const lenientClosingFenceLine = /^-{4,}[ \t]*$/;
  const bom = text.charCodeAt(0) === 0xfeff ? text.slice(0, 1) : '';
  const start = bom.length;
  let eol;
  if (text.startsWith('---\r\n', start)) eol = '\r\n';
  else if (text.startsWith('---\n', start)) eol = '\n';
  else return null;
  const openEnd = start + 3 + eol.length;
  const closedAt = (lineStart, lineEnd) => {
    let bodyEnd = openEnd;
    if (lineStart > openEnd) {
      bodyEnd = lineStart - 1;
      if (bodyEnd > openEnd && text[bodyEnd - 1] === '\r') bodyEnd -= 1;
    }
    return { bom, eol, openEnd, closed: true, closingStart: lineStart, closingFenceEnd: lineEnd, bodyEnd };
  };
  let lenient = null;
  let lineStart = openEnd;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline > lineStart && text[newline - 1] === '\r' ? newline - 1 : newline;
    const line = text.slice(lineStart, lineEnd);
    if (closingFenceLine.test(line)) return closedAt(lineStart, lineEnd);
    if (lenient === null && lenientClosingFenceLine.test(line)) lenient = [lineStart, lineEnd];
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (lenient !== null) return closedAt(lenient[0], lenient[1]);
  return { bom, eol, openEnd, closed: false, closingStart: -1, closingFenceEnd: -1, bodyEnd: text.length };
}

function parseFragment(src) {
  const fence = locateFrontmatterFence(src);
  if (!fence || !fence.closed) return { ok: false, reason: FRAGMENT_ERROR.MISSING_FRONTMATTER };
  const fmBlock = src.slice(fence.openEnd, fence.bodyEnd);
  // Everything past the closing fence line and its line ending.
  const body = src.slice(fence.closingFenceEnd).replace(/^\r?\n/, '');

  const fields = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }

  if (!fields.type) return { ok: false, reason: FRAGMENT_ERROR.MISSING_TYPE };
  if (!ALLOWED_TYPES.has(fields.type)) {
    return { ok: false, reason: FRAGMENT_ERROR.INVALID_TYPE, detail: fields.type };
  }
  if (!fields.pr) return { ok: false, reason: FRAGMENT_ERROR.MISSING_PR };
  const pr = Number(fields.pr);
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, reason: FRAGMENT_ERROR.INVALID_PR, detail: fields.pr };
  }
  // Use trim() only for the emptiness check; preserve the body verbatim
  // (including significant leading/trailing whitespace, code blocks, etc.)
  // so render → serialize round-trips exactly. Strip the single trailing
  // line terminator added by editors so byte-equality holds for typical
  // fragments. CRLF-aware: a Windows-authored fragment trims `\r\n` so the
  // marker line in extractDocsExempt does not leave residual `\r` characters
  // for downstream serializers to attach `(#NNNN)` to (#3213).
  if (!body.trim()) return { ok: false, reason: FRAGMENT_ERROR.EMPTY_BODY };
  let verbatimBody;
  if (body.endsWith('\r\n')) verbatimBody = body.slice(0, -2);
  else if (body.endsWith('\n')) verbatimBody = body.slice(0, -1);
  else verbatimBody = body;
  // Some fragments have a blank line between the closing frontmatter `---`
  // and the first line of actual content (purely a stylistic authoring
  // choice — the blank line carries no significant content, unlike
  // indentation inside a code block). Strip any such leading blank line(s)
  // here, mirroring the trailing-terminator strip above. Without this,
  // `body` starts with `\n`/`\r\n`, serializeChangelog emits an empty `- `
  // bullet followed by an orphaned paragraph, and parseChangelog's
  // continuation check (requires a leading `\s` on the line) treats that
  // non-indented paragraph as terminating the bullet — silently dropping
  // the fragment's content on re-parse. This is the same downstream failure
  // mode as a first-line docs-exempt marker (see extractDocsExempt below);
  // it just arises from plain authoring whitespace instead of a marker.
  verbatimBody = verbatimBody.replace(/^(?:[ \t]*\r?\n)+/, '');
  const { docsExempt, body: visibleBody } = extractDocsExempt(verbatimBody);
  if (!visibleBody.trim()) return { ok: false, reason: FRAGMENT_ERROR.EMPTY_BODY };

  return { ok: true, fragment: { type: fields.type, pr, body: visibleBody, docsExempt } };
}

module.exports = { parseFragment, extractDocsExempt, locateFrontmatterFence, FRAGMENT_ERROR, ALLOWED_TYPES, DOCS_EXEMPT_RE };

#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the ROADMAP Progress-table and phase-entry
 * seams (epic #5692, issue #5765, ADR-2143 section 7).
 *
 * Two modules are the only legitimate home of two questions:
 *   - `src/roadmap-progress.cts`   "which table is the Progress table, and what
 *     is its milestone slice" (Phases 1-2: readers and writers).
 *   - `src/phase-entry-grammar.cts` "what is a phase-list entry" (bullet marker,
 *     checkbox, bold token, anchoring) (Phases 3-4: readers and writers).
 * The census in #5703 found 12 hand-written Progress locators and 26 hand-written
 * phase-entry patterns that had drifted apart. After Phases 1-4 none remain
 * outside the owners. This guard keeps it that way: the next local `## Progress`
 * regex, Progress-table `.replace()` or `- [ ] Phase` pattern fails `lint:ci`.
 *
 * Four classes are detected, per source line, with comments stripped first (a
 * comment documenting an owner is not a re-derivation of it):
 *   progress-heading        a regex literal, or a string literal, that spells a
 *                           level-N heading followed by `Progress` using regex
 *                           syntax (`/^##[ \t]+Progress\b/im`, `#{1,3}\s*Progress`).
 *   progress-title          the bare title test (`/^Progress\b/i`, `'Progress\\b'`)
 *                           that the bracket writers used to share.
 *   progress-table-replace  `.replace(` / `.replaceAll(` on a line that names
 *                           ROADMAP content together with Progress or with an
 *                           escaped-pipe table-row literal (ADR-2143 section 7(b)).
 *   phase-entry-checkbox    a literal that carries an escaped checkbox class
 *                           (`\[[ xX]\]`, `\[( |x)\]`, `\[x\]`) AND the word
 *                           `Phase` (`- [ ] **Phase 1: Name**`).
 *
 * What is NOT flagged, on purpose: a literal heading BUILT for output
 * (`'## Progress\n'`, no regex syntax), the STATE.md `Progress:` field, status
 * vocabulary (`IN PROGRESS`), and requirement / plan-row checkboxes (no `Phase`).
 * Those answer different questions owned elsewhere.
 *
 * Owner exemption is per class, never per file: `roadmap-progress.cts` defines the
 * first three classes and `phase-entry-grammar.cts` defines the fourth. Each owner
 * is still scanned for the classes it does not own, so a stray pattern added to an
 * owner is caught (ADR-3180 Decision 4(d)). There is no allowlist file and no
 * function-scoped exemption: Phases 1-4 left nothing to allow.
 *
 * The guard carries its own positive control. Every run first feeds a fixture
 * violation of each class through the same detector and requires it to be flagged,
 * and feeds clean fixtures and requires silence. A guard that cannot go red must
 * not report green, so a detector that stops matching fails `lint:ci` here, in the
 * same run, not only in a test file nobody reads. The tree-walk, root confinement,
 * regex-literal tokenizer and report sanitizer are shared with the sibling drift
 * guards through `scripts/lib/drift-scan.cjs`.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the sibling
 * guards document): a pattern whose tokens sit on different lines, or one routed
 * through dynamic dispatch, is not caught. The cross-site property tests of
 * Phases 1-4 and code review cover that.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// Authored source and hooks. Generated mirrors (`gsd-core/bin/lib/*.cjs`) are
// build output of `src/`; `scripts/` carries these tokens as detector text and
// `tests/` builds ROADMAP fixtures on purpose.
const SCAN_DIRS = ['src', 'hooks'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts', '.cjs', '.js', '.mjs']);

const CLASS = Object.freeze({
  PROGRESS_HEADING: 'progress-heading',
  PROGRESS_TITLE: 'progress-title',
  PROGRESS_TABLE_REPLACE: 'progress-table-replace',
  PHASE_ENTRY_CHECKBOX: 'phase-entry-checkbox',
});

const PROGRESS_OWNER = 'src/roadmap-progress.cts';
const GRAMMAR_OWNER = 'src/phase-entry-grammar.cts';

// Which classes each owner DEFINES (and so may spell). Everything else about an
// owner file is scanned like any other file.
const OWNED_CLASSES = new Map([
  [PROGRESS_OWNER, new Set([CLASS.PROGRESS_HEADING, CLASS.PROGRESS_TITLE, CLASS.PROGRESS_TABLE_REPLACE])],
  [GRAMMAR_OWNER, new Set([CLASS.PHASE_ENTRY_CHECKBOX])],
]);

// A level-N heading marker (`#`, `##`, `#+`, `#*`, `#{1,3}`) followed only by
// whitespace tokens, quantifiers or classes (`\s*`, `[ \t]+`, ` {1,3}`, a space)
// and then the word `Progress`. Every alternative is bounded or a single
// character class, so the test is linear (CodeQL js/redos runs on `lint:ci`).
const HEADING_THEN_PROGRESS_RE =
  /#(?:\{\d{1,2},\d{1,2}\}|#{0,5}|[+*])(?:\\{1,2}[sSh][*+?]?|\[[ \\t]{1,6}\][*+?]?|\{\d{1,2}(?:,\d{0,2})?\}|[ ]|[*+?])*[*_]{0,2}(?:\(\?:)?Progress/i;
// Regex syntax inside the matched heading text: an escape, a class, a quantifier
// brace, a repeat. A plain `## Progress` is a heading someone is WRITING.
const REGEX_SYNTAX_RE = /[\\[\]{}+*]/;
const CARET_BEFORE_HASH_RE = /\^[ \t]*#/;

// The bare Progress title test: `Progress` followed by a word boundary, right
// after a delimiter, an anchor or an alternation bar.
const PROGRESS_TITLE_RE = /(?:^['"`/]|\^|\|)(?:\\{1,2}s[*+]?)?Progress\\{1,2}b/i;

const REPLACE_CALL_RE = /\.replace(?:All)?\(/;
const ROADMAP_WORD_RE = /roadmap/i;
const PROGRESS_WORD_RE = /progress/i;
// An escaped pipe in a regex literal or a RegExp source string: a table-row shape.
const ESCAPED_PIPE_RE = /\\{1,2}\|/;

// A checkbox written as regex syntax: `\[` + a box interior + `\]`. The interior is
// one of ` `/`x`/`X`, `\s`, a class (`[ xX]`, `[x ]`) or a group (`( |x)`, `([xX ])`).
// A checkbox literal in a template that EMITS an entry (`- [ ] **Phase 1**`) has no
// backslashes and is not a pattern.
const ESCAPED_CHECKBOX_RE =
  /\\{1,2}\[(?:[ xX]|\\{1,2}s[*+]?|\[[^\]\n]{1,6}\]|\([^)\n]{1,8}\))\\{1,2}\]/;
const PHASE_WORD_RE = /\bPhase\b/;

/**
 * Read the quoted or backtick-delimited string literal starting at `line[start]`.
 * Returns `{ text, end }` (text includes both delimiters) or null when no close
 * quote is found within MAX_REGEX_LITERAL_LEN characters. Same single left-to-right,
 * no-backtracking, escape-aware pass as the shared `readRegexLiteralAt`.
 */
function readStringLiteralAt(line, start) {
  const quote = line[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const limit = Math.min(line.length, start + MAX_REGEX_LITERAL_LEN);
  for (let i = start + 1; i < limit; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') return null;
    if (ch === quote) return { text: line.slice(start, i + 1), end: i + 1 };
  }
  return null;
}

/**
 * Strip comment text before detection: a guard that fires on a comment trains
 * readers to add exemptions for documentation. Whole-line block-comment
 * continuations and `//` comments are dropped; a trailing `//` after code is cut.
 * Conservative on purpose: a `//` inside a string cuts the line early, which
 * under-reports on that line and never reports prose as drift.
 */
function stripComments(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    else if (ch === '/' && line[i + 1] !== '*') {
      const re = readRegexLiteralAt(line, i);
      if (re) i = re.end - 1;
    }
  }
  return line;
}

/** Every regex literal and quoted/backtick string literal on `line`, in order. */
function literalsOn(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    if (ch === '/') literal = readRegexLiteralAt(line, i);
    else if (ch === "'" || ch === '"' || ch === '`') literal = readStringLiteralAt(line, i);
    if (!literal) continue;
    out.push(literal.text);
    i = literal.end - 1;
  }
  return out;
}

function isProgressHeadingLiteral(text) {
  const match = HEADING_THEN_PROGRESS_RE.exec(text);
  if (!match) return false;
  return REGEX_SYNTAX_RE.test(match[0].slice(1)) || CARET_BEFORE_HASH_RE.test(text);
}

/**
 * Pure: every unsanctioned Progress / phase-entry pattern in `text`.
 * `relPath` is the repo-relative POSIX path, used to report file:line and to apply
 * the per-class owner exemption. Returns [{ line, cls, found }].
 */
function findProgressDrift(text, relPath) {
  const owned = OWNED_CLASSES.get(relPath) || new Set();
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComments(raw);
    if (!code.trim()) continue;
    const literals = literalsOn(code);
    const report = (cls, found) => {
      if (!owned.has(cls)) out.push({ line: i + 1, cls, found: found.slice(0, MAX_REGEX_LITERAL_LEN) });
    };

    const headingLiteral = literals.find(isProgressHeadingLiteral);
    if (headingLiteral !== undefined) report(CLASS.PROGRESS_HEADING, headingLiteral);

    const titleLiteral = literals.find((t) => PROGRESS_TITLE_RE.test(t));
    if (titleLiteral !== undefined) report(CLASS.PROGRESS_TITLE, titleLiteral);

    if (REPLACE_CALL_RE.test(code) && ROADMAP_WORD_RE.test(code)
      && (PROGRESS_WORD_RE.test(code) || literals.some((t) => ESCAPED_PIPE_RE.test(t)))) {
      report(CLASS.PROGRESS_TABLE_REPLACE, code.trim());
    }

    const checkboxLiteral = literals.find((t) => ESCAPED_CHECKBOX_RE.test(t) && PHASE_WORD_RE.test(t));
    if (checkboxLiteral !== undefined) report(CLASS.PHASE_ENTRY_CHECKBOX, checkboxLiteral);
  }
  return out;
}

const toPosix = (rel) => rel.split(path.sep).join('/');

function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      const posix = toPosix(rel);
      return findProgressDrift(text, posix).map((d) => ({ file: posix, ...d }));
    },
  });
}

// ---------------------------------------------------------------------------
// Positive control. One fixture per class that MUST be flagged, one per class
// that must NOT, and the owner-exemption boundary. The fixtures are source text
// handed to the same detector; nothing here touches the tree.
// ---------------------------------------------------------------------------
const FIXTURE_PATH = 'src/fixture-violation.cts';

const MUST_FLAG = [
  { cls: CLASS.PROGRESS_HEADING, text: 'const m = content.match(/^##[ \\t]+Progress\\b/im);' },
  { cls: CLASS.PROGRESS_HEADING, text: 'const re = new RegExp(`^#{1,3}\\\\s*Progress`);' },
  { cls: CLASS.PROGRESS_TITLE, text: 'const isProgress = (t) => /^Progress\\b/i.test(t);' },
  { cls: CLASS.PROGRESS_TITLE, text: "const SRC = 'Progress\\\\b';" },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = roadmapContent.replace(progressRowRe, row);' },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = roadmap.replaceAll(/\\|\\s*3\\.\\s*Three\\s*\\|/g, "| 3. Three |");' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = /^- \\[ \\] \\*\\*Phase (\\d+)/m;' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = new RegExp(`-\\\\s*\\\\[[ xX]\\\\]\\\\s*\\\\*\\\\*Phase ${n}`);' },
];

const MUST_STAY_CLEAN = [
  // A heading being WRITTEN: no regex syntax.
  { name: 'heading builder', text: "const heading = '## Progress\\n\\n';" },
  // STATE.md field, status vocabulary, other checkboxes.
  { name: 'STATE progress field', text: 'const m = /^Progress: (.*)$/m.exec(body);' },
  { name: 'status vocabulary', text: 'const m = content.match(/##\\s*Status:\\s*(OPEN|IN PROGRESS)/i);' },
  { name: 'requirement checkbox', text: 'const re = /^- \\[[ xX]\\] \\*\\*REQ-\\d+\\*\\*/m;' },
  { name: 'emitted entry', text: 'const line = `- [ ] **Phase ${n}: ${name}**`;' },
  { name: 'comment', text: '// the old /^##[ \\t]+Progress\\b/im and /^- \\[ \\] \\*\\*Phase/ shapes' },
  { name: 'unrelated replace', text: 'const out = roadmapContent.replace(/\\r\\n/g, "\\n");' },
];

/**
 * Run the positive and negative controls. Returns a list of human-readable
 * failures; empty means the detector can go red where it must and stays quiet where
 * it must.
 */
function runPositiveControl() {
  const failures = [];
  for (const fixture of MUST_FLAG) {
    const found = findProgressDrift(fixture.text, FIXTURE_PATH).filter((d) => d.cls === fixture.cls);
    if (found.length === 0) failures.push(`not flagged (${fixture.cls}): ${fixture.text}`);
  }
  for (const fixture of MUST_STAY_CLEAN) {
    const found = findProgressDrift(fixture.text, FIXTURE_PATH);
    if (found.length > 0) failures.push(`flagged but clean (${fixture.name}): ${found.map((d) => d.cls).join(',')}`);
  }
  // Owner boundary: each owner may spell its own classes and nothing else.
  const progressSpelling = MUST_FLAG.find((f) => f.cls === CLASS.PROGRESS_HEADING).text;
  const checkboxSpelling = MUST_FLAG.find((f) => f.cls === CLASS.PHASE_ENTRY_CHECKBOX).text;
  const boundary = [
    [PROGRESS_OWNER, progressSpelling, 0, 'progress owner may spell a Progress heading'],
    [PROGRESS_OWNER, checkboxSpelling, 1, 'progress owner may NOT spell a phase-entry checkbox'],
    [GRAMMAR_OWNER, checkboxSpelling, 0, 'grammar owner may spell a phase-entry checkbox'],
    [GRAMMAR_OWNER, progressSpelling, 1, 'grammar owner may NOT spell a Progress heading'],
  ];
  for (const [rel, text, expected, label] of boundary) {
    const count = findProgressDrift(text, rel).length;
    if (count !== expected) failures.push(`owner boundary (${label}): expected ${expected}, got ${count}`);
  }
  return failures;
}

function main() {
  const controlFailures = runPositiveControl();
  if (controlFailures.length > 0) {
    process.stderr.write('roadmap-progress-drift: the guard failed its own positive control; a detector that cannot go red is not a guard.\n');
    for (const f of controlFailures) process.stderr.write(`  ${f}\n`);
    process.exitCode = 1;
    return;
  }
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok roadmap-progress-drift: no hand-written Progress-table or phase-entry pattern outside roadmap-progress.cts and phase-entry-grammar.cts (positive control passed)\n');
    return;
  }
  process.stderr.write('roadmap-progress-drift: hand-written Progress-table or phase-entry pattern(s) found.\n');
  process.stderr.write('Locate and edit the Progress table through src/roadmap-progress.cts (`locateRoadmapProgress`, `findProgressSection`,\n');
  process.stderr.write('`editRoadmapProgress`) and compose phase-entry patterns from src/phase-entry-grammar.cts (`phaseEntryRegExp`,\n');
  process.stderr.write('`phaseEntrySplitRegExp`) instead of spelling them again:\n');
  for (const d of violations) {
    // The path is as attacker-controlled as the matched text: sanitize both.
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line}  [${d.cls}]  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findProgressDrift,
  scanRepo,
  runPositiveControl,
  CLASS,
  PROGRESS_OWNER,
  GRAMMAR_OWNER,
  OWNED_CLASSES,
  SCAN_DIRS,
  MUST_FLAG,
  MUST_STAY_CLEAN,
  stripComments,
  literalsOn,
  readStringLiteralAt,
};

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
 *   progress-table-replace  `.replace(` / `.replaceAll(` whose FIRST argument is a
 *                           Progress-table pattern: a regex naming `Progress` or
 *                           `Plans Complete`, a table-row regex (two or more
 *                           escaped pipes) on a line that names ROADMAP content, or
 *                           an identifier such as `progressRowRe` (ADR-2143
 *                           section 7(b)). It looks at the first argument only, so
 *                           `roadmap.title.replace(/\|/g, '\\|')` is not flagged.
 *   phase-entry-checkbox    a literal that carries an escaped checkbox class
 *                           (`\[[ xX]\]`, `\[( |x)\]`, `\[x\]`, `\[.\]`) AND the word
 *                           `Phase` (`- [ ] **Phase 1: Name**`).
 *
 * What is NOT flagged, on purpose: a heading BUILT for output (`'## Progress\n'`,
 * `'## **Progress**\n'`: no regex syntax), the STATE.md `Progress:` field, status
 * vocabulary (`IN PROGRESS`, `/^(done|progress\b)/`), the heading bracket tag
 * (`### [tag] Phase N:`) and requirement / plan-row checkboxes (no `Phase`). Those
 * answer different questions owned elsewhere.
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
 * literal tokenizers and report sanitizer are shared with the sibling drift guards
 * through `scripts/lib/drift-scan.cjs`.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the sibling
 * guards document): a pattern whose tokens sit on different lines, one assembled
 * from several literals, one routed through dynamic dispatch, or a `.replace()` on a
 * variable whose name says neither ROADMAP nor Progress is not caught. The detector
 * is name-sensitive on purpose: it prefers a missed exotic shape to a false
 * positive on ordinary new code, because a guard that cries wolf gets exempted. The
 * cross-site property tests of Phases 1-4 and code review cover the rest.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, readStringLiteralAt, MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

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

// A level-N heading marker (`#`, `##`, `#+`, `#*`, `#{1,3}`) followed by whitespace
// tokens, classes or a quantified gap (`\s*`, `[ \t]+`, ` {1,3}`, a space) and then
// the word `Progress`. The gap group is a bounded repeat of alternatives that
// cannot consume the same character two ways (a quantifier belongs to the token
// before it, never to the group), so matching is linear in the literal length: a
// repeat of `*` or `+` as its own alternative would make `\s*\s*\s*...` ambiguous
// and exponential (CodeQL js/redos runs on `lint:ci`).
const HEADING_THEN_PROGRESS_RE =
  /#(?:\{\d{1,2},\d{1,2}\}|#{0,5}|[+*])(?:\\{1,2}[sSh][*+?]?|\[[ \\t]{1,6}\][*+?]?|\{\d{1,2}(?:,\d{0,2})?\}| ){0,12}[*_]{0,2}(?:\(\?:|\()?Progress/i;
// The tail the bold marker and the group opener add (`**Progress`, `(?:Progress`):
// not regex syntax in the gap, so it is cut before the syntax test.
const PROGRESS_TAIL_RE = /[*_]{0,2}(?:\(\?:|\()?Progress$/i;
// Regex syntax inside the heading gap: an escape, a class, a quantifier brace, a
// repeat. A plain `## Progress` (or `## **Progress**`) is a heading someone is WRITING.
const REGEX_SYNTAX_RE = /[\\[\]{}+*]/;
const CARET_BEFORE_HASH_RE = /\^[ \t]*#/;

// The bare Progress title test: `Progress` followed by a word boundary, right after
// a quote, a slash or an anchor. Not after `|`: `/^(done|progress\b)/` is status
// vocabulary, not a heading test.
const PROGRESS_TITLE_RE = /(?:^['"`/]|\^)(?:\\{1,2}s[*+]?)?Progress\\{1,2}b/i;

const REPLACE_CALL_G = /\.replace(?:All)?\s*\(/g;
const ROADMAP_WORD_RE = /roadmap/i;
// A first-argument identifier that names a Progress table pattern: `progressRowRe`,
// `PROGRESS_TABLE_RE`, `progressSectionPattern`.
const PROGRESS_PATTERN_IDENT_RE = /progress[_\w$]{0,40}?(?:table|row|section|heading)/i;
const PROGRESS_WORD_RE = /progress/i;
// The Progress table's own header text (`Plans Complete`), with a literal or escaped space.
const PLANS_COMPLETE_RE = /Plans(?: |\\{1,2}s[*+]?)Complete/i;
const ESCAPED_PIPE_G = /\\{1,2}\|/g;

// A checkbox written as regex syntax: `\[` + a box interior + `\]`. The interior is
// 1 to 12 characters drawn from the box alphabet: a space, `x`/`X`, `.`, `\s`, class
// and group punctuation and the quantifiers (`[ xX]`, `[x ]`, `( |x)`, `([xX ])`,
// ` ?[xX]? ?`, `.`). Letters other than x/X, digits and `^` are outside it, so a
// markdown link such as `\[Phase 1\]` and the heading bracket tag
// `\[[^\]]{1,200}\]` (a different seam: `### [tag] Phase N:`) are not checkboxes. A
// checkbox literal in a template that EMITS an entry (`- [ ] **Phase 1**`) has no
// backslashes and is not a pattern.
const ESCAPED_CHECKBOX_RE = /\\{1,2}\[[ xX.\\s?*+|()[\]-]{1,12}\\{1,2}\]/;
// The word `Phase`, case-insensitive, not inside a longer word or a hyphenated name
// (`Phase-gate`), and also right after a regex class escape (`\sPhase`).
const PHASE_WORD_RE = /(?:^|[^A-Za-z]|\\[sSwWdDbB])Phase(?![A-Za-z-])/i;

/**
 * Strip comment text before detection: a guard that fires on a comment trains
 * readers to add exemptions for documentation. Whole-line `//` comments and block
 * comment continuations are dropped, a block comment opened and closed on the line
 * is cut out, and a trailing `//` after code is cut. Quote- and regex-aware, so
 * `https://` in a string or `//` inside a regex literal does not cut the line (the
 * older guards use `indexOf('//')` and over-cut). Kept local rather than shared
 * because each guard applies comment stripping at a different point of its
 * pipeline and the variants differ on purpose.
 */
function stripComments(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('/*')) {
    const close = line.indexOf('*/');
    return close === -1 ? '' : stripComments(line.slice(close + 2));
  }
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return '';
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
      // A `/` may open a regex literal or be a division. A real literal is skipped so
      // a `//` inside it is not read as a comment; a division reads as a "literal"
      // that closes at the next `/`, which only ever skips code, never a comment
      // opener that follows it on the same line (that case is re-checked below).
      const re = readRegexLiteralAt(line, i);
      if (re && !re.text.slice(1, -1).includes('//')) i = re.end - 1;
    }
  }
  return line;
}

/**
 * Every regex literal and quoted/backtick string literal on `line`, in order. A `/`
 * is either a regex opener or a division, and the two cannot be told apart without
 * a parser, so each `/` yields a CANDIDATE literal and scanning resumes just after
 * the opening `/` (candidates overlap): `done / total, re = /^##\s+Progress/m`
 * yields the division pseudo-literal and the real regex. Strings are exact, so a
 * string literal is consumed whole.
 */
function literalsOn(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '/') {
      const literal = readRegexLiteralAt(line, i);
      if (literal) out.push(literal.text);
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const literal = readStringLiteralAt(line, i);
      if (literal) {
        out.push(literal.text);
        i = literal.end - 1;
      }
    }
  }
  return out;
}

function isProgressHeadingLiteral(text) {
  const match = HEADING_THEN_PROGRESS_RE.exec(text);
  if (!match) return false;
  const gap = match[0].slice(1).replace(PROGRESS_TAIL_RE, '');
  return REGEX_SYNTAX_RE.test(gap) || CARET_BEFORE_HASH_RE.test(text);
}

/**
 * The first argument of the `.replace(` / `.replaceAll(` call that opens at
 * `code[open]` (the index just past the `(`): a regex literal, a string literal or
 * an identifier path. Null when the argument is anything else.
 */
function firstReplaceArgument(code, open) {
  let i = open;
  while (code[i] === ' ' || code[i] === '\t') i++;
  const ch = code[i];
  if (ch === '/') {
    const literal = readRegexLiteralAt(code, i);
    return literal ? { kind: 'regex', text: literal.text } : null;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    const literal = readStringLiteralAt(code, i);
    return literal ? { kind: 'string', text: literal.text } : null;
  }
  const ident = /^[A-Za-z_$][\w$.]*/.exec(code.slice(i, i + 120));
  return ident ? { kind: 'identifier', text: ident[0] } : null;
}

function isProgressTableReplace(code) {
  const namesRoadmap = ROADMAP_WORD_RE.test(code);
  for (const call of code.matchAll(REPLACE_CALL_G)) {
    const arg = firstReplaceArgument(code, call.index + call[0].length);
    if (!arg) continue;
    if (arg.kind === 'identifier') {
      if (PROGRESS_PATTERN_IDENT_RE.test(arg.text) || (namesRoadmap && PROGRESS_WORD_RE.test(arg.text))) return true;
      continue;
    }
    if (PLANS_COMPLETE_RE.test(arg.text)) return true;
    if (namesRoadmap && (PROGRESS_WORD_RE.test(arg.text) || (arg.text.match(ESCAPED_PIPE_G) || []).length >= 2)) return true;
  }
  return false;
}

/**
 * Pure: every unsanctioned Progress / phase-entry pattern in `text`.
 * `relPath` is the repo-relative POSIX path, used to report file:line and to apply
 * the per-class owner exemption. Returns [{ line, cls, found }], where `found` is
 * the matched literal (or the offending line for the replace class).
 */
function findProgressDrift(text, relPath) {
  const owned = OWNED_CLASSES.get(relPath) || new Set();
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i]);
    if (!code.trim()) continue;
    const literals = literalsOn(code);
    const report = (cls, found) => {
      if (!owned.has(cls)) out.push({ line: i + 1, cls, found: found.slice(0, MAX_REGEX_LITERAL_LEN) });
    };

    const headingLiteral = literals.find(isProgressHeadingLiteral);
    if (headingLiteral !== undefined) report(CLASS.PROGRESS_HEADING, headingLiteral);

    const titleLiteral = literals.find((t) => PROGRESS_TITLE_RE.test(t));
    if (titleLiteral !== undefined) report(CLASS.PROGRESS_TITLE, titleLiteral);

    if (isProgressTableReplace(code)) report(CLASS.PROGRESS_TABLE_REPLACE, code.trim());

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
  { cls: CLASS.PROGRESS_HEADING, text: 'const m = /^##\\s+(Progress)/m.exec(content);' },
  { cls: CLASS.PROGRESS_HEADING, text: 'const pct = done / total, re = /^##\\s+Progress/m;' },
  { cls: CLASS.PROGRESS_HEADING, text: '/* gate */ const re = /^##\\s+Progress/m;' },
  { cls: CLASS.PROGRESS_TITLE, text: 'const isProgress = (t) => /^Progress\\b/i.test(t);' },
  { cls: CLASS.PROGRESS_TITLE, text: "const SRC = 'Progress\\\\b';" },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = roadmapContent.replace(progressRowRe, row);' },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = rm.replace(PROGRESS_TABLE_RE, row);' },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = roadmap.replaceAll(/\\|\\s*3\\.\\s*Three\\s*\\|/g, "| 3. Three |");' },
  { cls: CLASS.PROGRESS_TABLE_REPLACE, text: 'const out = text.replace(/\\|\\s*Plans Complete\\s*\\|/, "| Plans |");' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = /^- \\[ \\] \\*\\*Phase (\\d+)/m;' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = /^\\s*-\\s*\\[ ?[xX]? ?\\]\\s*\\*\\*Phase/;' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = /^- \\[.\\] \\*\\*Phase/;' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = /^-\\s\\[\\s\\]\\sPhase/;' },
  { cls: CLASS.PHASE_ENTRY_CHECKBOX, text: 'const re = new RegExp(`-\\\\s*\\\\[[ xX]\\\\]\\\\s*\\\\*\\\\*Phase ${n}`);' },
];

const MUST_STAY_CLEAN = [
  // A heading being WRITTEN: no regex syntax.
  { name: 'heading builder', text: "const heading = '## Progress\\n\\n';" },
  { name: 'bold heading builder', text: "const heading = '## **Progress**\\n';" },
  // STATE.md field, status vocabulary.
  { name: 'STATE progress field', text: 'const m = /^Progress: (.*)$/m.exec(body);' },
  { name: 'status vocabulary', text: 'const m = content.match(/##\\s*Status:\\s*(OPEN|IN PROGRESS)/i);' },
  { name: 'status alternation', text: 'const m = /^(done|progress\\b)/i.exec(word);' },
  // Other checkboxes and a different seam: the heading bracket tag, a markdown link.
  { name: 'requirement checkbox', text: 'const re = /^- \\[[ xX]\\] \\*\\*REQ-\\d+\\*\\*/m;' },
  { name: 'hyphenated Phase', text: 'const re = /^- \\[[ x]\\] .*Phase-gate/;' },
  { name: 'emitted entry', text: 'const line = `- [ ] **Phase ${n}: ${name}**`;' },
  { name: 'heading bracket tag', text: 'const re = /^#{2,4}\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+(\\d+)/;' },
  { name: 'markdown link', text: 'const re = /\\[Phase (\\d+)\\]\\(#phase-\\1\\)/;' },
  { name: 'comment', text: '// the old /^##[ \\t]+Progress\\b/im and /^- \\[ \\] \\*\\*Phase/ shapes' },
  // A replace whose first argument is not a Progress table pattern.
  { name: 'unrelated replace', text: 'const out = roadmapContent.replace(/\\r\\n/g, "\\n");' },
  { name: 'pipe escape for output', text: "const cell = roadmap.title.replace(/\\|/g, '\\\\|');" },
  { name: 'progress variable receiver', text: "const pct = roadmapProgress.replace(/%$/, '');" },
  { name: 'replace inside a template', text: 'const label = `roadmap progress ${name.replace(/-/g, " ")}`;' },
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

/**
 * The failure report as lines: a header, the pointer to the two owners, then one
 * `file:line  [class]  fragment` line per violation. `found` is the matched
 * literal (or, for the replace class, the offending line), cut to
 * MAX_REGEX_LITERAL_LEN. The path is as attacker-controlled as the matched text,
 * so both pass through `sanitizeForReport`.
 */
function formatViolations(violations) {
  return [
    'roadmap-progress-drift: hand-written Progress-table or phase-entry pattern(s) found.',
    'Locate and edit the Progress table through src/roadmap-progress.cts (`locateRoadmapProgress`, `findProgressSection`,',
    '`editRoadmapProgress`) and compose phase-entry patterns from src/phase-entry-grammar.cts (`phaseEntryRegExp`,',
    '`phaseEntrySplitRegExp`) instead of spelling them again:',
    ...violations.map((d) => `  ${sanitizeForReport(d.file)}:${d.line}  [${d.cls}]  ${sanitizeForReport(d.found)}`),
  ];
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
  for (const line of formatViolations(violations)) process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findProgressDrift,
  scanRepo,
  runPositiveControl,
  formatViolations,
  CLASS,
  PROGRESS_OWNER,
  GRAMMAR_OWNER,
  OWNED_CLASSES,
  SCAN_DIRS,
  MUST_FLAG,
  MUST_STAY_CLEAN,
  stripComments,
  literalsOn,
};

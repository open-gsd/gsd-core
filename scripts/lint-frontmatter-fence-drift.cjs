#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the FRONTMATTER FENCE seam (found while
 * implementing #5105; ADR-5057 one-owner rule).
 *
 * `src/frontmatter-fence.cts`'s `locateFrontmatterFence` is the SINGLE owner of
 * "where does a document's frontmatter block start and stop" — the BOM, the
 * byte-0 opening fence, the whole-line closing fence, an adjacent empty block,
 * the lenient `----` closer. Before it existed that answer was re-derived in
 * some thirty places across `src/` (regexes like `/^---\r?\n([\s\S]*?)\r?\n---/`,
 * `indexOf('\n---', 4)`, `lines[0].trim() === '---'`), and the copies disagreed
 * on a BOM, CRLF, an adjacent empty block, `----`, `--- x`, a `---` inside a
 * value and leading whitespace. This guard keeps a new copy from appearing.
 *
 * Mechanism: the shared `scripts/lib/drift-scan.cjs` tree walk and regex-literal
 * tokenizer (ADR-3180 Decision 4), scanning the WHOLE `src/` and `hooks/` trees
 * (the hooks load the built `bin/lib` behind `ensureRuntimeBuild`), the dev-time
 * `scripts/` and `eslint-rules/` trees (every one of them that runs after
 * `build:lib` requires the owner from `gsd-core/bin/lib/frontmatter-fence.cjs`),
 * the two hand-written entry points that load `bin/lib` (`bin/install.js`,
 * `gsd-core/bin/gsd-tools.cjs`), and the two native plugin adapters
 * (`.opencode/plugins/gsd-core.js`, `.kilo/plugins/gsd-core.js`), with
 * FUNCTION-SCOPED exemptions carrying a written reason — never a bare file
 * allowlist — exactly as `lint-milestone-window-drift.cjs` does.
 *
 * KEPT COPIES (found while implementing #5105). A file that must run where the
 * built owner may not exist keeps a self-contained copy of `locateFrontmatterFence`,
 * and only that one function is allowlisted: `scripts/changeset/parse.cjs` (the
 * `changeset-lint` CI job runs it with no `npm ci` and no build) and the two plugin
 * adapters (a package/git-spec tree may carry no built `bin/lib`). Each copy is
 * pinned to the owner by tests/frontmatter-fence.test.cjs ("kept frontmatter fence
 * copies agree with the owner") over a fixture corpus and a property test.
 *
 * DETECTORS. Three files carry a regex that recognizes a fence idiom in OTHER
 * text — this guard itself, `lint-frontmatter-scalar-broad-grep.cjs` (workflow
 * shell snippets) and the `no-crlf-fragile-split` ESLint rule (regex literals in
 * source). None of them locates a frontmatter block; each is exempt only for its
 * exact fragment (`DETECTOR_EXEMPTIONS`), so any other fence code in the same
 * file is still flagged.
 *
 * A line (comment text stripped) is a fence re-derivation when it carries:
 *   (a) a regex literal whose text contains `---` (`/^---/`, `/\n---/`,
 *       `/(\r?\n)---$/`), or
 *   (b) `new RegExp(` together with a string/template literal containing `---`, or
 *   (c) a fence-shaped string literal — `'---'`, `'\n---'`, `'---\n'`,
 *       `'---\r\n'`, `'\r\n---'` — that is the direct argument of
 *       `.startsWith(`/`.endsWith(`/`.indexOf(`/`.lastIndexOf(`/`.split(`, or an
 *       operand of `===`/`!==`/`==`/`!=`, or (only when it carries a line
 *       ending) the argument of `.includes(`.
 * A template literal that BUILDS a block (`` `---\n${yaml}\n---` ``) or an array
 * of fence lines to join is a writer emitting a fence, not a reader locating
 * one, and is not flagged.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (the sibling guards'
 * tradeoff): a derivation split across lines, or routed through a variable
 * holding the `---` literal, is left to code review and to the consumer-parity
 * tests in `tests/frontmatter-fence.test.cjs`.
 */

const fs = require('node:fs');
const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// Authored TypeScript source (the generated bin/lib/*.cjs mirror it) and the runtime hooks
// (`hooks/dist`, their build output, is skipped by the shared walker), plus the two hand-written
// entry points that load bin/lib and so can — and must — read the owner too.
const SCAN_TREES = [
  { dirs: ['src'], ext: new Set(['.cts', '.ts', '.mts']) },
  { dirs: ['hooks'], ext: new Set(['.js', '.cjs']) },
  { dirs: ['scripts', 'eslint-rules'], ext: new Set(['.js', '.cjs', '.mjs']) },
];
const SCAN_FILES = [
  path.join('bin', 'install.js'),
  path.join('gsd-core', 'bin', 'gsd-tools.cjs'),
  path.join('.opencode', 'plugins', 'gsd-core.js'),
  path.join('.kilo', 'plugins', 'gsd-core.js'),
];

const OWNER_FILE = path.join('src', 'frontmatter-fence.cts');

// Code outside any top-level function (a module-scope constant) is keyed as this.
const TOP_LEVEL = '<top-level>';

// FUNCTION-SCOPED exemptions, each with its reason:
//   - frontmatter-fence.cts `locateFrontmatterFence` and its module-scope fence
//     constants: this IS the owner.
//   - phase.cts `phaseEntryInsertOffset`: its `lastIndexOf('\n---')` finds the
//     ROADMAP's trailing section SEPARATOR (a thematic break closing the phase
//     list) so a new phase entry is appended before it — it never asks where a
//     frontmatter block is.
//   - shell-command-projection.cts `_normalizeMd`: `prevTrimmed !== '---'` is
//     the Markdown normalizer's "no blank line after a thematic break" rule,
//     applied line by line to BODY text; that normalizer's frontmatter skip
//     (`leadingFrontmatterLineCount`) reads the owner.
//   - scripts/changeset/parse.cjs `locateFrontmatterFence`: a kept copy of the
//     owner (#5105) — the `changeset-lint` job in changeset-required.yml runs it
//     with no `npm ci` and no `build:lib`. Pinned to the owner by the parity test
//     tests/frontmatter-fence.test.cjs "kept frontmatter fence copies agree with the owner".
//   - .opencode/plugins/gsd-core.js and .kilo/plugins/gsd-core.js
//     `locateFrontmatterFence`: kept copies of the owner (#5105) — the plugin loads
//     from a package/git-spec tree that may carry no built bin/lib. Pinned to the
//     owner by the same parity test.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [OWNER_FILE, new Set(['locateFrontmatterFence', TOP_LEVEL])],
  [path.join('src', 'phase.cts'), new Set(['phaseEntryInsertOffset'])],
  [path.join('src', 'shell-command-projection.cts'), new Set(['_normalizeMd'])],
  [path.join('scripts', 'changeset', 'parse.cjs'), new Set(['locateFrontmatterFence'])],
  [path.join('.opencode', 'plugins', 'gsd-core.js'), new Set(['locateFrontmatterFence'])],
  [path.join('.kilo', 'plugins', 'gsd-core.js'), new Set(['locateFrontmatterFence'])],
]);

// FRAGMENT-SCOPED exemptions for DETECTORS (#5105), each pinned to the exact
// reported fragment (the literal's source text) — a regex that recognizes a fence
// idiom in other text, never one that locates a frontmatter block:
//   - this guard's own fence-literal matcher (`FENCE_LITERAL_CONTENT_RE`);
//   - lint-frontmatter-scalar-broad-grep.cjs `FRONTMATTER_SCOPE_RE`, which finds a
//     `^---`-scoped extraction in a workflow's shell snippet;
//   - the no-crlf-fragile-split ESLint rule's `^---` probe, which classifies a
//     regex literal in linted source as frontmatter-shaped.
const DETECTOR_EXEMPTIONS = new Map([
  [path.join('scripts', 'lint-frontmatter-fence-drift.cjs'), new Set(['/^(?:\\\\r)?(?:\\\\n)?---(?:\\\\r)?(?:\\\\n)?$/'])],
  [path.join('scripts', 'lint-frontmatter-scalar-broad-grep.cjs'), new Set(['/\\^---[\\s\\S]{0,300}?---/'])],
  [path.join('eslint-rules', 'no-crlf-fragile-split.cjs'), new Set(['/\\^---/'])],
]);

// Only a column-0 top-level `function` declaration updates the current-function
// tracker (mirrors lint-milestone-window-drift.cjs); a module-scope `const` line
// after a function body resets it to TOP_LEVEL.
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
const TOP_LEVEL_STATEMENT_RE = /^(?:export\s+)?(?:const|let|var|class|interface|type|import)\b/;

const NEW_REGEXP_RE = /new\s+RegExp\s*\(/;

// A fence-shaped string literal's CONTENT (source text between the quotes):
// `---`, optionally preceded by `\n`/`\r\n` and optionally followed by `\n`/`\r\n`.
const FENCE_LITERAL_CONTENT_RE = /^(?:\\r)?(?:\\n)?---(?:\\r)?(?:\\n)?$/;

const SEARCH_CALL_BEFORE_RE = /\.(startsWith|endsWith|indexOf|lastIndexOf|split|includes)\(\s*$/;
const COMPARE_BEFORE_RE = /[!=]==?\s*$/;
const COMPARE_AFTER_RE = /^\s*[!=]==?/;

/**
 * Read the quoted or backtick-delimited string literal starting at `line[start]`.
 * Returns `{ text, end }` (delimiters included) or null. Same single-pass,
 * escape-aware, bounded style as the shared `readRegexLiteralAt`.
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
 * Strip comment text from a line (whole-line `*`, `/*`, `//`, and a trailing
 * `//`), as the sibling guards do — prose about a fence is not a fence.
 */
function stripComments(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/** Every regex and string literal on `code`, in order, with its kind and span. */
function literalsOf(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    let literal = null;
    let kind = null;
    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*') {
      literal = readRegexLiteralAt(code, i);
      kind = 'regex';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      literal = readStringLiteralAt(code, i);
      kind = 'string';
    }
    if (!literal) continue;
    out.push({ kind, text: literal.text, start: i, end: literal.end });
    i = literal.end - 1;
  }
  return out;
}

/** The fence re-derivation fragment on a comment-stripped line, or null. */
function fenceFragment(code) {
  const literals = literalsOf(code);
  const hasNewRegExp = NEW_REGEXP_RE.test(code);
  for (const lit of literals) {
    if (lit.kind === 'regex') {
      if (lit.text.includes('---')) return lit.text;
      continue;
    }
    const content = lit.text.slice(1, -1);
    if (hasNewRegExp && content.includes('---')) return lit.text;
    if (!FENCE_LITERAL_CONTENT_RE.test(content)) continue;
    const before = code.slice(0, lit.start);
    const after = code.slice(lit.end);
    const call = SEARCH_CALL_BEFORE_RE.exec(before);
    if (call && (call[1] !== 'includes' || content.includes('\\n'))) return lit.text;
    if (COMPARE_BEFORE_RE.test(before) || COMPARE_AFTER_RE.test(after)) return lit.text;
  }
  return null;
}

/**
 * Pure: every unsanctioned frontmatter-fence re-derivation in `text`.
 * `relPath` is the repo-relative path, for reporting and the exemptions.
 * Returns [{ line, fn, found }].
 */
function findFrontmatterFenceDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  const exemptFragments = DETECTOR_EXEMPTIONS.get(relPath) || null;
  let currentFunction = TOP_LEVEL;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = TOP_LEVEL_FUNCTION_RE.exec(line);
    if (fnMatch) currentFunction = fnMatch[1];
    else if (TOP_LEVEL_STATEMENT_RE.test(line)) currentFunction = TOP_LEVEL;

    const code = stripComments(line);
    if (!code.includes('---')) continue;
    const found = fenceFragment(code);
    if (found === null) continue;
    if (exemptFunctions && exemptFunctions.has(currentFunction)) continue;
    if (exemptFragments && exemptFragments.has(found)) continue;
    out.push({ line: i + 1, fn: currentFunction, found });
  }
  return out;
}

/** Scan the authored source tree and entry points; every violation carries its repo-relative file. */
function scanRepo(root) {
  const violations = [];
  for (const { dirs, ext } of SCAN_TREES) {
    violations.push(...scanTree({
      root,
      scanDirs: dirs,
      scanExt: ext,
      onFile(rel, text) {
        return findFrontmatterFenceDrift(text, rel).map((d) => ({ file: rel, ...d }));
      },
    }));
  }
  for (const rel of SCAN_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue; // absent in a fixture tree
    }
    violations.push(...findFrontmatterFenceDrift(text, rel).map((d) => ({ file: rel, ...d })));
  }
  return violations;
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok frontmatter-fence-drift: no frontmatter fence re-derivations outside frontmatter-fence.cts\n');
    return;
  }
  process.stderr.write('frontmatter-fence-drift: independent re-derivation(s) of the frontmatter fence found.\n');
  process.stderr.write('Use `locateFrontmatterFence` (src/frontmatter-fence.cts) for offsets, or `frontmatterBlock` /\n');
  process.stderr.write('`frontmatterRegion` / `extractFrontmatter` / `stripFrontmatter` (src/frontmatter.cts) for content:\n');
  for (const d of violations) {
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line} (${sanitizeForReport(d.fn)})  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findFrontmatterFenceDrift,
  scanRepo,
  fenceFragment,
  stripComments,
  readStringLiteralAt,
  OWNER_FILE,
  TOP_LEVEL,
  FUNCTION_SCOPED_EXEMPTIONS,
  DETECTOR_EXEMPTIONS,
};

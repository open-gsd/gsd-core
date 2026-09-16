#!/usr/bin/env node
/**
 * lint-retired-runtime-name.cjs
 *
 * Prevents a RETIRED GSD runtime name from being presented as if it were a
 * live runtime (#1928 retired the "Gemini CLI" runtime lane in favor of
 * Antigravity). Mirrors scripts/lint-legacy-dir-name.cjs's structure and
 * conventions (same problem shape: forbid a retired token, allowlist
 * frozen/legitimate content, self-exempt, inline marker, `GSD_LINT_*_REPO_ROOT`
 * test seam, ./lib/cli-exit.cjs, binary-file skip).
 *
 * THE PREDICATE (load-bearing — do not "simplify"):
 * The forbidden token is matched CASE-SENSITIVELY, standalone (word
 * boundaries), capitalised: /\bGemini\b/ — NO `i` flag.
 *
 * Case sensitivity IS the mechanism. Every LEGITIMATE reference to the
 * "gemini" string in this repo is spelled differently and therefore cannot
 * match a case-sensitive `Gemini`:
 *   - Antigravity's config homes are lowercase with a slash:
 *     ~/.gemini/antigravity, ~/.gemini/antigravity-ide, ~/.gemini/config
 *   - Google's model ids are lowercase and hyphenated:
 *     gemini-3.1-pro-preview, gemini-2.5-flash-lite
 *   - env vars are uppercase: GEMINI_CONFIG_DIR, GEMINI_SESSION_ID, GEMINI_API_KEY
 *   - the instruction file is GEMINI.md
 * A bare capitalised `Gemini` therefore means the retired RUNTIME (or its
 * retired reviewer lane) is being named as if live — which is the defect
 * this guard exists to catch.
 *
 * RETIRED_RUNTIMES is a table, not a hardcoded single name, so the guard
 * generalises to the next retired runtime for free. The name is built via
 * split-string concatenation (same trick the legacy-dir-name precedent
 * uses) so this guard script cannot flag itself.
 *
 * THREE TIERS OF EXEMPTION, deliberately ordered narrowest-first. The
 * allowlist is the entire risk surface of this guard, so each tier states
 * what it can and cannot see:
 *
 *   1. GENERAL RULES (apply anywhere, no per-file registration) — the two
 *      spellings that are legitimate wherever they appear:
 *      (a) the hook DIALECT Antigravity genuinely inherits: `Gemini-style`,
 *          `Gemini-compatible`, `Gemini スタイル`;
 *      (b) a model-display version on the provider/model axis
 *          (`Gemini 2.5 Pro`), REFUSED when a runtime word also appears on
 *          the line so a version can never launder a runtime claim.
 *   2. PINNED OCCURRENCES (`ALLOWLIST_OCCURRENCES`) — per-file, per-line
 *      approved snippets. This is what makes a NEW occurrence in an
 *      otherwise-legitimate file FAIL: the file is not blanket-trusted, only
 *      the enumerated lines are. A pin that stops matching is reported as a
 *      stale allowlist entry, so the allowlist cannot silently rot.
 *   3. FILE / DIR ALLOWLIST — blanket trust, and therefore reserved for
 *      content that is append-only by policy (ADRs, dated research) or
 *      generated-and-locked (CHANGELOG.md). A new occurrence inside these
 *      IS invisible to this guard; that is the accepted cost of not
 *      re-litigating frozen history on every run, and it is why the tier is
 *      kept as small as it is.
 *
 * Plus an anti-vacuity floor on files actually READ (not merely listed), so
 * an empty or failed walk can never report a false clean.
 *
 * Exit 0 if no violations; exit 1 if any are found (with stderr diagnostics).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

// Table of retired runtimes. Each name is constructed via split-string
// concatenation so this guard script cannot flag itself when scanned.
const RETIRED_RUNTIMES = [
  {
    name: 'Gem' + 'ini',
    retiredBy: '#1928',
    sunset: '2026-06-18',
    successor: 'Antigravity',
  },
];

const RETIRED_RUNTIME_MATCHERS = RETIRED_RUNTIMES.map((r) => ({
  runtime: r,
  // Case-sensitive, no 'i' flag — see module header for why.
  re: new RegExp('\\b' + r.name + '\\b', 'g'),
}));

// Minimum plausible number of files actually READ. An empty or failed walk
// must never silently report "clean" (anti-vacuity requirement).
const MIN_EXPECTED_FILES = 150;

const ALLOW_MARKER = 'gsd-allow-retired-runtime-name';
// The escape hatch must carry a justification. Bare-marker abuse was raised in
// review: the marker is checked first, excuses the whole line, and the failure
// message advertises it, so an unexplained one is indistinguishable from a
// defect somebody silenced. Require `gsd-allow-retired-runtime-name: <reason>`.
const ALLOW_MARKER_RE = new RegExp(escapeRegex(ALLOW_MARKER) + ':\\s*\\S{3,}');
const SELF_PATH = path.resolve(__filename);
// GSD_LINT_RETIRED_RUNTIME_REPO_ROOT is used by tests to redirect the guard
// to a temporary fixture git repo without touching the real working tree.
const REPO_ROOT = process.env.GSD_LINT_RETIRED_RUNTIME_REPO_ROOT
  ? path.resolve(process.env.GSD_LINT_RETIRED_RUNTIME_REPO_ROOT)
  : path.resolve(__dirname, '..');

// Every tracked *.md file is in scope. An earlier prefix list
// (docs/ gsd-core/ commands/ agents/ skills/ + root) left `.changeset/`,
// `.github/`, `capabilities/`, `playbooks/` and `references/` invisible —
// and `.changeset/*.md` RENDERS INTO CHANGELOG.md, which is blanket-trusted,
// so a live claim introduced there was invisible at both ends.

// TIER 3 — blanket trust. Append-only by policy, or generated-and-locked.
// A new occurrence inside these is invisible to this guard; see the module
// header for why that cost is accepted here and nowhere else.
const ALLOWLIST_FILES = new Set([
  // Locked by CLAUDE.md ("CHANGELOG.md is Locked") and generated from
  // changeset fragments: frozen release history, one entry per shipped
  // release, including the releases that removed the runtime.
  'CHANGELOG.md',
]);

const ALLOWLIST_DIR_PREFIXES = [
  // `.changeset/` is CHANGELOG.md before rendering — the same surface, one
  // step upstream — so it gets the same treatment. Measured: all 21 hits are
  // fragments DESCRIBING the retirement or a fix to it (e.g. "Retired the
  // Gemini CLI reviewer lane", "Gemini install output is valid on Windows
  // PowerShell"), which is what a release note is for. 464 of the 479 live
  // under `archived/`. Pinning them would add friction with no signal: a
  // fragment can only describe what already shipped, and it is deleted at
  // release. The cost is stated rather than hidden — a fragment introducing a
  // live claim is invisible here, as it is in CHANGELOG.md itself.
  '.changeset/',
  // Architecture decision records are append-only history.
  'docs/adr/',
  // Frozen historical release notes.
  'docs/RELEASE-NOTES-LEGACY.md',
  // Dated research records, incl. the gemini-to-antigravity migration note.
  'docs/research/',
  // Dated records.
  'docs/issueevidence/',
  'docs/discussions/',
  'docs/superpowers/',
];

// TIER 2 — pinned occurrences. relPath -> [{ snippet, reason }]. A match is
// excused only when its LINE contains one of that file's snippets, so a new,
// unrelated occurrence in the same file still fails. Every snippet is a
// verbatim fragment of the line it approves.
const ALLOWLIST_OCCURRENCES = new Map([
  ['CONTEXT.md', [
    // The name precedes the annotation on this line, so the snippet must span
    // both for span containment to cover the match.
    { snippet: 'Gemini [runtime removed #1928]', reason: 'session log annotates the removal inline' },
  ]],
  ['GEMINI.md', [
    { snippet: 'Gemini CLI was sunset by Google on 2026-06-18', reason: 'states the sunset' },
    { snippet: 'shared Gemini 3 backend', reason: 'names the shared model backend Antigravity uses' },
  ]],
  ['docs/whats-new-1.7.0.md', [
    // Two occurrences on one line, so two pins: span containment deliberately
    // refuses to let the first excuse the second.
    { snippet: 'Gemini CLI removed** (#1928)', reason: 'release note announcing the removal' },
    { snippet: 'Google discontinued Gemini CLI on 2026-06-18', reason: 'states the sunset date' },
  ]],
  ['docs/explanation/embeddable-orchestration-system.md', [
    { snippet: 'Gemini CLI was retired in', reason: 'records the retirement' },
  ]],
  // The fragment is the SOURCE; docs/FEATURES.md is generated from it by
  // scripts/gen-features.cjs, so both carry the same approved line and the
  // same pin covers each. A marker written into FEATURES.md by hand would be
  // dropped on the next regeneration.
  ['docs/features/embeddable-orchestration-system-host-integration-interface.md', [
    { snippet: 'retired Gemini CLI now redirects to Antigravity CLI', reason: 'records the redirect' },
  ]],
  ['docs/FEATURES.md', [
    { snippet: 'retired Gemini CLI now redirects to Antigravity CLI', reason: 'generated from the fragment above' },
  ]],
  ['docs/reference/host-integration-capability-matrix.md', [
    { snippet: '(Gemini CLI\'s `thinkingConfig`) was removed as a sunset runtime', reason: 'explains why no config-file member exists' },
    { snippet: 'successor to the sunset Gemini CLI per #1928', reason: 'records the sunset and the inherited contract' },
  ]],
  // --- The inherited hook dialect, where the line ALSO names a runtime -----
  // Tier 1(a) requires no runtime word on the line, because the tight
  // "immediately after the name" veto let real laundering through. These ten
  // lines legitimately pair a dialect compound with a runtime word (usually
  // `~/.gemini/antigravity-cli` in a table cell, or "runtime files" in the
  // same sentence), so each is pinned explicitly instead of loosening the
  // veto for everyone.
  ['docs/ARCHITECTURE.md', [
    { snippet: 'Gemini-style `settings.json` hook entries', reason: 'hook dialect Antigravity inherits' },
  ]],
  ['docs/ja-JP/ARCHITECTURE.md', [
    { snippet: 'Gemini スタイル `settings.json` フックエントリ', reason: 'hook dialect Antigravity inherits' },
  ]],
  ['docs/ko-KR/ARCHITECTURE.md', [
    { snippet: 'Gemini 스타일 `settings.json` 훅 항목', reason: 'hook dialect Antigravity inherits' },
  ]],
  ['docs/pt-BR/ARCHITECTURE.md', [
    { snippet: 'no estilo Gemini quando instalado', reason: 'hook dialect Antigravity inherits' },
  ]],
  ['docs/zh-CN/ARCHITECTURE.md', [
    { snippet: 'Gemini 风格 `settings.json` hook 条目', reason: 'hook dialect Antigravity inherits' },
  ]],
  ['docs/how-to/install-on-your-runtime.md', [
    { snippet: 'Uses Gemini-compatible settings policy', reason: 'settings dialect Antigravity inherits' },
  ]],
  ['docs/ja-JP/how-to/install-on-your-runtime.md', [
    { snippet: 'Gemini 互換', reason: 'settings dialect Antigravity inherits' },
  ]],
  ['docs/ko-KR/how-to/install-on-your-runtime.md', [
    { snippet: 'Gemini 호환 설정 정책을 사용합니다', reason: 'settings dialect Antigravity inherits' },
  ]],
  ['docs/pt-BR/how-to/install-on-your-runtime.md', [
    { snippet: 'compatível com Gemini', reason: 'settings dialect Antigravity inherits' },
  ]],
  ['docs/zh-CN/how-to/install-on-your-runtime.md', [
    { snippet: '与 Gemini 兼容的设置策略', reason: 'settings dialect Antigravity inherits' },
  ]],
  ['gsd-core/workflows/reapply-patches.md', [
    { snippet: 'pre-#1928 Gemini CLI install', reason: 'legacy-install patch location, explicitly pre-retirement' },
  ]],
  ['gsd-core/workflows/settings-advanced.md', [
    { snippet: '(Claude / OpenAI / Gemini / Qwen)', reason: 'model-provider menu, not a GSD runtime' },
  ]],
  ['gsd-core/references/ai-frameworks.md', [
    { snippet: 'Google Cloud / Gemini-committed teams', reason: 'provider axis (Google ADK)' },
    { snippet: 'Optimized for Gemini; supports other models', reason: 'model axis' },
    { snippet: 'teams already committed to Gemini', reason: 'model axis' },
    { snippet: 'Model flexibility is required beyond Gemini', reason: 'model axis' },
    { snippet: 'Gemini vendor lock-in in practice', reason: 'model axis' },
    { snippet: 'Google/Gemini-committed', reason: 'provider axis (Google ADK)' },
  ]],
  ['agents/gsd-framework-selector.md', [
    // Two occurrences on one line: the menu label and its description.
    { snippet: 'Google (Gemini)', reason: 'model-provider choice, not a GSD runtime' },
    { snippet: 'Committed to Gemini / Google Cloud / Vertex AI', reason: 'the same menu entry\'s description' },
  ]],
  ['agents/gsd-framework-selector.compact.md', [
    { snippet: 'Google (Gemini)', reason: 'model-provider choice, not a GSD runtime' },
  ]],
]);

// Every pin must contain a retired runtime name. Span containment means a
// snippet that does not contain the name can never cover a match, so such a
// pin is dead config that would also be reported stale forever — fail loud at
// load rather than mislead later.
for (const [relPath, pins] of ALLOWLIST_OCCURRENCES) {
  for (const pin of pins) {
    const names = RETIRED_RUNTIMES.filter((r) => pin.snippet.includes(r.name));
    if (names.length === 0) {
      throw new Error(
        'lint-retired-runtime-name: pin for ' + relPath + ' does not contain a retired '
          + 'runtime name and can never match: ' + JSON.stringify(pin.snippet),
      );
    }
  }
}

// docs/RELEASE-NOTES-LEGACY.md is a file, not a directory, but the brief
// lists it alongside the dir prefixes — treat both files and dirs the same
// way via a "startsWith" prefix check.
function isAllowlisted(relPath) {
  if (ALLOWLIST_FILES.has(relPath)) return true;
  for (const prefix of ALLOWLIST_DIR_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix)) return true;
  }
  return false;
}

function isInScanSet(relPath) {
  return relPath.endsWith('.md');
}

function isBinary(fullPath) {
  // Read a small chunk and check for NUL bytes.
  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.allocUnsafe(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

// --- TIER 1(a): the hook dialect Antigravity genuinely inherits -------------
// Antigravity reads Gemini-shaped `settings.json` hook entries, and every
// locale names that dialect. Marker POSITION is language-dependent and was
// measured: en `Gemini-style` / `Gemini-compatible`, ja `Gemini スタイル`,
// ko `Gemini 스타일` / `호환`, zh `Gemini 风格` / `与 Gemini 兼容的`, and pt
// `no estilo Gemini` / `compatível com Gemini`, where it PRECEDES the name.
//
// The marker must form an ADJACENT COMPOUND with the name. An earlier version
// searched a ±24-character window, which let one legitimate dialect reference
// launder a second, unrelated live claim on the same line — a reviewer
// demonstrated `| Antigravity | Gemini-style hooks | Gemini support is live |`
// exiting 0, because the second occurrence sat 21 characters from `style`.
// Adjacency is the property that actually distinguishes a dialect NAME from a
// runtime CLAIM, so it is what is tested.
const DIALECT_MARKERS = [
  'style', 'compatible', // en
  'スタイル', '互換', // ja
  '스타일', '호환', // ko
  '风格', '兼容', // zh
  'estilo', 'compatível', 'compatibilidade', // pt
];
const DIALECT_ALT = DIALECT_MARKERS.map(escapeRegex).join('|');
// Marker immediately follows: "Gemini-style", "Gemini スタイル", "Gemini 兼容".
const DIALECT_AFTER_RE = new RegExp('^[-\\s]?(?:' + DIALECT_ALT + ')', 'i');
// Marker immediately precedes, optionally through ONE short connective:
// "no estilo Gemini", "compatível com Gemini".
const DIALECT_BEFORE_RE = new RegExp(
  '(?:' + DIALECT_ALT + ')\\s*(?:com|with|de|da|do|and)?\\s*$',
  'i',
);

function isDialectReference(line, matchIndex, afterMatch) {
  const adjacent = DIALECT_AFTER_RE.test(afterMatch)
    || DIALECT_BEFORE_RE.test(line.slice(0, matchIndex));
  if (!adjacent) return false;
  // A dialect marker is NOT a licence when the line also asserts a runtime.
  // This veto is line-global on purpose: the tight "immediately after the
  // name" form let `Suportamos Gemini, no estilo padrao, como runtime de
  // instalacao.` and `Gemini 兼容，并且是受支持的运行时之一。` both exit 0 while
  // literally containing `runtime` / `运行时`. Real lines that legitimately
  // pair a dialect compound with a runtime word are handled by an explicit
  // Tier-2 pin, not by loosening this.
  return !RUNTIME_WORD_RE.test(line);
}

// --- TIER 1(b): the provider/model axis ------------------------------------
// Matches the display-name spelling of a model version: a version number
// optionally followed by a model qualifier, or one that ends the list item.
// Deliberately NOT "space then a digit" — that blanket rule also matched
// "Gemini 2.5 CLI as a supported runtime.", laundering a genuine stale-runtime
// claim through an attached version number. Full-width digits and CJK
// punctuation are included because the translated docs use them.
const DIGIT = '0-9\\uFF10-\\uFF19';
const SP = ' \\u3000'; // ASCII space + ideographic space
const QUALIFIER = 'Pro|Flash|Ultra|Nano|Lite|Preview|Exp|Thinking';
const PUNCT = ',;.:)\\]\\u3001\\u3002\\uFF0C\\uFF09\\uFF3D\\uFF1A';
const MODEL_DISPLAY_AFTER = new RegExp(
  '^[' + SP + ']'
  + '[' + DIGIT + ']+(?:[.\\uFF0E][' + DIGIT + ']+)*'
  + '(?:'
  + '[' + SP + ']+(?:' + QUALIFIER + ')\\b[\\w-]*'
  + '|[' + SP + ']*[' + PUNCT + ']'
  + '|[' + SP + ']*$'
  + ')',
);

// Words that indicate a RUNTIME (not a model) is being named on the line, in
// every language this repo ships translated docs for. If any appears
// alongside a model-display version, the version does NOT get to launder the
// runtime claim — the line is still a violation.
//
// Latin terms are anchored with \b so "CLI" cannot match inside "client" and
// "host" cannot match inside "ghost"; CJK terms are matched raw because \b is
// ASCII-word-based and would never fire next to a non-word ideograph.
//
// Deliberately EXCLUDED: "agent" and "target". Both occur throughout ordinary
// prose ("AI coding agents (Claude Code, Codex, Gemini 2.5 Pro)"), so vetoing
// on them would red legitimate model lists rather than catch runtime claims.
const RUNTIME_WORDS = [
  'CLI',
  'runtime',
  'runtimes',
  'IDE',
  'extension',
  'host',
  'ランタイム', // ja
  '実行環境', // ja
  '런타임', // ko
  '运行时', // zh
  '运行环境', // zh
  'tempo de execução', // pt
];
const RUNTIME_WORD_RE = new RegExp(
  RUNTIME_WORDS.map((w) => {
    const esc = escapeRegex(w);
    // Anchor only when the term begins/ends with an ASCII word character;
    // \b is meaningless beside an ideograph.
    return /^[A-Za-z0-9]/.test(w) ? '\\b' + esc + '\\b' : esc;
  }).join('|'),
  'i',
);

// Positive evidence that the line is on the MODEL axis. Required, not merely
// the absence of a runtime word: a reviewer demonstrated that "absence of a
// veto word" is not evidence, with `The installer now offers Gemini 3.`,
// `GSD installs cleanly on Gemini 3, Kimi, and Codex.` and
// `Supported agents include Gemini 3, Kimi, and Cursor.` all exiting 0 — the
// exact laundering class this guard exists to catch. Every real model-axis
// line in this repo names a model explicitly, so requiring it costs nothing
// and inverts the failure direction from "silently allow" to "flag".
const MODEL_WORDS = [
  'model', 'models', // en
  'モデル', // ja
  '모델', // ko
  '模型', // zh
  'modelo', 'modelos', // pt
];
const MODEL_WORD_RE = new RegExp(
  MODEL_WORDS.map((w) => {
    const esc = escapeRegex(w);
    return /^[A-Za-z0-9]/.test(w) ? '\\b' + esc + '\\b' : esc;
  }).join('|'),
  'i',
);

/**
 * Is `pin` satisfied AT this match? The match must fall INSIDE an occurrence
 * of the pin's snippet, not merely share a line with it.
 *
 * Line-level containment was too weak: a reviewer showed
 * `Known provider menu update: Gemini CLI is once again a selectable GSD
 * runtime.` and `Install target: Google (Gemini) — choose Gemini CLI as your
 * GSD runtime.` both exiting 0, because a short snippet elsewhere on the line
 * pre-approved a brand-new claim. Span containment means a pin can only ever
 * excuse the occurrence its own text covers.
 */
function pinCoversMatch(line, matchIndex, matchedText, pin) {
  const end = matchIndex + matchedText.length;
  let from = 0;
  for (;;) {
    const at = line.indexOf(pin.snippet, from);
    if (at === -1) return false;
    if (matchIndex >= at && end <= at + pin.snippet.length) return true;
    from = at + 1;
  }
}

/**
 * Decide whether one MATCH (not the whole line) is legitimate.
 *
 * Returns the matched pin, `true` for a general-rule exemption, or `false`
 * for a violation.
 */
function classifyMatch(line, matchIndex, matchedText, pins) {
  // The explicit escape hatch, which must carry a reason.
  if (ALLOW_MARKER_RE.test(line)) return true;

  const afterMatch = line.slice(matchIndex + matchedText.length);

  // TIER 1(a) — inherited hook dialect, as an adjacent compound.
  if (isDialectReference(line, matchIndex, afterMatch)) return true;

  // TIER 1(b) — provider/model axis. Needs positive model evidence AND no
  // runtime word; a version number alone never launders a claim.
  if (MODEL_DISPLAY_AFTER.test(afterMatch)
    && MODEL_WORD_RE.test(line)
    && !RUNTIME_WORD_RE.test(line)) {
    return true;
  }

  // TIER 2 — a pinned occurrence for this specific file, span-scoped.
  for (const pin of pins) {
    if (pinCoversMatch(line, matchIndex, matchedText, pin)) return pin;
  }

  return false;
}

function main() {
  // Enumerate tracked files via git ls-files so only committed/staged source is checked.
  let trackedFiles;
  try {
    trackedFiles = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch (err) {
    throw new ExitError(1, 'ERROR lint-retired-runtime-name: git ls-files failed: ' + err.message);
  }

  const scanFiles = trackedFiles.filter(isInScanSet);

  const violations = [];
  const usedPins = new Set();
  // Files present in the scan set, so a stale-pin check can distinguish
  // "this pin's file is gone/not in this tree" from "this pin matched nothing".
  const scannedRelPaths = new Set();
  // Anti-vacuity counts files actually READ, not merely listed: if every read
  // failed, a candidate count would still look healthy.
  let filesRead = 0;

  for (const relPath of scanFiles) {
    if (isAllowlisted(relPath)) continue;

    const fullPath = path.join(REPO_ROOT, relPath);

    // Skip this guard script itself (path-based, though it is not a .md file
    // and would never be in-scan-set anyway — defense in depth).
    if (path.resolve(fullPath) === SELF_PATH) continue;

    if (isBinary(fullPath)) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      // Unreadable files (permissions, etc.) — skip silently.
      continue;
    }
    filesRead += 1;
    scannedRelPaths.add(relPath);

    const pins = ALLOWLIST_OCCURRENCES.get(relPath) || [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Mark pins used by PRESENCE on the line, independent of which tier
      // ultimately excused the match. Previously this was recorded only on
      // the Tier-2 branch, so a pinned line that a general rule also matched
      // never marked its pin used and the pin was reported stale — a reviewer
      // demonstrated a provably false "no line matches pinned snippet" whose
      // printed remedy told the maintainer to delete a still-needed pin.
      for (const pin of pins) {
        if (line.includes(pin.snippet)) usedPins.add(relPath + ' ' + pin.snippet);
      }

      for (const { runtime, re } of RETIRED_RUNTIME_MATCHERS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const verdict = classifyMatch(line, match.index, match[0], pins);
          if (verdict) continue;
          violations.push({
            file: relPath,
            line: i + 1,
            col: match.index + 1,
            text: line.trim(),
            runtime,
          });
        }
      }
    }
  }

  // Anti-vacuity: the scan must have READ a plausible number of files.
  if (filesRead < MIN_EXPECTED_FILES) {
    throw new ExitError(
      1,
      'ERROR lint-retired-runtime-name: only ' + filesRead + ' file(s) read '
        + '(expected at least ' + MIN_EXPECTED_FILES + '); the walk is empty or broken — refusing '
        + 'to report a false clean.',
    );
  }

  // A pin that no longer matches anything is a stale allowlist entry: the
  // content it approved was edited or removed, and leaving it in place would
  // pre-approve a future occurrence nobody reviewed. Only checked for files
  // actually present in this tree, so fixture roots are unaffected.
  const stalePins = [];
  for (const [relPath, pins] of ALLOWLIST_OCCURRENCES) {
    if (!scannedRelPaths.has(relPath)) continue;
    for (const pin of pins) {
      if (!usedPins.has(relPath + ' ' + pin.snippet)) {
        stalePins.push({ file: relPath, snippet: pin.snippet });
      }
    }
  }

  if (violations.length === 0 && stalePins.length === 0) {
    process.stdout.write(
      'ok lint-retired-runtime-name: ' + filesRead + ' files scanned, 0 violations\n',
    );
    return 0;
  }

  if (violations.length > 0) {
    process.stderr.write('\nERROR lint-retired-runtime-name: ' + violations.length + ' violation(s) found\n\n');
    for (const v of violations) {
      process.stderr.write('  ' + v.file + ':' + v.line + ': ' + v.text + '\n');
    }
    process.stderr.write('\n');
    for (const runtime of RETIRED_RUNTIMES) {
      process.stderr.write(
        'Fix: `' + runtime.name + '` was retired by ' + runtime.retiredBy + ' (sunset ' + runtime.sunset + ') '
          + 'in favor of `' + runtime.successor + '`. Either correct the reference to name the live runtime, '
          + 'or, if the use is a legitimate historical/provider reference, add the `' + ALLOW_MARKER + '` '
          + 'marker on the line.\n',
      );
    }
    process.stderr.write('\n');
  }

  if (stalePins.length > 0) {
    process.stderr.write(
      'ERROR lint-retired-runtime-name: ' + stalePins.length + ' stale allowlist entr'
        + (stalePins.length === 1 ? 'y' : 'ies') + ' in ALLOWLIST_OCCURRENCES\n\n',
    );
    for (const s of stalePins) {
      process.stderr.write('  ' + s.file + ': no line matches pinned snippet ' + JSON.stringify(s.snippet) + '\n');
    }
    process.stderr.write(
      '\nFix: the approved line was edited or removed. Delete the pin, or update its '
        + 'snippet to the new wording — an unmatched pin pre-approves a future occurrence '
        + 'nobody reviewed.\n\n',
    );
  }

  return 1;
}

// Only run the lint when invoked directly. `require()`ing this module (the
// parity test in tests/runtime-name-policy.test.cjs does) must not
// execute a full repository walk as a side effect.
if (require.main === module) {
  runMain(main);
}

module.exports = { RETIRED_RUNTIMES };

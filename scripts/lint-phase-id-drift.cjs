#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the phase-identifier parsing seam
 * (epic #2121, Phase 4 / issue #2128, locked by ADR-2121 Decision 7).
 *
 * `src/phase-id.cts` is the SINGLE canonical owner of phase-ID parsing. Its
 * `PHASE_NUMBER_TOKEN_SOURCE` (and `phaseMarkdownRegexSource` for a known number)
 * is the one place the phase-number-token grammar `\d+[A-Z]?(?:\.\d+)*` is
 * defined. Every other module that scans/enumerates phase headings must build
 * its regex from that source rather than re-deriving the grammar as a literal —
 * otherwise the trio drifts again (the #2111 / #2114 / #2104 recurrence loop this
 * epic closes).
 *
 * This lint makes the invariant machine-enforced: it FAILS the moment a literal
 * re-derivation of the canonical token grammar is introduced anywhere in
 * `src/**` outside `phase-id.cts`, unless the site is deliberately sanctioned
 * with a `// phase-id-owner: <reason>` comment (on the same line or the line
 * directly above). Sites that build their regex from `PHASE_NUMBER_TOKEN_SOURCE`
 * carry no literal grammar and pass automatically.
 *
 * #4634 extends the same pattern with two more detectors:
 *
 * - name-validity-guard drift: `hasNameableContent(s)` in `src/roadmap-parser.cts`
 *   is the sole owner of the "does this string have nameable content" predicate
 *   (`/[\p{L}\p{N}]/u.test(s)`). Any other `src/**` file re-deriving that exact
 *   character class (regex-literal or `new RegExp` template form) instead of
 *   calling `hasNameableContent` is drift, sanctioned the same way as the token
 *   and bracket rules (`// phase-id-owner:` on the nearest preceding non-blank
 *   line), with a line-level escape for a line that already calls
 *   `hasNameableContent(`.
 *
 * - shell phase-number-arithmetic ban: `$((10#...))` base-10-forced arithmetic
 *   inside `gsd-core/workflows/**\/*.md` and `gsd-core/references/**\/*.md` breaks
 *   on decimal or multi-segment phase ids and is banned outright. This scan runs
 *   over markdown, not `.cts` source, so its sanction is an HTML comment on the
 *   nearest preceding non-blank line: `<!-- phase-id-owner: <reason> -->`.
 *
 * - branch-slug fallback drift: a `.replace('{slug}', ... || 'phase')` call
 *   silently substitutes the literal string `'phase'` when a phase's slug
 *   can't be derived, producing a non-identifying branch name like
 *   `gsd/phase-08-phase` (#4126, now fixed via the shared renderPhaseBranchName
 *   owner in phase-id.cts, consumed by both prior call sites). Sanctioned
 *   the same way as the token/bracket/name-validity rules (`// phase-id-owner:`
 *   on the nearest preceding non-blank line), with a line-level escape for a
 *   line that already calls `renderPhaseBranchName(`. Unlike the other
 *   `.cts`-scanning rules, this one has no per-file exemption — it is a banned
 *   anti-pattern everywhere, not a grammar with one legitimate owner site.
 *
 * Detection is intentionally NARROW: only the contiguous canonical token
 * (`\d+[A-Z]?(?:\.\d+)*`, its `[A-Za-z]` and `[.-]` near-variants, in both
 * regex-literal `\d` and `new RegExp` template `\\d` escaping) is drift. Bare
 * `\d+` probes, `[\w][\w.-]*` ids, digits-only captures, status-message text
 * (`Phase\s+\d`), and pipe-table structures are NOT phase-token re-derivations
 * and are not flagged.
 */

const fs = require('node:fs');
const path = require('node:path');

// The canonical phase-number token as it appears in SOURCE TEXT:
//   \d+[A-Z]?(?:\.\d+)*   in a regex literal   -> one backslash before d/.
//   \\d+[A-Z]?(?:\\.\\d+)* in a template string -> two backslashes
// Tolerated near-variants so a trivial rewrite does not silently evade the guard:
//   digit class     \d  \\d  or  [0-9]
//   letter class    [A-Z]  or  [A-Za-z]
//   sub-phase sep    \.  \\.  or  [.-]  (dot-or-dash)
// KNOWN, ACCEPTED limits of a per-line textual scan (covered instead by the
// identity guard + code review, not by this regex): a re-derivation split
// across lines via string concatenation, a capturing `(\.\d+)*` in place of the
// non-capturing group, or a semantically-equivalent restructuring. This guard
// targets the common case — an accidental copy of the exact grammar — not an
// adversary deliberately obfuscating a re-derivation.
const TOKEN_DRIFT_RE = /(?:\\{1,2}d|\[0-9\])\+\[A-Z(?:a-z)?\]\??\(\?:(?:\\{1,2}\.|\[\.-\])(?:\\{1,2}d|\[0-9\])\+\)\*/;

// A `phase-id-owner:` sanction must be a DEDICATED `//` comment line (the marker
// as the line's leading token). A `//` or the phrase embedded in a string
// literal or trailing a code line is NOT a comment and must never suppress a real
// flag — so sanctions live on their own line directly above the regex.
const OWNER_RE = /^\s*\/\/.*phase-id-owner:/;
const CANON_REF = 'PHASE_NUMBER_TOKEN_SOURCE';

// #2761 M3 (trek-e review): the SECOND grammar this seam owns — the BRACKET
// project-code class of `[CODE.MM]`, spelled `[A-Z][A-Z0-9_]*` (with its
// case-widened `[A-Za-z]`/`[A-Za-z0-9_]` variant tolerated so a trivial rewrite
// does not evade the rule). The token guard above only ever knew the phase-
// NUMBER grammar, so three files re-typed this class verbatim — roadmap-parser's
// bracket-fallback selector, state's `isMilestoneBounded`, verify's
// `checkBracketCoherence` — and `check:phase-id-drift` reported clean the whole
// time. That is the blind spot which let #2761's own "no token literal outside
// src/phase-id.cts" gate pass while being violated. Build from
// `BRACKET_PROJECT_CODE_SRC`, `BRACKET_ID_SRC`, `bracketMilestoneIntroSrcFor`
// or `BRACKET_MILESTONE_INTRO_CAPTURING_SRC` instead.
const BRACKET_CODE_DRIFT_RE = /\[A-Z(?:a-z)?\]\[A-Z(?:a-z)?0-9_\]\*/;

// This rule has NO counterpart to the token rule's `line.includes(CANON_REF)`
// escape, and that omission is the point.
//
// That escape is LINE-level: a line naming the canonical source anywhere on it
// is taken as built-from-the-owner. verify.cts's copy read
//
//   new RegExp(`^\\[[A-Z][A-Z0-9_]*\\.(${BRACKET_MILESTONE_NUMERIC_SRC})\\]`, 'i')
//
// — an owner reference for the MILESTONE field sharing a line with a re-typed
// PROJECT-CODE class. A line-level escape waves that through, so a bracket rule
// that copied it would have kept reporting clean on the very site under review.
// Partial ownership IS the drift. Only a `// phase-id-owner:` sanction
// suppresses this rule, and a sanction has to state which half is deliberate.
const BRACKET_OWNER_HINT =
  'BRACKET_PROJECT_CODE_SRC / BRACKET_ID_SRC / bracketMilestoneIntroSrcFor / BRACKET_MILESTONE_INTRO_CAPTURING_SRC';

/**
 * Pure: true if the nearest preceding non-blank line to `lines[i]` is a
 * dedicated sanction comment matching `ownerRe`. Shared by every detector in
 * this file so the "how do you sanction a finding" walk has one owner instead
 * of four independent copies that could silently diverge.
 */
function isSanctionedByPrecedingComment(lines, i, ownerRe) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === '') j--; // nearest preceding non-blank line
  return j >= 0 && ownerRe.test(lines[j]);
}

/**
 * Pure: find every literal re-derivation of the canonical phase-number token in
 * `text` that is NOT sanctioned. A site is sanctioned when the nearest preceding
 * NON-BLANK line is a dedicated `// phase-id-owner:` comment (blank lines between
 * the comment and the regex are tolerated, so an auto-formatter cannot reactivate
 * the flag), or when the regex line references `PHASE_NUMBER_TOKEN_SOURCE` (built
 * from the canonical source, not a literal). A `//`/phrase inside a string or
 * trailing a code line does NOT count — put the sanction on its own line above.
 * Returns [{ line, found }].
 */
function findPhaseIdRegexDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TOKEN_DRIFT_RE.exec(line);
    if (!m) continue;
    if (line.includes(CANON_REF)) continue;
    if (isSanctionedByPrecedingComment(lines, i, OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

/**
 * Pure: find every literal re-derivation of the BRACKET project-code grammar in
 * `text` that is NOT sanctioned. Same sanction mechanism as the token rule — a
 * dedicated `// phase-id-owner:` comment on the nearest preceding non-blank
 * line — but deliberately WITHOUT its line-level owner-reference escape, so a
 * site that references the owner for one field while re-typing the other is
 * still reported (see BRACKET_CODE_DRIFT_RE's note). Returns [{ line, found }].
 */
function findBracketGrammarDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = BRACKET_CODE_DRIFT_RE.exec(lines[i]);
    if (!m) continue;
    if (isSanctionedByPrecedingComment(lines, i, OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// #4634: the name-validity-guard grammar — `hasNameableContent(s)` in
// `src/roadmap-parser.cts` is `/[\p{L}\p{N}]/u.test(s)`. Tolerates both the
// regex-literal single-backslash form and the doubled-backslash template
// form (`new RegExp('[\\p{L}\\p{N}]'`), mirroring how TOKEN_DRIFT_RE tolerates
// both escapings.
const NAME_VALIDITY_DRIFT_RE = /\[\\{1,2}p\{L\}\\{1,2}p\{N\}\]/;
const NAME_VALIDITY_CANON_REF = 'hasNameableContent(';

/**
 * Pure: find every literal re-derivation of the canonical name-validity
 * character class in `text` that is NOT sanctioned. Same sanction mechanism
 * as the token/bracket rules — a dedicated `// phase-id-owner:` comment on
 * the nearest preceding non-blank line — plus a line-level escape for a line
 * that already calls `hasNameableContent(`. Returns [{ line, found }].
 */
function findNameValidityDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = NAME_VALIDITY_DRIFT_RE.exec(line);
    if (!m) continue;
    if (line.includes(NAME_VALIDITY_CANON_REF)) continue;
    if (isSanctionedByPrecedingComment(lines, i, OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// #4634: the branch-slug fallback anti-pattern (#4126) — a
// `.replace('{slug}', ... || 'phase')` call silently falls back to the
// literal string `'phase'` when a phase's slug can't be derived, producing a
// non-identifying branch name like `gsd/phase-08-phase`. Now fixed at both
// prior call sites (commands.cts, init.cts) via the shared
// `renderPhaseBranchName` owner in phase-id.cts; this rule is the ratchet
// against a THIRD site reintroducing the inline fallback. Deliberately
// narrow: it requires the literal `'phase'` fallback on the same line as the
// `{slug}` template token, so it does NOT match the sibling milestone-branch
// fallback (`|| 'milestone'`), which is a different, correct-as-is case.
const BRANCH_SLUG_FALLBACK_DRIFT_RE = /\{slug\}'.*\|\|\s*'phase'/;

// The canonical fix is `renderPhaseBranchName(...)`. There is no "owner file"
// for this rule the way there is for the token/bracket/name-validity
// grammars above — it is a banned anti-pattern everywhere, so no per-file
// exemption exists.
const BRANCH_SLUG_FALLBACK_CANON_REF = 'renderPhaseBranchName(';

/**
 * Pure: find every unsanctioned branch-slug `|| 'phase'` fallback in `text`.
 * Same sanction mechanism as the token/bracket/name-validity rules — a
 * dedicated `// phase-id-owner:` comment on the nearest preceding non-blank
 * line — plus a line-level escape for a line that already calls
 * `renderPhaseBranchName(`. Returns [{ line, found }].
 */
function findBranchSlugFallbackDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = BRANCH_SLUG_FALLBACK_DRIFT_RE.exec(line);
    if (!m) continue;
    if (line.includes(BRANCH_SLUG_FALLBACK_CANON_REF)) continue;
    if (isSanctionedByPrecedingComment(lines, i, OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// #4634: ban base-10-forced shell arithmetic (`$((10#...))`) on a variable
// that still carries a possibly-decimal/multi-segment phase id — this
// construct is exactly the pattern that breaks on a value like `08.5`. The
// capture group grabs the token immediately inside the parens (after an
// optional `$` and/or `{`, stripping a trailing `}`) so callers can inspect
// *which* variable is being coerced, not merely that the substring occurred.
//
// Refined post-#4619: the original blunt "ban `$((10#` outright" version
// over-fired on three false-positive classes once #4619's fix landed:
//   1. Prose mentioning the literal pattern in a full-line `#`-comment
//      (filtered by the caller, not this regex — see below).
//   2. `$((10#$PHASE_INT))` / `$((10#$SPOT_PHASE_INT))` — arithmetic on the
//      NOW-safe variable the #4619 fix produces via `PHASE_INT=${PHASE_NUMBER%%.*}`;
//      a `%%.*`-stripped value can never contain a dot, so base-10 arithmetic
//      on it can never hit the #4619 syntax-error class. Any name ending in
//      `_INT` (case-insensitive) is that established "already reduced to a
//      safe integer" convention.
//   3. `$((10#{plan_padded}))` / `$((10#${PLAN_ID}))` — plan ids are plain
//      integers and were never in scope; this rule only polices variables
//      that carry a *phase* id.
// So a match is only a violation when the captured name contains `phase`
// case-insensitively (it is phase-carrying) AND does not end in `_int`
// case-insensitively (it has not already been reduced to a safe integer).
const SHELL_PHASE_ARITH_DRIFT_RE = /\$\(\(\s*10#\$?\{?([A-Za-z0-9_]+)\}?/;

// A markdown comment can't easily carry a `//` line, so the sanction for the
// shell-arithmetic rule is an HTML comment on the nearest preceding non-blank
// line: `<!-- phase-id-owner: <reason> -->`.
const MD_OWNER_RE = /^\s*<!--.*phase-id-owner:/;

/**
 * Pure: find every unsanctioned `$((10#...))` base-10-forced shell arithmetic
 * site in `text` that still coerces an un-reduced phase-carrying variable.
 * Skips full-line `#` comments outright (pure prose mentioning the pattern,
 * not executable code), and skips any captured variable name that either
 * doesn't contain `phase` (never in scope — e.g. plan ids) or already ends
 * in `_int` (the #4619-fix convention for "safely stripped to an integer").
 * Sanctioned by an HTML comment `<!-- phase-id-owner: ... -->` on the
 * nearest preceding non-blank line. Returns [{ line, found }].
 */
function findShellPhaseArithDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const m = SHELL_PHASE_ARITH_DRIFT_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!/phase/i.test(name)) continue;
    if (/_int$/i.test(name)) continue;
    if (isSanctionedByPrecedingComment(lines, i, MD_OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// #4634: the markdown scan roots — shell embedded in workflow/reference docs.
const MD_SCAN_DIRS = [path.join('gsd-core', 'workflows'), path.join('gsd-core', 'references')];

// #4568 (epic #4634): the single-segment phase regex ban scans a THIRD root,
// `agents/**/*.md`, that the #4619 shell-arithmetic extension above never
// touched — the gsd-code-fixer agent prompts re-derive the phase-number
// grammar too. Reuses the same `walkMd` walker as the shell-arith scan.
const SINGLE_SEGMENT_SCAN_DIRS = [...MD_SCAN_DIRS, 'agents'];

/**
 * Scan `gsd-core/workflows/**\/*.md` and `gsd-core/references/**\/*.md` for
 * unsanctioned `$((10#...))` shell arithmetic. Returns [{ file, line, found }]
 * with repo-relative paths.
 */
function scanMarkdownShellArith(root) {
  const violations = [];
  for (const dir of MD_SCAN_DIRS) {
    for (const file of walkMd(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const d of findShellPhaseArithDrift(text)) {
        violations.push({ file: rel, kind: 'shell-arith', ...d });
      }
    }
  }
  return violations;
}

// #4568 (epic #4634): ban the single-optional-dotted-segment phase regex
// shape `[0-9]+(\.[0-9]+)?` (and its `\d`/doubled-backslash near-variants)
// outright — this is exactly the grammar that hard-rejects or silently
// truncates a 3-or-more-segment phase id like `23.1.2`. The canonical
// grammar (`src/phase-id.cts`) uses the unbounded `(?:\.\d+)*` form; shell
// snippets embedded in markdown can't import that module, so textual parity
// (`*` in place of `?`) is the fix, and this rule is the ratchet against a
// future site re-deriving the bounded form. Deliberately narrow to the
// bounded ONE-optional-segment shape — the fixed `*`-form is not flagged.
const SINGLE_SEGMENT_PHASE_DRIFT_RE =
  /(?:\\{1,2}d|\[0-9\])\+\(\\{1,2}\.(?:\\{1,2}d|\[0-9\])\+\)\?/;

// A single-segment shape like `[0-9]+(\.[0-9]+)?` is not inherently
// phase-specific (e.g. it could describe a version number), so the rule
// only fires on a line whose text plausibly carries a phase-number
// variable — a case-insensitive `phase` substring anywhere on the line,
// mirroring the phase-carrying filter `findShellPhaseArithDrift` already
// applies to its own variable-name capture.
const PHASE_CARRYING_LINE_RE = /phase/i;

/**
 * Pure: find every unsanctioned single-optional-dotted-segment phase regex
 * in `text`, restricted to lines that plausibly carry a phase-number
 * variable. Sanctioned by an HTML comment `<!-- phase-id-owner: ... -->` on
 * the nearest preceding non-blank line (same convention as the shell-arith
 * rule). Returns [{ line, found }].
 */
function findSingleSegmentPhaseRegexDrift(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SINGLE_SEGMENT_PHASE_DRIFT_RE.exec(line);
    if (!m) continue;
    if (!PHASE_CARRYING_LINE_RE.test(line)) continue;
    if (isSanctionedByPrecedingComment(lines, i, MD_OWNER_RE)) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

/**
 * Scan `gsd-core/workflows/**\/*.md`, `gsd-core/references/**\/*.md`, and
 * `agents/**\/*.md` for unsanctioned single-optional-dotted-segment phase
 * regexes. Returns [{ file, line, found }] with repo-relative paths.
 */
function scanMarkdownSingleSegmentPhaseRegex(root) {
  const violations = [];
  for (const dir of SINGLE_SEGMENT_SCAN_DIRS) {
    for (const file of walkMd(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const d of findSingleSegmentPhaseRegexDrift(text)) {
        violations.push({ file: rel, kind: 'single-segment-phase-regex', ...d });
      }
    }
  }
  return violations;
}

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);
// The canonical owner defines the grammar; it is exempt by construction.
const EXEMPT = new Set([path.join('src', 'phase-id.cts')]);

// #4634: the name-validity-guard rule owns a DIFFERENT file (roadmap-parser.cts
// defines `hasNameableContent`), so it needs its own exemption set — the
// token/bracket rules above must NOT start exempting roadmap-parser.cts too,
// since it is not their owner.
const NAME_VALIDITY_EXEMPT = new Set([path.join('src', 'roadmap-parser.cts')]);

function walk(dir, acc, ext) {
  const extSet = ext || SCAN_EXT;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, acc, extSet);
    } else if (entry.isFile() && extSet.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

// #4634: markdown scan for the shell phase-arithmetic ban walks a disjoint set
// of roots/extensions from the src/**/*.cts scan above, so it gets its own thin
// wrapper over the same `walk` rather than a parallel tree-walker.
const MD_EXT = new Set(['.md']);
function walkMd(dir, acc) {
  return walk(dir, acc, MD_EXT);
}

// ─── #2761 M4: the heading-baseline selector census ────────────────────────
//
// `phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.<MODE>)` is the other half
// of this seam: it decides which intro grammar a call site compiles, and the
// MODE argument is a fact about that site's history that no behavioural test
// can recover — flipping verify's milestone-complete site from LABEL_ONLY to
// ANY_BRACKET grants a tolerance it has never had, and every behavioural test
// still passes. Pinning it therefore requires reading the authored source.
//
// That reading lives HERE, not in the test suite. `tests/**` runs
// `local/no-source-grep` at ERROR, and its documented exemption
// (CONTEXT.md: RULESET.TESTS.no-source-grep.exemption) is reserved for tests
// whose subject is a runtime CONTRACT FILE — STATE.md, config.toml,
// hooks.json, agent .md — which `src/*.cts` is not. The suite had claimed that
// exemption anyway. Scripts are the sanctioned home for source scanning (the
// rule runs at `warn` in `scripts/**`, and this file already scans src/ for the
// grammar rules above), so the scan is exported as structured data and the test
// asserts on the returned census instead of on file text.
const SELECTOR_CALL_RE = /phaseHeadingPrefixSrcFor\(/g;
const SELECTOR_BASELINE_RE = /phaseHeadingPrefixSrcFor\(\s*PHASE_HEADING_BASELINE\.(ANY_BRACKET|LABEL_ONLY)/g;

/**
 * Pure: census the heading-baseline selector calls in `text`.
 *
 * `total` counts EVERY invocation, so a call that does not name a
 * `PHASE_HEADING_BASELINE` member shows up as `total > ANY_BRACKET +
 * LABEL_ONLY` — a hole in the pin rather than a silently uncounted site.
 * Returns { ANY_BRACKET, LABEL_ONLY, total }.
 */
function countSelectorBaselines(text) {
  const out = { ANY_BRACKET: 0, LABEL_ONLY: 0, total: 0 };
  for (const m of text.matchAll(SELECTOR_BASELINE_RE)) out[m[1]] += 1;
  out.total = (text.match(SELECTOR_CALL_RE) || []).length;
  return out;
}

/**
 * Scan the authored source tree and return the selector census keyed by
 * repo-relative path, for every file that consumes the selector at least once.
 * `phase-id.cts` is excluded: it DEFINES the selector, so its own occurrences
 * are the declaration, not a consumer's choice of baseline.
 */
function scanSelectorBaselines(root) {
  const census = {};
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      if (EXEMPT.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const counts = countSelectorBaselines(text);
      if (counts.total > 0) census[path.basename(file)] = counts;
    }
  }
  return census;
}

/**
 * Scan the authored source tree and return every unsanctioned phase-token
 * re-derivation, each annotated with the repo-relative file path.
 */
function scanRepo(root) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
      if (EXEMPT.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const d of findPhaseIdRegexDrift(text)) {
        violations.push({ file: rel, kind: 'token', ...d });
      }
      // #2761 M3: the bracket grammar is the second thing this seam owns.
      for (const d of findBracketGrammarDrift(text)) {
        violations.push({ file: rel, kind: 'bracket', ...d });
      }
      // #4634: name-validity-guard drift, exempting only its own owner file.
      if (!NAME_VALIDITY_EXEMPT.has(rel)) {
        for (const d of findNameValidityDrift(text)) {
          violations.push({ file: rel, kind: 'name-validity', ...d });
        }
      }
      // #4634: branch-slug fallback anti-pattern, exempt nowhere.
      for (const d of findBranchSlugFallbackDrift(text)) {
        violations.push({ file: rel, kind: 'branch-slug-fallback', ...d });
      }
    }
  }
  return violations;
}

/**
 * Scan EVERYTHING this seam guards: the `src/**\/*.cts` token/bracket/
 * name-validity invariants (`scanRepo`) plus the markdown shell
 * phase-arithmetic ban (`scanMarkdownShellArith`). This is what the CLI runs;
 * `scanRepo` alone stays narrowly scoped to its original src/** contract so
 * a live, separately-tracked markdown defect (#4619) cannot make the
 * pinned-clean `scanRepo` test spuriously fail.
 */
function scanAll(root) {
  return [
    ...scanRepo(root),
    ...scanMarkdownShellArith(root),
    ...scanMarkdownSingleSegmentPhaseRegex(root),
  ];
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanAll(root);
  if (violations.length === 0) {
    process.stdout.write(
      'ok phase-id-drift: no unsanctioned phase-token, bracket-grammar, name-validity, ' +
        'branch-slug-fallback, or shell phase-arithmetic re-derivations found\n',
    );
    return;
  }
  process.stderr.write('phase-id-drift: literal re-derivation(s) of a canonical grammar found.\n');
  process.stderr.write(`Build the regex from phase-id.cjs \`${CANON_REF}\` (or phaseMarkdownRegexSource for a\n`);
  process.stderr.write(`known number) for the phase-number token, or from ${BRACKET_OWNER_HINT}\n`);
  process.stderr.write('for the bracket grammar, or call `hasNameableContent(` (src/roadmap-parser.cts) for\n');
  process.stderr.write('the name-validity predicate — or sanction the site with a dedicated\n');
  process.stderr.write('`// phase-id-owner: <reason>` comment on the line directly above the regex.\n');
  process.stderr.write('`$((10#...))` base-10-forced shell arithmetic is banned outright in\n');
  process.stderr.write('gsd-core/workflows/**/*.md and gsd-core/references/**/*.md — sanction with\n');
  process.stderr.write('`<!-- phase-id-owner: <reason> -->` on the line directly above.\n');
  process.stderr.write('The single-optional-dotted-segment phase regex `[0-9]+(\\.[0-9]+)?` (or its \\d\n');
  process.stderr.write('near-variant) is banned outright in gsd-core/workflows/**/*.md,\n');
  process.stderr.write('gsd-core/references/**/*.md, and agents/**/*.md — widen it to `*` (unbounded\n');
  process.stderr.write('segments) or sanction with `<!-- phase-id-owner: <reason> -->`.\n');
  process.stderr.write('A `.replace(\'{slug}\', ... || \'phase\')` fallback is banned outright (#4126) —\n');
  process.stderr.write('use `renderPhaseBranchName(` or sanction with\n');
  process.stderr.write('`// phase-id-owner: <reason>` on the line directly above:\n');
  for (const d of violations) {
    process.stderr.write(`  [${d.kind}] ${d.file}:${d.line}  ${d.found}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findPhaseIdRegexDrift,
  findBracketGrammarDrift,
  findNameValidityDrift,
  findBranchSlugFallbackDrift,
  findShellPhaseArithDrift,
  findSingleSegmentPhaseRegexDrift,
  scanMarkdownShellArith,
  scanMarkdownSingleSegmentPhaseRegex,
  scanRepo,
  scanAll,
  countSelectorBaselines,
  scanSelectorBaselines,
  TOKEN_DRIFT_RE,
  BRACKET_CODE_DRIFT_RE,
  NAME_VALIDITY_DRIFT_RE,
  BRANCH_SLUG_FALLBACK_DRIFT_RE,
  SHELL_PHASE_ARITH_DRIFT_RE,
  SINGLE_SEGMENT_PHASE_DRIFT_RE,
};

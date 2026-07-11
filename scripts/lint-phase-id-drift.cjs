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
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--; // nearest preceding non-blank line
    if (j >= 0 && OWNER_RE.test(lines[j])) continue;
    out.push({ line: i + 1, found: m[0] });
  }
  return out;
}

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);
// The canonical owner defines the grammar; it is exempt by construction.
const EXEMPT = new Set([path.join('src', 'phase-id.cts')]);

function walk(dir, acc) {
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
      walk(full, acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
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
        violations.push({ file: rel, ...d });
      }
    }
  }
  return violations;
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok phase-id-drift: no unsanctioned phase-token re-derivations outside phase-id.cts\n');
    return;
  }
  process.stderr.write('phase-id-drift: literal re-derivation(s) of the canonical phase-number token found.\n');
  process.stderr.write('Build the regex from phase-id.cjs `PHASE_NUMBER_TOKEN_SOURCE` (or phaseMarkdownRegexSource for a\n');
  process.stderr.write('known number), or sanction the site with a dedicated `// phase-id-owner: <reason>`\n');
  process.stderr.write('comment on the line directly above the regex:\n');
  for (const d of violations) {
    process.stderr.write(`  ${d.file}:${d.line}  ${d.found}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findPhaseIdRegexDrift, scanRepo, TOKEN_DRIFT_RE };

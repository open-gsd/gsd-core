// docs-guard-exempt: this file's own header comment states docs/ is deliberately OUT of scope for its citation scan.
'use strict';

// allow-test-rule: source-text-is-the-product (#3576) — this gate reads shipped
// runtime-loaded .md files and asserts on their literal citation text; the text IS
// the deployed contract, so reading it is the behavior under test.

/**
 * #3576 — dead-citation gate for the shipped trees.
 *
 * A backticked bare `references/<name>.md` cite resolves from NO install location:
 * agents install to ~/.claude/agents/, workflows to ~/.claude/gsd-core/workflows/,
 * references to a sibling of workflows — a bare relative `references/` path is dead
 * from every one of them. The canonical form (what every <required_reading> block
 * and @~/ include already uses) is `gsd-core/references/<file>.md`.
 *
 * #3206 fixed one file; PR #3435 swept agents/gsd-verifier.md and stopped at its
 * scope. This gate ends the class (epic #3473's B6 shape; #3518's drift guard is
 * the precedent). Scope: the runtime-loaded trees the issue prescribes — agents/,
 * gsd-core/{workflows,references,templates,contexts}, commands/, capabilities/.
 * docs/ (incl. translations) is deliberately OUT: human-facing, per-locale drift,
 * ranked lower severity by the issue — the recorded remainder.
 *
 * The trap the issue names: a guard that skips whole LINES containing `@~/` misses
 * a bare cite sharing a line with an include — strip only the `@~/…` token.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// createTempDir/cleanup rather than raw mkdtempSync/rmSync: cleanup() carries the Windows-EBUSY
// retry budget and refuses any path outside a recognised temp root (local/no-raw-rmsync-in-tests).
const { createTempDir, cleanup } = require('./helpers.cjs');
// The repo's ONE containment decision (ADR-4650, src/security.cts). Realpath-resolved, so an
// intermediate component referring outside the root is refused — which a file-type check cannot see.
const { tryWithinRoot } = require('../gsd-core/bin/lib/security.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const SCAN_ROOTS = [
  'agents',
  'gsd-core/workflows',
  'gsd-core/references',
  'gsd-core/templates',
  'gsd-core/contexts',
  'commands',
  'capabilities',
];

// A bare cite is BACKTICK-ANCHORED: `` `references/x.md` ``. The anchor is what
// excludes the genuinely relative href (`../references/…` — its backtick precedes
// `..`, not `references/`) and non-backticked prose mentions.
const BARE_CITE_RE = /`references\/([a-z0-9-]*\.md)`/g;
// The @~/ include token, stripped PER-TOKEN (never line-wise) before scanning.
const INCLUDE_TOKEN_RE = /@~\/[^\s`]+/g;

function walkShippedMarkdown() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(rootDir)) continue;
    // readdirSync returns platform-separated relative paths; normalize
    // unconditionally (repo convention) so diagnostics read identically on Windows.
    for (const f of fs.readdirSync(rootDir, { recursive: true })) {
      const normalized = String(f).split(path.sep).join('/');
      if (normalized.endsWith('.md')) files.push({ rel: `${root}/${normalized}`, abs: path.join(rootDir, f) });
    }
  }
  return files;
}

/** Find bare cites in one document, after per-token @~/ stripping. */
function findBareCites(text) {
  const stripped = text.replace(INCLUDE_TOKEN_RE, '');
  const offenders = [];
  let m;
  while ((m = BARE_CITE_RE.exec(stripped)) !== null) {
    offenders.push(`references/${m[1]}`);
  }
  return offenders;
}

/** Canonical `gsd-core/references/<name>` cites (backticked) — targets must exist. */
function findCanonicalCites(text) {
  const re = /`gsd-core\/references\/([a-z0-9-]*\.md)`/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return found;
}

describe('#3576 gate: shipped reference citations resolve', () => {
  test('#3576 gate: no bare references/ cites across shipped trees', () => {
    const offenders = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const cite of findBareCites(text)) {
        offenders.push(`${rel}: \`${cite}\` — bare cite resolves from no install location; use \`gsd-core/${cite}\``);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Bare `references/<name>.md` cites are dead pointers at runtime (#3576). '
        + 'Rewrite to the canonical `gsd-core/references/<file>.md` form:\n'
        + offenders.join('\n'),
    );
  });

  test('#3576 gate: every canonical reference cite target exists on disk', () => {
    const missing = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const name of findCanonicalCites(text)) {
        if (!fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', name))) {
          missing.push(`${rel}: \`gsd-core/references/${name}\` — target does not exist`);
        }
      }
    }
    assert.deepEqual(missing, [], 'Canonical cites must name files that exist:\n' + missing.join('\n'));
  });

  test('#3576 gate unit: @~/ token stripped per-token, never line-skipped; relative and canonical forms pass', () => {
    const includePlusBare = 'Read @~/gsd-core/references/tdd.md and `references/tdd.md` too';
    assert.deepEqual(
      findBareCites(includePlusBare),
      ['references/tdd.md'],
      'a bare cite sharing a line with an @~/ include must still be flagged (the issue-named trap)',
    );
    assert.deepEqual(findBareCites('see `../references/mvp-concepts.md`'), [], 'genuinely relative href is not a bare cite');
    assert.deepEqual(findBareCites('see `gsd-core/references/tdd.md`'), [], 'canonical cite is not a bare cite');
    assert.deepEqual(findBareCites('the references/ directory'), [], 'non-backticked prose mention is not a cite');
    assert.deepEqual(findBareCites('Read @~/gsd-core/references/tdd.md now'), [], 'a lone @~/ include line is clean after stripping');
  });
});

// ─── #4841: bare `@gsd-core/references/…` includes in agents/ ─────────────────
//
// The @-include twin of the #3576 bare cite. `@gsd-core/references/<x>.md` is
// repo-relative to the SOURCE tree: the installer's agent path rewrite
// (`applyAgentPathRewritesInner`) is anchored on `~/.claude` / `$HOME/.claude`
// and never touches it, so after install it addresses
// `<project>/gsd-core/references/<x>.md` — a directory no consuming project has —
// while the file it means sits at `~/.claude/gsd-core/references/<x>.md`, where
// the corpus's other 143 pointers already point. Eleven of these accumulated
// across four agents over three months because `check-contract-drift.cjs`'s
// reference-follower was equally blind to the spelling.
//
// Scope is agents/ ONLY, and the remainder is TWO trees rather than one: gsd-core/workflows
// carries the same spelling widely, and gsd-core/references carries it once —
// nyquist-compliance.md's pointer at failing-direction.md, the lone bare form among that
// directory's installed-path siblings. This gate takes no position on either, because
// whether an @-path OUTSIDE an agent body is client-resolved at all is unmeasured (#4841
// § Evidence 5): refusing the spelling there would assert a resolution semantics this
// issue never established. Naming both is what keeps the recorded remainder complete —
// a scope note that names only the workflow tree reads as an exhaustive one.

// A reference name is one or more path segments, each starting with `[A-Za-z0-9_-]` (NOT merely
// "a non-dot character" — `+x.md` and `é.md` do not match either), the last ending `.md`.
//
// THE SCAN CAPTURES THE WHOLE TOKEN AND THE GRAMMAR IS ANCHORED AT BOTH ENDS. The first form of these
// patterns ended at `\.md` with no following boundary, so on a longer token they matched as far as the
// grammar could reach and discarded the rest: `…/references/tdd.md/xx/yy` captured `tdd.md`, and the
// existence check below then validated a file the pointer does not name.
//
// The fix is deliberately NOT a boundary lookahead, and that choice is the point. A lookahead has to
// ENUMERATE the separators it denies, so it is only ever as complete as its own list: `\`, `%2f`,
// U+2044, U+2215, U+FF0F, U+29F8, U+FF3C, a double-encoded `%252f` and `%2e%2e` were each driven
// against candidate lookaheads and each needed its own clause, and every shape that closed the probed
// set still admitted some unprobed one. The enumeration is open, so no lookahead closes the class.
// Anchoring closes it for every SEPARATOR spelling, probed or not: whatever follows the name is inside
// the token and fails the anchor. A token that does not satisfy the grammar is REPORTED as malformed,
// never silently truncated to the prefix that does.
//
// WHAT ANCHORING ALONE DOES *NOT* CLOSE — two holes, both found by driving this file rather than
// reading it, and both closed here by a SEPARATE mechanism. Do not re-collapse them into the grammar:
//
//   1. **The trailing-prose strip is a hole in the anchor, by construction.** Punctuation has to be
//      stripped before validation or a pointer ending a sentence stops resolving — and `tdd.md?`
//      strips to `tdd.md`, which exists, so the gate would check a file the text does not name. That is
//      the original defect narrowed to the stripped class, not closed. It is also not decidable by
//      argument: on POSIX `tdd.md?` is a legal filename, so both readings are real. It IS decidable by
//      LOOKUP, which is what `pointerReadingIsUnambiguous` does — the ambiguity only bites when BOTH
//      readings resolve, and that is a question with an answer. The strip is MINIMAL (shortest run that
//      yields a valid name) so the discarded suffix is the smallest claim being made.
//   2. **Containment is not a property of the name.** The grammar refuses `.` and `..` segments, which
//      covers the TEXTUAL half and nothing more: an intermediate path component that refers outside the
//      tree is resolved transparently, so `linked/evil.md` is a textually-clean name addressing
//      something outside `references/`. Real paths are what settle it — see `resolvesToReferenceFile`.
//      An earlier revision of this comment claimed containment held "structurally" from the grammar.
//      It does not, and a fixture proves it.
//
// One consequence that IS the anchor's own: the existence assertion means what it says again. Its
// wording was weakened in an earlier round to "the name CAPTURED", because the capture need not be the
// token's target. What is validated now is the whole token less any trailing PROSE punctuation, and
// hole 1 above is exactly the price of that qualifier — which is why the qualifier is written down
// rather than rounded off to "the whole token".
//
// `check-contract-drift.cjs`'s reference-follower READS the path it matches, so it carries the same
// anchoring AND the same containment check. Both consumers changed together; neither is safe alone.
//
// (This file IS enrolled in the real-OS conformance tier, deliberately — the containment fixture below
// creates a directory link, which is platform-sensitive, and the tier is how such a test reaches a real
// OS. gen-platform-conformance-tier.cjs keys that on a pattern matched over whole file CONTENT. An
// earlier revision avoided the keyword to stay out of the matrix; that was right while the fixture was
// link-free and is wrong now. If the fixture ever goes away, re-run the generator rather than assuming
// either state: `--check` and `--target macos --check` are the arbiters.)
const BARE_POINTER_RE = /@gsd-core\/references\/(\S+)/g;
// BOTH installed-path spellings. `@$HOME/.claude/` is not a typo for `@~/.claude/` — the installer
// rewrites it explicitly (`applyAgentPathRewritesInner`, src/runtime-artifact-conversion.cts, the
// `/\$HOME\/\.claude\//g` replace beside the `~/.claude/` one), so it resolves exactly as the tilde
// form does. It reached NEITHER half of this gate until now: not refused, because it is not broken,
// and not existence-checked, because the matcher did not recognise it. A dead pointer written that
// way was therefore invisible here. Census at this tree, `@~` / bare / `@$HOME` per shipped root:
//   agents 154/0/0 · workflows 97/67/6 · references 10/1/0 · templates 3/0/0 · commands 37/0/3 ·
//   contexts 0/0/0 · capabilities 0/0/0
// Zero in agents/ today, which is why nothing was failing — an enumeration falls behind its domain
// silently, and `agents/` acquiring its first one needs no change to this file to become reachable.
const INSTALLED_POINTER_RE = /@(?:~|\$HOME)\/\.claude\/gsd-core\/references\/(\S+)/g;
// The FOURTH resolving spelling, and it is a FAMILY rather than a string. `--relative-includes`
// (#4377, bin/install.js) makes a local install emit project-relative includes, and the prefix is
// DERIVED from the resolved config dir — `.claude/` conventionally, but `--config-dir` makes it
// anything. So this one cannot be enumerated the way the other three can, and the pattern matches
// the SHAPE: one or MORE leading segments before `gsd-core`. One is not enough — a config dir nested
// under the project root emits `@config/nested/gsd-core/…`, driven against `_computePathPrefix`, and a
// single-segment pattern misses it. `+` also excludes the bare `@gsd-core/references/` form by
// construction (it needs at least one segment BEFORE `gsd-core`), so the bare form stays the bare form.
// A `.` or `..` prefix segment is refused for the same reason the NAME grammar refuses one — the
// installer emits neither, and accepting them would let a pointer's PREFIX carry a traversal the name
// half is careful not to.
//
// WHAT THIS PATTERN IS AND IS NOT. It is a SHAPE, not an enumeration of what `_computePathPrefix` can
// emit, and the difference is the honest statement: a config dir named `config+nested` or `ümlaut`
// emits a prefix this class does not match, because widening the class to arbitrary directory names is
// what turns every `@scope/…` token in prose into a pointer. The trade is deliberate and the cost is
// bounded — a prefix outside the class is simply not followed, which is the same position the gate was
// in for ALL project-relative spellings before this round. Zero occurrences in any shipped tree today.
const PROJECT_REL_POINTER_RE = /@(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+gsd-core\/references\/(\S+)/g;
const REFERENCE_NAME_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;
// ANCHORED AT BOTH ENDS, and the anchoring is the whole point. This tests a CUT SUFFIX, so the suffix
// must be punctuation END TO END. An end-anchored-only `/[…]+$/` merely asks whether the suffix ENDS in
// punctuation, which is true of `/xx?` and `XYZ?` — and the strip loop below then cuts straight through
// a path separator and calls the remainder a name. `tdd.md/xx?` resolved as `tdd.md`: the exact defect
// this file exists to close, reintroduced by the fix for a different one. Found by driving the loop
// rather than reading it, which is also how the defect it replaced was found.
const TRAILING_PROSE_ONLY_RE = /^[.,;:!?)\]}>"'`*]+$/;

/**
 * The reference name a pointer token denotes, or `null` when the token is not one.
 * Trailing prose punctuation is stripped; what remains must satisfy the name grammar WHOLE.
 */
function referenceNameOf(token) {
  // MINIMAL strip, not greedy: take the SHORTEST trailing run whose removal yields a valid name, so
  // the reading that keeps the most of what the author wrote wins. Greedy stripping is not wrong here
  // (the name must end `.md` either way) but minimal makes the discarded suffix the smallest possible
  // claim, and the ambiguity check below is keyed on that suffix.
  for (let cut = 0; cut <= token.length; cut++) {
    const candidate = token.slice(0, token.length - cut);
    if (cut > 0 && !TRAILING_PROSE_ONLY_RE.test(token.slice(token.length - cut))) break;
    if (REFERENCE_NAME_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Scan `text` for one pointer spelling. Returns `{ names, malformed }` — the well-formed reference
 * names, and the raw tokens that carry the pointer prefix but do not denote a reference name. The
 * loop runs to `null` on purpose: that is what resets the shared `/g` regex's `lastIndex` between files.
 */
function scanPointers(text, re) {
  const names = [];
  const found = [];
  const malformed = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = referenceNameOf(m[1]);
    if (name === null) malformed.push(m[0]);
    else {
      names.push(name);
      found.push({ name, raw: m[1] });   // raw carries the stripped suffix, if any
    }
  }
  return { names, found, malformed };
}

/** Bare `@gsd-core/references/<name>` includes — the form no installer rewrite reaches. */
function findBareIncludes(text) {
  return scanPointers(text, BARE_POINTER_RE).names.map((n) => `@gsd-core/references/${n}`);
}

/**
 * Installed-path `@~/.claude/gsd-core/references/<name>` includes — the reference name each pointer
 * NAMES. Per the anchoring above this is the whole token, not a prefix of it, so a caller resolving
 * this value resolves what the text actually says.
 */
function findInstalledIncludes(text) {
  return [
    ...scanPointers(text, INSTALLED_POINTER_RE).names,
    ...scanPointers(text, PROJECT_REL_POINTER_RE).names,
  ];
}

/** Same set, with each pointer's RAW token — what the ambiguity check below needs. */
function findInstalledPointers(text) {
  return [
    ...scanPointers(text, INSTALLED_POINTER_RE).found,
    ...scanPointers(text, PROJECT_REL_POINTER_RE).found,
  ];
}

/**
 * Does `name` resolve to a regular file whose REAL path is inside `<root>/gsd-core/references/`?
 *
 * Two checks, because each catches what the other cannot, and the first form of this shipped with only
 * the second:
 *
 *  - **Containment by real path.** `lstatSync` does not follow the FINAL component, so it refuses an
 *    entry under `references/` that refers somewhere else. It says nothing about INTERMEDIATE ones: a
 *    directory component that refers outside the tree is resolved transparently on the way to the final
 *    entry, so `linked/evil.md` passes an `isFile()` check while its real path is outside `references/`.
 *    Driven against a fixture and confirmed. Containment is decided by `tryWithinRoot`, this repo's one
 *    containment predicate (ADR-4650) — realpath-resolved, so intermediate components are resolved
 *    before the decision. The name grammar's refusal of `.`/`..` segments only ever covered the TEXTUAL
 *    half of that, and a hand-rolled prefix compare here is refused by lint for the same reason.
 *  - **Regular file.** `existsSync` establishes only that something is at the path — a DIRECTORY named
 *    `<x>.md` satisfies it. `lstatSync` is deliberate: checking the entry itself rather than its target
 *    is what keeps a final component that refers elsewhere from passing on its target's file-ness.
 *
 * The two compose: `lstat` rules on the last component, `realpath` on the whole path. Neither is
 * redundant.
 */
function resolvesToReferenceFile(name, root = REPO_ROOT) {
  const contained = tryWithinRoot(name, path.join(root, 'gsd-core', 'references'));
  if (contained === null) return false;   // escapes the directory — realpath-resolved, so intermediates count
  try {
    // Stat the ContainedPath the predicate returned, never a re-joined path (ADR-4650): the path that
    // was validated has to be the path that is probed, or the two can disagree.
    return fs.lstatSync(contained).isFile();
  } catch {
    return false;   // ENOENT, a broken reference, a loop: all the same finding
  }
}

/**
 * Is this pointer's reading UNAMBIGUOUS?
 *
 * Only relevant when trailing prose punctuation was stripped. `tdd.md?` strips to `tdd.md`, which
 * exists — so the gate would check a file the text does not name, which is the ROUND-2 DEFECT in
 * miniature, narrowed to the stripped class rather than closed. It is not closable by argument: on
 * POSIX `tdd.md?` is a legal filename, so "pointer followed by a question mark" and "file named
 * `tdd.md?`" are both real readings of the same bytes.
 *
 * It IS decidable, though, and the decision needs no judgement: the ambiguity only matters when BOTH
 * readings resolve. If the unstripped token also names something ON DISK at that path, the strip picked
 * one of two live referents and the pointer is reported. (On disk, not "contained" — the probe is a
 * plain existence check and does not establish containment; a raw token whose referent escapes the
 * directory is still a second reading of the same bytes, and reporting it is the fail-closed answer.)
 * If it does not — the overwhelming case, and every one of the 154 live pointers — the stripped reading
 * is the only one with a referent, so preferring it is not a redirect.
 */
function pointerReadingIsUnambiguous({ name, raw }, root = REPO_ROOT) {
  if (raw === name) return true;                       // nothing was stripped
  // Deliberately `existsSync` on the raw token rather than the contained predicate: the question is
  // whether the unstripped reading has ANY referent, and one that escapes the directory is still a
  // second reading of the same bytes. Escaping raw tokens therefore report rather than pass — fail
  // closed, which is the right direction, and the message below says "on disk" rather than claiming
  // containment the probe does not establish.
  return !fs.existsSync(path.join(root, 'gsd-core', 'references', raw));
}

/** Tokens carrying a reference-pointer prefix that do not denote a reference name, either spelling. */
function findMalformedPointers(text) {
  return [
    ...scanPointers(text, BARE_POINTER_RE).malformed,
    ...scanPointers(text, INSTALLED_POINTER_RE).malformed,
    ...scanPointers(text, PROJECT_REL_POINTER_RE).malformed,
  ];
}

function walkAgentMarkdown() {
  return walkShippedMarkdown().filter(({ rel }) => rel.startsWith('agents/'));
}

describe('#4841 gate: agent @-includes use the installed-path form', () => {
  test('#4841 gate: no bare @gsd-core/references/ includes in agents/', () => {
    const offenders = [];
    for (const { rel, abs } of walkAgentMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const inc of findBareIncludes(text)) {
        offenders.push(
          `${rel}: ${inc} — no installer rewrite reaches this spelling on any profile; `
            + `use @~/.claude/${inc.slice(1)}`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Bare `@gsd-core/references/<name>.md` includes address a path no consuming project has (#4841). '
        + 'Rewrite to the installed-path `@~/.claude/gsd-core/references/<name>.md` form:\n'
        + offenders.join('\n'),
    );
  });

  test('#4841 gate: every installed-path @-include in agents/ names a reference that exists', () => {
    const missing = [];
    for (const { rel, abs } of walkAgentMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const pointer of findInstalledPointers(text)) {
        if (!pointerReadingIsUnambiguous(pointer)) {
          missing.push(
            `${rel}: @~/.claude/gsd-core/references/${pointer.raw} — AMBIGUOUS: both this token and `
              + `\`${pointer.name}\` name something on disk; the trailing punctuation cannot be `
              + 'read as prose here',
          );
        } else if (!resolvesToReferenceFile(pointer.name)) {
          missing.push(
            `${rel}: @~/.claude/gsd-core/references/${pointer.name} — target is not a regular file `
              + 'contained under gsd-core/references/',
          );
        }
      }
    }
    assert.deepEqual(missing, [], 'Installed-path includes must name files that exist:\n' + missing.join('\n'));
  });

  // The gate that makes the assertion above mean what it says. Without it, a token the name grammar
  // cannot parse WHOLE would have to be either silently dropped or silently truncated to a prefix —
  // and the truncated prefix is a real file, so the existence check passes over a pointer that names
  // nothing. Reporting is the third option and the only honest one: the pointer is in the shipped
  // text, it does not denote a reference, and a human should look at it.
  test('#4841 gate: every reference pointer in agents/ denotes a whole reference name', () => {
    const malformed = [];
    for (const { rel, abs } of walkAgentMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const token of findMalformedPointers(text)) {
        malformed.push(`${rel}: ${token} — carries a reference-pointer prefix but does not name a reference`);
      }
    }
    assert.deepEqual(
      malformed,
      [],
      'A reference pointer must name a reference WHOLE — one or more `[A-Za-z0-9_-]`-initial segments '
        + 'ending `.md`. A token that continues past the name resolves somewhere other than where it reads:\n'
        + malformed.join('\n'),
    );
  });

  test('#4841 gate: the agents/ scan is not vacuous — it reaches the four agents the defect lived in', () => {
    const rels = new Set(walkAgentMarkdown().map(({ rel }) => rel));
    for (const agent of ['gsd-debugger', 'gsd-planner', 'gsd-plan-checker', 'gsd-verifier']) {
      assert.ok(rels.has(`agents/${agent}.md`), `agents/${agent}.md must be in the scanned set`);
    }
  });

  test('#4841 gate unit: the matcher flags the bare form only', () => {
    assert.deepEqual(
      findBareIncludes('recipes: @gsd-core/references/verifier-wiring-patterns.md'),
      ['@gsd-core/references/verifier-wiring-patterns.md'],
      'the bare include is flagged',
    );
    assert.deepEqual(
      findBareIncludes('recipes: @~/.claude/gsd-core/references/verifier-wiring-patterns.md'),
      [],
      'the installed-path include is not flagged (the slash before gsd-core is not an @)',
    );
    assert.deepEqual(findBareIncludes('see `gsd-core/references/tdd.md`'), [], 'a backticked cite is not an @-include');
    assert.deepEqual(
      findBareIncludes('@gsd-core/references/a.md then @gsd-core/references/b.md.'),
      ['@gsd-core/references/a.md', '@gsd-core/references/b.md'],
      'every occurrence on a line is reported, and a trailing period is not part of the name',
    );
    assert.deepEqual(findInstalledIncludes('x @~/.claude/gsd-core/references/tdd.md y'), ['tdd.md']);
    assert.deepEqual(
      findBareIncludes('@gsd-core/references/few-shot-examples/verifier.md'),
      ['@gsd-core/references/few-shot-examples/verifier.md'],
      'a nested bare include is flagged too (the corpus carries nested installed-path includes)',
    );
    assert.deepEqual(
      findInstalledIncludes('@~/.claude/gsd-core/references/few-shot-examples/verifier.md'),
      ['few-shot-examples/verifier.md'],
      'a nested installed-path include is existence-checked by its nested name',
    );
    assert.deepEqual(findBareIncludes('@gsd-core/references/./x.md'), [], 'a dot segment is not a reference name');
  });

  // The third installed-path spelling. The installer rewrites `$HOME/.claude/` exactly as it rewrites
  // `~/.claude/`, so a pointer written this way resolves — and until this round it reached neither the
  // refusal half nor the existence half of this gate. Zero occurrences in agents/ today; the point is
  // that the enumeration now covers the domain rather than the corpus that happens to exist.
  test('#4841 gate unit: the $HOME installed-path spelling is followed like the tilde form', () => {
    assert.deepEqual(
      findInstalledIncludes('recipes: @$HOME/.claude/gsd-core/references/tdd.md'),
      ['tdd.md'],
      'the $HOME spelling names a reference and is existence-checked',
    );
    assert.deepEqual(
      findBareIncludes('recipes: @$HOME/.claude/gsd-core/references/tdd.md'),
      [],
      'it is an installed-path form, not the bare form — it must not be refused',
    );
    assert.deepEqual(
      findInstalledIncludes('@$HOME/.claude/gsd-core/references/few-shot-examples/verifier.md'),
      ['few-shot-examples/verifier.md'],
      'nested names resolve under this spelling too',
    );
    // It is anchored by the same grammar, so it refuses the same continuations.
    assert.deepEqual(findInstalledIncludes('@$HOME/.claude/gsd-core/references/tdd.md/xx/yy'), []);
    assert.deepEqual(
      findMalformedPointers('@$HOME/.claude/gsd-core/references/tdd.md/xx/yy'),
      ['@$HOME/.claude/gsd-core/references/tdd.md/xx/yy'],
    );
  });

  // The regression the round-2 review asked for. Each case below captured a PREFIX under the previous
  // patterns — `tdd.md`, a real file — so each one passed the existence check while naming something
  // else. Anchoring the grammar at both ends is what turns every one of them into a reported token.
  test('#4841 gate unit: a token that continues past the name is malformed, never truncated to a prefix', () => {
    const continuations = [
      ['@~/.claude/gsd-core/references/tdd.md/xx/yy', 'a path segment that cannot end a name'],
      ['@~/.claude/gsd-core/references/tdd.md/../../README.md', 'a TRAILING traversal — the case the prior round could not refuse'],
      ['@~/.claude/gsd-core/references/tdd.md/.hidden/y.md', 'a dot-initial segment mid-path'],
      ['@~/.claude/gsd-core/references/tdd.md\\xx', 'a backslash separator'],
      ['@~/.claude/gsd-core/references/tdd.md%2fxx', 'a percent-encoded separator'],
      ['@~/.claude/gsd-core/references/tdd.md%252fxx', 'a DOUBLE-encoded separator'],
      ['@~/.claude/gsd-core/references/tdd.md%2e%2e/xx', 'an encoded traversal'],
      ['@~/.claude/gsd-core/references/tdd.md⁄xx', 'U+2044 FRACTION SLASH'],
      ['@~/.claude/gsd-core/references/tdd.md∕xx', 'U+2215 DIVISION SLASH'],
      ['@~/.claude/gsd-core/references/tdd.md／xx', 'U+FF0F FULLWIDTH SOLIDUS'],
      ['@~/.claude/gsd-core/references/tdd.md⧸xx', 'U+29F8 BIG SOLIDUS'],
      ['@~/.claude/gsd-core/references/tdd.md＼xx', 'U+FF3C FULLWIDTH REVERSE SOLIDUS'],
      ['@~/.claude/gsd-core/references/tdd.mdx/xx', 'a longer extension'],
      ['@~/.claude/gsd-core/references/../../README.md', 'a LEADING traversal — unmatched before, reported now'],
      // These three are the regression the MINIMAL-strip loop introduced and the resumed round review
      // found: the cut-suffix test was not START-anchored, so a suffix merely ENDING in punctuation
      // was accepted and the loop cut straight through a path separator. `tdd.md/xx?` resolved as
      // `tdd.md` — the defect this file exists to close, restored by the fix for a different one.
      ['@~/.claude/gsd-core/references/tdd.md/xx?', 'a separator inside a suffix that ends in punctuation'],
      ['@~/.claude/gsd-core/references/tdd.md/%2f?', 'an encoded separator inside such a suffix'],
      ['@~/.claude/gsd-core/references/tdd.mdXYZ?', 'ordinary characters inside such a suffix'],
    ];
    for (const [token, why] of continuations) {
      assert.deepEqual(findInstalledIncludes(token), [], `must capture no name: ${why}`);
      assert.deepEqual(findMalformedPointers(token), [token], `must be reported as malformed: ${why}`);
    }
    // The bare spelling is anchored by the same grammar, so it refuses the same shapes.
    assert.deepEqual(findBareIncludes('@gsd-core/references/tdd.md/xx/yy'), []);
    assert.deepEqual(
      findMalformedPointers('@gsd-core/references/tdd.md/xx/yy'),
      ['@gsd-core/references/tdd.md/xx/yy'],
    );
  });

  // The reversion control for the regular-file check. Without a fixture that check reverts SILENTLY —
  // nothing in the real tree distinguishes `existsSync` from `lstatSync().isFile()`, which is exactly
  // why the weaker form survived authoring. A directory named `<x>.md` is the cheapest case that does.
  test('#4841 gate unit: a pointer target must be a regular file, not merely present', () => {
    const root = createTempDir('gsd-4841-refs-');
    try {
      const refs = path.join(root, 'gsd-core', 'references');
      fs.mkdirSync(refs, { recursive: true });
      fs.writeFileSync(path.join(refs, 'real.md'), '# real\n');
      fs.mkdirSync(path.join(refs, 'directory.md'));          // present, and not a file
      fs.mkdirSync(path.join(refs, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(refs, 'nested', 'deep.md'), '# deep\n');

      assert.equal(resolvesToReferenceFile('real.md', root), true, 'a regular file resolves');
      assert.equal(resolvesToReferenceFile('nested/deep.md', root), true, 'a nested regular file resolves');
      assert.equal(resolvesToReferenceFile('absent.md', root), false, 'an absent target does not resolve');
      assert.equal(
        resolvesToReferenceFile('directory.md', root),
        false,
        'a DIRECTORY named <x>.md satisfies existsSync and must not satisfy this check — the whole point',
      );
    } finally {
      cleanup(root);
    }
  });

  // The three refutations the pre-push round review returned, each now a control. Every one was
  // DRIVEN against this tree before it was believed; none is a hypothetical.
  test('#4841 gate unit: an INTERMEDIATE directory reference cannot escape gsd-core/references/', () => {
    const root = createTempDir('gsd-4841-contain-');
    try {
      const refs = path.join(root, 'gsd-core', 'references');
      fs.mkdirSync(refs, { recursive: true });
      fs.mkdirSync(path.join(root, 'outside'));
      fs.writeFileSync(path.join(root, 'outside', 'evil.md'), '# evil\n');
      fs.writeFileSync(path.join(refs, 'real.md'), '# real\n');
      let linked = true;
      try {
        fs.symlinkSync(path.join(root, 'outside'), path.join(refs, 'linked'), 'dir');
      } catch {
        linked = false;   // a platform that refuses the fixture cannot exercise the property
      }
      assert.equal(resolvesToReferenceFile('real.md', root), true, 'a contained regular file still resolves');
      if (linked) {
        // The entry IS a regular file and lstat() on it says so — the whole point is that file-ness
        // was never the question. Its REAL path is outside, and that is what must refuse it.
        assert.equal(
          fs.lstatSync(path.join(refs, 'linked', 'evil.md')).isFile(),
          true,
          'precondition: the fixture is exactly the case a file-type check passes',
        );
        assert.equal(
          resolvesToReferenceFile('linked/evil.md', root),
          false,
          'an intermediate component resolving outside references/ must be refused',
        );
      }
    } finally {
      cleanup(root);
    }
  });

  test('#4841 gate unit: a stripped suffix is refused when BOTH readings resolve', () => {
    const root = createTempDir('gsd-4841-ambig-');
    try {
      const refs = path.join(root, 'gsd-core', 'references');
      fs.mkdirSync(refs, { recursive: true });
      fs.writeFileSync(path.join(refs, 'tdd.md'), '# tdd\n');
      const plain = { name: 'tdd.md', raw: 'tdd.md' };
      const stripped = { name: 'tdd.md', raw: 'tdd.md?' };
      assert.equal(pointerReadingIsUnambiguous(plain, root), true, 'nothing stripped is never ambiguous');
      assert.equal(
        pointerReadingIsUnambiguous(stripped, root),
        true,
        'only the stripped reading resolves, so preferring it is not a redirect',
      );
      let named = true;
      try {
        fs.writeFileSync(path.join(refs, 'tdd.md?'), '# literally named with the punctuation\n');
      } catch {
        named = false;   // a filesystem that refuses the name cannot exercise the property
      }
      if (named) {
        assert.equal(
          pointerReadingIsUnambiguous(stripped, root),
          false,
          'both readings resolve — the strip would pick one of two live referents, so report it',
        );
      }
    } finally {
      cleanup(root);
    }
  });

  test('#4841 gate unit: the project-relative install spelling is followed too', () => {
    // --relative-includes (#4377) derives its prefix from the resolved config dir, so the spelling is
    // a family rather than a string. The matcher keys on the SHAPE; `@gsd-core/` itself is excluded so
    // the bare form stays the bare form.
    assert.deepEqual(
      findInstalledIncludes('see @.claude/gsd-core/references/tdd.md'),
      ['tdd.md'],
      'the conventional project-relative prefix resolves',
    );
    assert.deepEqual(
      findInstalledIncludes('see @.claude-work/gsd-core/references/tdd.md'),
      ['tdd.md'],
      'a --config-dir prefix resolves too — the point of matching the shape',
    );
    assert.deepEqual(
      findInstalledIncludes('see @gsd-core/references/tdd.md'),
      [],
      'the BARE form is not a project-relative pointer — it must stay refused, not existence-checked',
    );
    assert.deepEqual(
      findBareIncludes('see @.claude/gsd-core/references/tdd.md'),
      [],
      'and the project-relative form is not the bare form',
    );
    assert.deepEqual(
      findInstalledIncludes('see @config/nested/gsd-core/references/tdd.md'),
      ['tdd.md'],
      'a NESTED config dir resolves too — `_computePathPrefix` emits a multi-segment prefix, and a '
        + 'single-segment pattern missed it',
    );
    assert.deepEqual(
      findInstalledIncludes('see @~/.claude/gsd-core/references/tdd.md'),
      ['tdd.md'],
      'and the tilde form is matched once, by its own pattern — not twice',
    );
    assert.deepEqual(findInstalledIncludes('see @.claude/gsd-core/references/tdd.md/xx/yy'), []);
    // A `.` or `..` PREFIX segment is refused for the same reason the name grammar refuses one. The
    // installer emits neither, and accepting them would let the prefix carry a traversal the name half
    // is careful not to.
    for (const dotted of [
      '@./gsd-core/references/tdd.md',
      '@../gsd-core/references/tdd.md',
      '@a/../gsd-core/references/tdd.md',
    ]) {
      assert.deepEqual(findInstalledIncludes(dotted), [], `a dot prefix segment is not an install prefix: ${dotted}`);
    }
  });

  // The false-positive surface, pinned so it is VISIBLE and deliberate rather than discovered. Every
  // shape below carries a reference prefix and is reported as malformed, and for each one a reasonable
  // author could have meant it to work. Measured across every shipped root: ZERO such tokens exist
  // today, which is why this is a residual and not a bug — but "zero today" is exactly the argument
  // that produced the defect this round is fixing, so it is written down instead of assumed away.
  // If a future change makes any of these resolve, this test fails and that change is deliberate.
  test('#4841 gate unit: the known false-positive shapes, recorded rather than discovered', () => {
    const reported = [
      ['@~/.claude/gsd-core/references/tdd.md\u2014see', 'an em dash as a prose boundary'],
      ['@~/.claude/gsd-core/references/tdd.md\u3002', 'an ideographic full stop'],
      ['@~/.claude/gsd-core/references/c++.md', 'a legal filename the name grammar does not admit'],
      ['@~/.claude/gsd-core/references/<name>.md', 'a template placeholder in prose or a code fence'],
    ];
    for (const [token, why] of reported) {
      assert.deepEqual(findInstalledIncludes(token), [], `not resolved: ${why}`);
      assert.deepEqual(findMalformedPointers(token), [token], `reported, not silently dropped: ${why}`);
    }
    // The escape hatch, such as it is: put the placeholder outside the pointer prefix. Recorded here
    // because "write it differently" is otherwise documented nowhere.
    assert.deepEqual(findMalformedPointers('a reference under `gsd-core/references/` named <name>.md'), []);
  });

  // The other half of the same rule: anchoring must not cost the corpus. Every shape below is a
  // legitimate pointer that a boundary LOOKAHEAD would have dropped from the scan — a silent loss of
  // coverage, which is the failure direction a gate can least afford.
  test('#4841 gate unit: anchoring keeps the pointers the corpus actually contains', () => {
    const kept = [
      ['@~/.claude/gsd-core/references/tdd.md', 'bare, end of input'],
      ['see @~/.claude/gsd-core/references/tdd.md now', 'mid-sentence'],
      ['see @~/.claude/gsd-core/references/tdd.md.', 'ending a sentence'],
      ['see `@~/.claude/gsd-core/references/tdd.md`', 'inside backticks'],
      ['see (@~/.claude/gsd-core/references/tdd.md)', 'inside parentheses'],
      ['see **@~/.claude/gsd-core/references/tdd.md**', 'inside bold markers'],
      ['see @~/.claude/gsd-core/references/tdd.md, and', 'followed by a comma'],
      ['see [@~/.claude/gsd-core/references/tdd.md]', 'inside brackets'],
      ['col\t@~/.claude/gsd-core/references/tdd.md\tcol', 'tab-delimited'],
    ];
    for (const [text, why] of kept) {
      assert.deepEqual(findInstalledIncludes(text), ['tdd.md'], `must still resolve: ${why}`);
      assert.deepEqual(findMalformedPointers(text), [], `must not be reported malformed: ${why}`);
    }
    // A nested name that is well-formed to its END is captured WHOLE, not truncated at the first `.md`.
    assert.deepEqual(findInstalledIncludes('@~/.claude/gsd-core/references/a.md/b.md'), ['a.md/b.md']);
  });
});

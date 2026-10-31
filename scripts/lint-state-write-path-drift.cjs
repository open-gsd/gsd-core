#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the STATE.md WRITE PATH — epic #3408, issue
 * #3468, ADR-3408 Decision 5, contract §8.1/§8.2/§8.3
 * (`docs/adr/3408-state-write-path-preservation.md` is the contract this
 * guard enforces; read it first) — SHRUNK per ADR-3473 §8.6 (issue #3871).
 *
 * WHAT MOVED INTO THE TYPE SYSTEM (ADR-3473 §8.6): `writeStateMd`'s third
 * parameter now REQUIRES a `StateTransaction` of `kind: 'rebuild'`, produced
 * only by `openStateTransaction()` / `rebuildStateTransaction()`
 * (`src/state-transition.cts`) — `writeStateMd` itself throws
 * `STATE_TRANSACTION_KIND_INVALID` for anything else. The two exceptions this
 * guard used to track as a RATCHETED STRING MATCH against
 * `scripts/state-write-path-drift-baseline.json` — `cmdStateSync`
 * (`src/state.cts`, #905's "let the body win") and `REGENERATE_STATE`
 * (`src/health-diagnostic.cts`, `/gsd-health --repair`'s factory reset) — are
 * NO LONGER TRACKED HERE. Both are now a constructor the type system names
 * (`rebuildStateTransaction`), not an entry a human had to remember to keep
 * acknowledging in a baseline file. That baseline file, and the whole
 * ratchet machinery that existed ONLY to support it (loading it, the
 * STALE-entry check, `--baseline` regeneration), is retired along with it —
 * the `writeStateMd(` ARM of the old `findSeamBypasses` axis is gone for
 * good, because the type system now names both of its exceptions.
 *
 * WHAT STAYED, RETITLED, AND MADE TERMINAL (issue #3871 review): the OTHER
 * half of `findSeamBypasses` — every direct `syncStateFrontmatter(` /
 * `applyPostSyncPreservation(` call outside their owner
 * (`syncAndPreserveStateMd`, `src/state.cts`) — is NOT redundant. The type
 * system gates `writeStateMd`'s THIRD PARAMETER; it says nothing about a call
 * site that re-assembles `syncStateFrontmatter` + `applyPostSyncPreservation`
 * itself instead of calling the one write-seam composition. ADR-3408 §8.3:
 * "Assembling the stages at a call site is a re-derivation even when every
 * step calls the owner." #3469 found exactly that shape live in
 * `cmdPhaseComplete`'s atomic-commit adapter (`src/phase.cts`) — every step
 * called an owner, so an owner-level test and this guard's OLD, narrower
 * scan both stayed green while the composition itself drifted from
 * `readModifyWriteStateMd`'s. See `findCompositionBypasses` below. Unlike
 * the retired `writeStateMd(` arm, this one ships TERMINAL, not ratcheted —
 * mirrors `findPromptSeamUses`'s own conversion in this same shrink: no
 * legitimate call site outside the owner exists today, so any occurrence is
 * a violation, not an entry to acknowledge.
 *
 * WHAT THIS GUARD STILL OWNS, because the type system cannot make it
 * unrepresentable:
 *
 *   AXIS 1 — POLICY DISPATCH (§8.1). `applyStatePreservation` must select
 *   its branch from a `FIELD_CLASSIFICATION` row's `preservation` value,
 *   never from a field NAME. Every `getFieldClassification('<string
 *   literal>')` inside `src/state-transition.cts` is a field-name-keyed
 *   branch — the shape that let four declared rows go unimplemented until
 *   #3258, and that leaves `derive` and `clear` with no executor today. A
 *   VARIABLE argument (`getFieldClassification(field)`) is the CORRECT
 *   table-driven shape and is deliberately NOT matched. Also matched: a
 *   direct `field === '<literal>'` / `field !== '<literal>'` / `'<literal>'
 *   === field` comparison of the dispatch loop's own `field` variable — the
 *   same prohibited shape routed AROUND `getFieldClassification` instead of
 *   through it (#3468 found this exact form live in `applyPreserveIfPlaceholder`,
 *   undetected by the call-shape check alone). Scoped to the identifier
 *   `field` only; see `FIELD_VAR_EQ_LITERAL_RE`'s own comment for why.
 *
 *   AXIS 2 — RAW STATE WRITE (§8.6, RETAINED). A direct `fs.writeFileSync(`
 *   call whose target argument is the state path (`statePath`, a literal
 *   containing `STATE.md`, or — #5104 — a variable that resolves to either
 *   through same-function assignments, even when the call is wrapped over
 *   several lines) is a write that skips BOTH the write seam
 *   (`writeStateMd`/`syncAndPreserveStateMd`) AND the OS Shell Projection
 *   seam (`platformWriteSync`, `src/shell-command-projection.cts`) entirely.
 *   No constructor or type can make this unrepresentable — Node's `fs`
 *   module is always one `import` away — so this axis stays a plain
 *   string-match scan, unratcheted: any occurrence is a violation, because no
 *   legitimate call site in this codebase writes STATE.md this way (every
 *   real writer goes through `platformWriteSync`). A call too long to resolve
 *   (`MAX_RAW_WRITE_TEXT_LENGTH`), or past the file's resolver budget
 *   (`MAX_RAW_WRITE_RESOLVER_WORK`), is reported too, as
 *   `RAW_STATE_WRITE_UNRESOLVED`. This axis's zero does NOT
 *   prove that no raw STATE.md writer remains: it is a line scan, and
 *   `findRawStateWrites`'s own header lists the verified shapes it misses
 *   (ADR-3408 Decision 5; the syntax-tree follow-up is #5279).
 *
 *   AXIS 3 — FRONTMATTER-SHAPED WRITE (§8.3(b), closed Phase 2 / #3469).
 *   `findUnstrippedContentWrites` below flags a `stateReplaceField(` call
 *   only when BOTH (a) its field-name argument is a VARIABLE, not a fixed
 *   string literal, and (b) its content argument has not been run through
 *   `stripFrontmatter` first (a narrow backward-scan approximation, not full
 *   dataflow — see the function's own docstring).
 *
 *   AXIS 4 — PROMPT-LAYER WRITE (§8.3, Decision 4(d)). Prose in the prompt
 *   layer instructing an agent to shell out to a write-side `gsd-tools`
 *   subcommand is the same write seam, expressed as markdown rather than
 *   TypeScript — a check the type system cannot reach at all, since markdown
 *   is never compiled. Any occurrence is a violation.
 *
 *   AXIS 5 — COMPOSITION BYPASS (§8.3, RETAINED, issue #3871). A direct
 *   `syncStateFrontmatter(` or `applyPostSyncPreservation(` call outside
 *   their owner (`syncAndPreserveStateMd`) is a re-assembly of the write-seam
 *   composition — the exact shape #3469 found live in `cmdPhaseComplete`.
 *   `writeStateMd(` is deliberately NOT scanned here (that arm is retired,
 *   §8.6) — `writeStateMd`'s own legitimate direct `syncStateFrontmatter(`
 *   call (the sanctioned #905 exception) is instead exempted by function
 *   name, same as the composition owner itself; see
 *   `SEAM_OWNER_EXEMPT_FUNCTIONS`. Terminal: any occurrence is a violation.
 *
 * DESIGN CONSTRAINTS (ADR-3180 Decision 4, adopted verbatim by ADR-3408):
 *   - 4(a) whole-repo scan, never an allowlist. ADR-3180's own phases found
 *     26/5/54 copies where their epics scoped 3/3/4 — a scoped guard earns
 *     nothing.
 *   - 4(d) the scan surface is DECLARED and is NOT just `src/` — `src/`
 *     alone is itself an allowlist one directory wide; #1762 traced a wrong
 *     count to a shell snippet in `gsd-core/workflows/progress.md`.
 *
 * GOODHART, PER ADR-3408 DECISION 5: "0 violations" is a LAGGING metric — a
 * measure about to become a target. This guard's own `_comment` and its
 * human-readable success message both say so: the zero this guard reports
 * must NEVER be quoted alone; it is only meaningful beside the behavioral
 * identity test's result (the consumer-output assertion Decision 5's gaming
 * table names as the actual defense).
 *
 * String literals are matched, never parsed as an AST — deliberately, per
 * `scripts/lint-state-field-drift.cjs`'s own precedent: over-reporting
 * (flagging a comment or a string that merely looks like a call) is safe;
 * under-reporting (missing a real bypass) is the failure this guard exists
 * to prevent. `stripComments` does not track quoted strings for exactly
 * this reason — see its own header.
 *
 * CORRECTION TO ADR-3473 §8.6's TEXT, RECORDED HERE SO A FUTURE READER
 * COMPARING THE ADR TO THIS FILE DOES NOT CONCLUDE THE FILE DRIFTED:
 * §8.6 says this guard "keeps only its raw-write check (`fs.writeFileSync`
 * against the state path), which the type cannot make unrepresentable." That
 * sentence is wrong on both halves. First, no such check existed anywhere in
 * this file before this shrink — `findRawStateWrites` (Axis 2, below) is
 * NET-NEW, written for this shrink, not retained from a prior version.
 * Second, this file did not (and does not) drop to "only" one check: besides
 * the retired `writeStateMd(` arm of the old `findSeamBypasses` axis (the
 * half §8.6 correctly names for removal, since the type system now names
 * both of its exceptions), `findPolicyDispatchDrift`, `findUnimplementedPolicies`,
 * `findUnstrippedContentWrites`, `findPromptSeamUses`, and the RETAINED
 * `syncStateFrontmatter`/`applyPostSyncPreservation` composition-bypass half
 * of `findSeamBypasses` (now `findCompositionBypasses`, terminal — issue
 * #3871 review) all remain, because §8.6 names neither them nor anything
 * that makes what they check unrepresentable — a field-name-keyed dispatch
 * branch, an unimplemented `FieldPreservation` policy, an unstripped
 * frontmatter write, prompt-layer prose shelling out to `gsd-tools`, and a
 * re-assembled write-seam composition are all still exactly as representable
 * in TypeScript (or in markdown, for the prompt-layer one) after the
 * state-transaction constructor as they were before it — the constructor
 * gates `writeStateMd`'s third parameter, nothing about a call site that
 * never goes through `writeStateMd` at all. Do not edit the ADR to match
 * this file; this paragraph is the correction of record.
 */

const path = require('node:path');
const { scanTree, sanitizeForReport } = require('./lib/drift-scan.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

// Frozen REASON enum — mirrors `lint-state-field-drift.cjs`'s house style of
// naming every failure shape explicitly rather than reusing one generic
// "violation" string, so a reader can `grep` a reason string straight back
// to the paragraph of this header (or of the ADR) that explains it.
const REASON = Object.freeze({
  FIELD_NAME_DISPATCH: 'field_name_dispatch',
  UNIMPLEMENTED_POLICY: 'unimplemented_policy',
  // Axis 3 (§8.3(b), closed Phase 2 / #3469): a `stateReplaceField(` call
  // with a variable field-name argument whose content argument was not run
  // through `stripFrontmatter` first — see `findUnstrippedContentWrites`.
  UNSTRIPPED_CONTENT_WRITE: 'unstripped_content_write',
  // Axis 2 (§8.6, retained): a raw `fs.writeFileSync(` call targeting the
  // state path — see `findRawStateWrites`.
  RAW_STATE_WRITE: 'raw_state_write',
  // Axis 2 (#5104): a raw `fs.writeFileSync(` call too long to resolve within
  // `MAX_RAW_WRITE_TEXT_LENGTH` (a call left open, or a line of many writes),
  // or reached after the file's `MAX_RAW_WRITE_RESOLVER_WORK` is spent.
  // Reported without resolution, so the caps fail closed. See
  // `findRawStateWrites`.
  RAW_STATE_WRITE_UNRESOLVED: 'raw_state_write_unresolved',
  // ADR-4629 §8.1 (epic #4629, C1): a residual `readModifyWriteStateMd(path,
  // (content) => …)` call whose transform is an inline anonymous arrow/function
  // — the opaque shape §8.1 replaces with a declared StateWriteIntent. Recognized
  // by `findOpaqueStateTransforms`; a CAPABILITY in C1 (not wired into collect()),
  // wired terminal in C2 as the residual callers migrate (ADR-3408 §6 phasing).
  OPAQUE_STATE_TRANSFORM: 'opaque_state_transform',
  // Axis 4 (§8.3, Decision 4(d)): prompt-layer prose shelling out to a
  // write-side `gsd-tools` subcommand — see `findPromptSeamUses`.
  PROMPT_LAYER_STATE_WRITE: 'prompt_layer_state_write',
  // Axis 5 (§8.3, RETAINED, issue #3871): a direct `syncStateFrontmatter(` or
  // `applyPostSyncPreservation(` call outside their owner
  // (`syncAndPreserveStateMd`) — see `findCompositionBypasses`.
  COMPOSITION_BYPASS: 'composition_bypass',
});

// Scan surface — declared, per Decision 4(d), never inferred from `src/`
// alone. `src/` covers the executor; the prompt layer covers markdown that
// can shell out to `state.patch` / `phase.complete` and post-process the
// result outside any TypeScript this guard could see.
const SRC_DIRS = ['src'];
const SRC_EXT = new Set(['.cts']);
const PROMPT_DIRS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const PROMPT_EXT = new Set(['.md']);

// The executor (Axis 1 / Axis 3). Forward-slash literal: every `rel` this
// guard compares against it is unconditionally POSIX-normalized first
// (`toPosixRel` below) — never gated on `process.platform`.
const EXECUTOR_FILE = 'src/state-transition.cts';

// The write-seam composition owner (Axis 5). Forward-slash literal, same
// POSIX-normalization rule as `EXECUTOR_FILE` above.
const SEAM_OWNER_FILE = 'src/state.cts';

// Per Decision 4(d)'s "owner FILE is not exempt, only its named canonical
// FUNCTIONS are": a `syncStateFrontmatter(`/`applyPostSyncPreservation(` call
// inside one of these two functions, in `SEAM_OWNER_FILE` only, is the
// seam's own internal plumbing, not a bypass. `writeStateMd` is the
// `cmdStateSync`/`REGENERATE_STATE` path's own I/O wrapper calling
// `syncStateFrontmatter` directly (no preservation, by design — §8.3's
// closed exception list; ADR-3473 §8.6 gates ITS third parameter, which is
// an orthogonal, type-level check — this guard's exemption is about which
// FUNCTION BODY a raw call to the two seam stages is allowed to live in).
// `syncAndPreserveStateMd` is the ONE write-seam composition — every OTHER
// caller needing a non-standard I/O envelope routes through it. Every OTHER
// function in `state.cts` — and every function in every OTHER file — is
// still scanned and still flagged; in particular `readModifyWriteStateMd` is
// NOT exempt: it calls `syncAndPreserveStateMd` like everyone else, so if a
// direct `syncStateFrontmatter(`/`applyPostSyncPreservation(` call
// reappeared there it would be exactly the re-assembly shape this axis
// exists to catch.
const SEAM_OWNER_EXEMPT_FUNCTIONS = ['writeStateMd', 'syncAndPreserveStateMd'];

// Unconditional path-separator normalization (never gated on
// `process.platform` — a Windows-authored fork PR must be judged by the
// same POSIX-relative rule as everything else this guard reads).
function toPosixRel(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from `text`,
 * returning one entry PER INPUT LINE so line numbers computed against the
 * result stay correct against the original file. Block comments are tracked
 * across lines (`inBlock`); line comments only ever affect their own line.
 *
 * Deliberately does NOT parse string/template literal contents — a `//` or
 * `/*` embedded inside a quoted string is treated exactly like real source,
 * which can occasionally UNDER-strip (leaving a would-be-comment's text
 * live) but never OVER-strips real code into invisibility. Per this guard's
 * header and `lint-state-field-drift.cjs`'s own precedent: over-reporting a
 * documentation paragraph that merely DESCRIBES a call (ADR-3180 Amendment
 * 3's exact false positive) is the failure this exists to prevent; a rare
 * miss on an adversarial one-line string is an accepted, narrower risk in
 * the opposite (safe) direction — under-reporting, never over-reporting.
 */
function stripComments(text) {
  const lines = text.split('\n');
  const out = new Array(lines.length);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let result = '';
    let j = 0;
    while (j < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', j);
        if (close === -1) {
          j = line.length;
          break;
        }
        j = close + 2;
        inBlock = false;
        continue;
      }
      if (line[j] === '/' && line[j + 1] === '/') {
        j = line.length; // rest of line is a line comment
        break;
      }
      if (line[j] === '/' && line[j + 1] === '*') {
        inBlock = true;
        j += 2;
        continue;
      }
      result += line[j];
      j++;
    }
    out[i] = result;
  }
  return out;
}

// A named function declaration, tolerating `export`/`async` prefixes — the
// SAME shape `nearestPrecedingAssignment` uses as its backward-scan boundary,
// and `enclosingFunction` below uses to recognise (and skip) the seam
// functions' own definitions.
const FUNCTION_DECL_LINE_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

/**
 * Nearest preceding named-function declaration, scanning `lines` BACKWARD
 * from `index`. Scopes an exemption to a FUNCTION, never a FILE — a whole-
 * file owner exemption is precisely how `getMilestoneInfo` stayed invisible
 * to an earlier drift guard (ADR-3180 Decision 4(d)'s own cautionary case,
 * cross-referenced by this guard's header).
 */
function enclosingFunction(lines, index) {
  for (let i = index; i >= 0; i--) {
    const m = FUNCTION_DECL_LINE_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

// One member of the `FieldPreservation` union, e.g. `'preserve-always'` —
// lowercase-with-dashes, single-quoted.
const POLICY_UNION_START_RE = /export\s+type\s+FieldPreservation\s*=/;
const POLICY_UNION_MEMBER_RE = /'([a-z][a-z-]*)'/g;

/**
 * Parse the members of `export type FieldPreservation = 'a' | 'b' | ...;`
 * straight out of the executor's own source, so this guard cannot drift
 * from the type it polices (a hardcoded copy of the union would be exactly
 * the "declared here, enforced somewhere else" shape ADR-3408 exists to
 * remove — this time inside the GUARD). In `src/state-transition.cts` the
 * union is declared across several lines, each shaped like
 * `  | 'clear'; // remove the field entirely`. Scans from the declaration
 * line forward, collecting every quoted token on each line, and stops at
 * the first line whose (comment-INCLUDING) text still carries a `;` — the
 * statement terminator ends the union regardless of any trailing comment.
 */
function readPolicyUnion(text) {
  const lines = text.split('\n');
  const members = [];
  let inUnion = false;
  for (const line of lines) {
    if (!inUnion) {
      if (!POLICY_UNION_START_RE.test(line)) continue;
      inUnion = true;
    }
    POLICY_UNION_MEMBER_RE.lastIndex = 0;
    let m;
    while ((m = POLICY_UNION_MEMBER_RE.exec(line)) !== null) {
      members.push(m[1]);
    }
    if (line.includes(';')) break;
  }
  return members;
}

// `getFieldClassification(` called with a quoted string-literal argument —
// the field-name-keyed dispatch shape. `getFieldClassification(variable)`
// (a bare identifier, no quote) never matches this pattern, by construction
// (the quote-character backreference requires an opening quote immediately
// inside the parens) — the correct, table-driven shape is silent here.
const FIELD_NAME_DISPATCH_RE = /getFieldClassification\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;

// `field === '<literal>'` / `field !== '<literal>'`, and the reversed
// `'<literal>' === field` — the field-name-keyed BRANCH shape (as opposed to
// `FIELD_NAME_DISPATCH_RE`'s field-name-keyed CALL shape above; both report
// the same `REASON.FIELD_NAME_DISPATCH`, since both are "a branch selected
// by field name", ADR-3408 §8.1's exact prohibition). This is the shape a
// bypass takes when it routes AROUND `getFieldClassification` entirely
// rather than through it — ADR-3408 Decision 5's "route the bypass through
// a wrapper or a differently-named local" gaming route.
//
// Deliberately scoped to ONLY an identifier literally named `field` — the
// dispatch loop's own loop variable declared at
// `for (const field of Object.keys(FIELD_CLASSIFICATION))` a few dozen lines
// below in this same file. This is a DECLARED, narrow limitation, not a
// silent one: a rename of the loop variable would evade this detector
// entirely, and an unrelated local elsewhere in this file that happens to
// also be named `field` would false-positive. Both risks are accepted
// in trade for avoiding a name-agnostic match, which would flag every
// unrelated `===`/`!==` string comparison in the file (there are many —
// e.g. `derivedName !== MILESTONE_PLACEHOLDER`-shaped guards) and bury the
// real signal in noise; per this guard's own header, over-reporting a
// comment is an accepted risk but over-reporting live code this broadly is
// not.
//
// The reversed `!==` form (`'<literal>' !== field`) is deliberately NOT
// matched — not observed anywhere in this codebase, and left out rather
// than speculatively widened past what was found in practice.
const FIELD_VAR_EQ_LITERAL_RE = /\bfield\s*(?:===|!==)\s*(['"`])([^'"`]+)\1/g;
const LITERAL_EQ_FIELD_VAR_RE = /(['"`])([^'"`]+)\1\s*===\s*\bfield\b/g;

/**
 * AXIS 1a: every `getFieldClassification('<literal>')` CALL, and every
 * `field === '<literal>'` / `field !== '<literal>'` / `'<literal>' ===
 * field` BRANCH, inside the executor is a field-name-keyed branch (§8.1).
 * Only ever called against `EXECUTOR_FILE` — `collect()` gates the call
 * site, mirroring `findPolicyDispatchDrift`'s own "only when rel ===
 * EXECUTOR_FILE" rule from the spec this guard was authored against.
 * `preservation === '<member>'` comparisons — the CORRECT policy-dispatch
 * shape `findUnimplementedPolicies` requires to exist — are unaffected: the
 * identifier compared there is `preservation`, never `field`, so
 * `FIELD_VAR_EQ_LITERAL_RE`'s `\bfield\b` anchor does not reach them.
 */
function findPolicyDispatchDrift(rel, text) {
  const out = [];
  const stripped = stripComments(text);
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    // `file` is sanitized here, at construction, not just at the human
    // formatter: `rel` is exactly as attacker-controlled as `source` on a
    // fork PR (a tracked filename can legally carry C1 bytes or bidi
    // overrides), and it reaches `--json` stdout unfiltered otherwise — see
    // `sanitizeForReport`'s own header.
    FIELD_NAME_DISPATCH_RE.lastIndex = 0;
    let m;
    while ((m = FIELD_NAME_DISPATCH_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        // `field` is captured straight out of a quoted string literal in
        // repo source — attacker-controlled on the same fork-PR basis as
        // `file`/`source`, so sanitize it too rather than let it reach
        // `--json` stdout.
        field: sanitizeForReport(m[2]),
        source: sanitizeForReport(line.trim()),
      });
    }
    FIELD_VAR_EQ_LITERAL_RE.lastIndex = 0;
    while ((m = FIELD_VAR_EQ_LITERAL_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(m[2]),
        source: sanitizeForReport(line.trim()),
      });
    }
    LITERAL_EQ_FIELD_VAR_RE.lastIndex = 0;
    while ((m = LITERAL_EQ_FIELD_VAR_RE.exec(line)) !== null) {
      out.push({
        reason: REASON.FIELD_NAME_DISPATCH,
        axis: 'policy-dispatch',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(m[2]),
        source: sanitizeForReport(line.trim()),
      });
    }
  }
  return out;
}

/**
 * AXIS 1b: every `FieldPreservation` member (read from `text` via
 * `readPolicyUnion`, so the check cannot itself drift from the union) that
 * has no `preservation === '<member>'` comparison anywhere in the
 * comment-stripped executor source is a declared policy with no executor —
 * §8.1's mirror defect, one level up (a whole MEMBER unimplemented, not just
 * one dispatch call keyed on a field name). `derive` and `clear` are the
 * live instances ADR-3408 §8.6 names.
 */
function findUnimplementedPolicies(text, rel) {
  const members = readPolicyUnion(text);
  const strippedText = stripComments(text).join('\n');
  const out = [];
  for (const member of members) {
    const memberRe = new RegExp(`preservation\\s*===\\s*'${escapeRegex(member)}'`);
    if (memberRe.test(strippedText)) continue;
    // `file` and `policy` are sanitized here for the same reason as
    // `findPolicyDispatchDrift` above: both `rel` and a `FieldPreservation`
    // union member are attacker-controlled on a fork PR, exactly like
    // `source`.
    out.push({
      reason: REASON.UNIMPLEMENTED_POLICY,
      axis: 'policy-dispatch',
      file: sanitizeForReport(rel),
      line: 0,
      policy: sanitizeForReport(member),
      source: sanitizeForReport(`FieldPreservation member '${member}' has no executor`),
    });
  }
  return out;
}

// AXIS 3 (§8.3(b), closed Phase 2 / #3469): `stateReplaceField(<contentArg>,
// <fieldArg>, ...)` on a single line, capturing both argument expressions.
// `contentArg` must be a bare identifier (a call expression or property
// access as the first argument is not matched — silently out of scope, per
// this axis's own narrow-limitation note below) so its assignments can be
// tracked; `fieldArg` is everything up to the next comma, trimmed, so its
// literal-vs-variable shape can be read off directly.
const STATE_REPLACE_FIELD_CALL_RE = /\bstateReplaceField\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^,()]+),/g;

// True when `arg` (already trimmed) is a fixed string/template literal —
// the safe shape, since every literal field name this codebase actually
// uses is a Title-Case body label that cannot collide with a lowercase/
// snake_case YAML frontmatter key.
function isQuotedLiteralArg(arg) {
  const t = arg.trim();
  return t.startsWith("'") || t.startsWith('"') || t.startsWith('`');
}

/**
 * The nearest assignment to `varName` (`varName = <expr>` or
 * `const|let|var varName = <expr>`), scanning `lines` BACKWARD from `index`
 * (inclusive) and stopping at the nearest preceding named-function
 * declaration. Returns the assigned expression's trimmed text, or `null`
 * when no such assignment is found before the boundary — meaning `varName`
 * is the enclosing function's own untouched parameter.
 *
 * Deliberately single-hop: this reports whatever the NEAREST assignment's
 * right-hand side literally is, and does not itself follow a further alias
 * (`let body = someOtherVar;` is reported as `"someOtherVar"`, not resolved
 * further). Every real call site in this file assigns its body variable
 * directly from `stripFrontmatter(content)` with no intermediate alias
 * (`updateCore`, `patchCore`, `beginPhaseCore`'s `tryField` helper) — a
 * future call site that introduces one extra hop of aliasing would evade
 * this check. A declared, narrow limitation, not a silent one — mirrors
 * this file's existing precedent (`FIELD_VAR_EQ_LITERAL_RE`'s own
 * documented scope) of accepting a bounded risk in trade for not chasing
 * full dataflow, which is exactly what made the Phase 1 approximation
 * unusable (29 false positives to 1 true positive).
 *
 * Axis 2 (#5104, `resolvesToStatePath`) passes `options`; Axis 3 passes none,
 * so its reading is exactly the one above:
 *   - `typed`: a `const`/`let`/`var` declaration may carry a TypeScript
 *     annotation between its name and `=` (`const p: string = …`), because
 *     the scanned sources are TypeScript. The annotation is read only after a
 *     declaration keyword and holds no `=` or `;`, so `{ p: x }`, `p == x` and
 *     `let p: T; q = x` are not assignments to `p`.
 *   - `stopAtPatternBinding`: a line that binds `varName` through a
 *     `for...of` header or a destructuring declaration (`bindsByPattern`)
 *     ends the scan with `null`. Neither has a `varName =` to match, so
 *     without this the scan walks past the binding to a same-named variable
 *     in a sibling block.
 *   - `withLine`: return `{ rhs, line }` instead of the bare text, so a
 *     caller can resume its scan above the assignment it followed.
 *   - `firstLine`: read this text in place of `lines[index]`. Axis 2 passes
 *     the write's own line cut at the call.
 *   - `cache`: a `{ byName, readers, linesRead, assignmentMatches, work,
 *     maxWork, exhausted, stringScanChars }` object shared by
 *     every call over the same `lines` with the same options. Each line is
 *     then read at most once per name: a scan stops at the first line whose
 *     result is cached, and records its result for every line it read.
 *     `firstLine` is never cached.
 *     `linesRead` counts the lines read, `assignmentMatches` the assignment
 *     heads `assignedValue` decided on them, and `stringScanChars` the
 *     characters `stripQuotedStrings` examined in the expressions read.
 *     `readers` keeps each name's `nameReader`, built once and charged
 *     `READER_WORK` plus `READER_WORK_PER_CHAR` per character; a line is
 *     then searched for the name and its regexes are tried only where it
 *     occurs. A name longer than `MAX_RESOLVED_NAME_LENGTH` is charged as
 *     the whole budget.
 *     `work` is the budget spent (`chargeWork`): each call charges
 *     `LOOKUP_WORK` plus the name's length, and each line read its
 *     `lineReadWork`. When a charge would pass `maxWork`, the scan stops
 *     before the read, sets `exhausted` and returns `null` without caching
 *     anything; every later call with the cache returns `null` at once. The
 *     caller must then treat `null` as unknown, not as "no assignment".
 */
function nearestPrecedingAssignment(lines, index, varName, options = {}) {
  const cache = options.cache;
  if (cache && !chargeWork(cache, LOOKUP_WORK + varName.length)) return null;
  let reader = null;
  let known = null;
  if (cache) {
    // A name longer than the cap is charged as the whole budget (fail closed).
    if (varName.length > MAX_RESOLVED_NAME_LENGTH) {
      chargeWork(cache, Infinity);
      return null;
    }
    reader = cache.readers.get(varName);
    if (!reader) {
      if (!chargeWork(cache, READER_WORK + READER_WORK_PER_CHAR * varName.length)) return null;
      cache.readers.set(varName, (reader = nameReader(varName, options.typed)));
    }
    known = cache.byName.get(varName);
    if (!known) cache.byName.set(varName, (known = []));
  }
  const assignRe = reader ? reader.head : assignmentHeadRegex(varName, options.typed);
  const own = options.firstLine !== undefined;
  let result = null;
  let i = index;
  for (; i >= 0; i--) {
    if (known && known[i] !== undefined && !(own && i === index)) {
      result = known[i];
      break;
    }
    const line = own && i === index ? options.firstLine : lines[i];
    let positions;
    if (cache) {
      // Past this many occurrences the read cannot be charged, so stop there.
      positions = nameOccurrences(line, varName, Math.floor((cache.maxWork - cache.work) / varName.length) + 1);
      if (!chargeWork(cache, lineReadWork(line, varName, positions))) return null;
      cache.linesRead++;
    }
    if (FUNCTION_DECL_LINE_RE.test(line)) break;
    // A line without the name cannot bind it.
    if (positions ? positions.length === 0 : !line.includes(varName)) continue;
    if (options.stopAtPatternBinding && bindsByPattern(line, varName, reader, positions)) break;
    const rhs = assignedValue(line, assignRe, cache, positions);
    if (rhs !== null) {
      result = options.withLine ? { rhs: rhs.trim(), line: i } : rhs.trim();
      break;
    }
  }
  if (known) for (let j = Math.max(i, 0); j <= (own ? index - 1 : index); j++) known[j] = result;
  return result;
}

/**
 * How `nearestPrecedingAssignment` reads an assignment on a line. The reading
 * is the regex `(?:^|[^.\w$])T\s*=\s*([^=].*)$`, where `T` is
 * `(?:const|let|var)?\s*NAME` or, when `typed`, also
 * `(?:const|let|var)\s+NAME\s*:[^=;]+?`, and the result is its capture.
 * Matched in that form it backtracks: every position in a long run of
 * whitespace can start a match and rescan the rest of the run, and when a
 * line terminator `.` does not match (`\r`, U+2028, U+2029) follows a run
 * after `=`, each shorter run is tried and rescanned up to it. One line then
 * costs time quadratic in the run. So the regex is split, with the same
 * result:
 *   - `assignmentHeadRegex` matches up to the `=` and its whole whitespace run.
 *     Each match starts at the name and a lookbehind reads the text before
 *     it (`[^=;]+?\s*=` is written `[^=;]+=`, the same language, because
 *     `[^=;]` already holds whitespace).
 *   - `assignedValue` then decides the old tail `\s*([^=].*)$` from that one
 *     position: the old match could only start its capture at the end of the
 *     run, or one character before it when that end is `=` or the end of the
 *     line, and `.*$` holds only when no line terminator follows. Each head
 *     match costs time linear in what it reads, and a failed one resumes one
 *     character on.
 */
function assignmentHeadRegex(varName, typed, flags = 'g') {
  const name = escapeRegex(varName);
  const lead = '(?:^|[^.\\w$])';
  const typedForm = typed ? `(?<=${lead}(?:const|let|var)\\s+${name})\\s*:[^=;]+=|` : '';
  return new RegExp(`${name}(?:${typedForm}(?<=${lead}(?:const|let|var)?\\s*${name})\\s*=)(?=(\\s*))\\1`, flags);
}

// The right-hand side `assignmentHeadRegex` (`re`) reads on `line`, untrimmed,
// or `null`. See there. `counter.assignmentMatches`, when given, counts the
// head matches decided.
//
// `positions`, when given, are the offsets where the name occurs on `line`
// (`nameOccurrences`) and `re` is the sticky form of the regex. A head match
// can only start where the name occurs, since the regex starts with it, so
// trying each of those offsets in order finds the same matches as the global
// scan, without trying every other offset. On a line where the name nearly
// matches at every offset, the global scan costs line length x name length
// even when the name occurs once.
function assignedValue(line, re, counter, positions) {
  // The last character `.` does not match, or -1.
  const terminator = Math.max(...['\n', '\r', '\u2028', '\u2029'].map((c) => line.lastIndexOf(c)));
  const decide = (m) => {
    if (counter) counter.assignmentMatches++;
    const end = m.index + m[0].length; // the end of the run after `=`
    if (end < line.length && line[end] !== '=' && end >= terminator) return line.slice(end);
    if (m[1].length > 0 && end - 1 >= terminator) return line.slice(end - 1);
    return null;
  };
  if (positions !== undefined) {
    for (const p of positions) {
      re.lastIndex = p;
      const m = re.exec(line);
      if (m === null) continue;
      const rhs = decide(m);
      if (rhs !== null) return rhs;
    }
    return null;
  }
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    const rhs = decide(m);
    if (rhs !== null) return rhs;
    re.lastIndex = m.index + 1;
  }
  return null;
}

// The work `nearestPrecedingAssignment` is charged for reading `line` for
// `varName` under a cache budget (#5104), given the name's `occurrences` on
// it. A line without the name costs its length plus `LINE_READ_WORK` (the
// search, and the fixed cost of a read). On a line with it the regexes
// are tried at each occurrence, each try reading the name again, so it costs
// its length plus `LINE_READ_WORK` plus occurrences x name length. Each of
// those regexes can also start a scan to the end of the line at a `:` (a typed
// head), a `(` (a `for` header) or a `[` or `{` (a destructuring pattern),
// so that sum is multiplied by one more than the count of those characters.
// That bounds the steps the reads take, up to a constant factor, however the
// line repeats a declaration, a header or the name.
function lineReadWork(line, varName, occurrences = nameOccurrences(line, varName)) {
  if (occurrences.length === 0) return line.length + LINE_READ_WORK;
  let starts = 1;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === ':' || c === '(' || c === '[' || c === '{') starts++;
  }
  return (line.length + LINE_READ_WORK + occurrences.length * varName.length) * starts;
}

// What `nearestPrecedingAssignment` keeps per name under a cache: the sticky
// `assignmentHeadRegex` and pattern-binding regex, each tried only where the
// name occurs. Building one is charged `READER_WORK` plus
// `READER_WORK_PER_CHAR` per character of the name: compiling the regexes
// takes far longer than a lookup, and each is kept for the rest of the file,
// so the charge also bounds the memory they hold.
function nameReader(varName, typed) {
  return {
    head: assignmentHeadRegex(varName, typed, 'y'),
    binds: patternBindingRegex(varName, 'y'),
  };
}

// Every offset where `name` occurs on `line`, overlapping ones included, or
// the first `limit` of them. Each search can take time up to the name's
// length per character of the line it passes, which
// `MAX_RESOLVED_NAME_LENGTH` bounds.
function nameOccurrences(line, name, limit = Infinity) {
  const out = [];
  for (let p = line.indexOf(name); p !== -1 && out.length < limit; p = line.indexOf(name, p + 1)) out.push(p);
  return out;
}

// The fixed part of the work charged for one line read, and for one
// `nearestPrecedingAssignment` call (plus the length of the name, which its
// keys and regex hold), under a cache budget, in the units of one character
// read (see `MAX_RAW_WRITE_RESOLVER_WORK`). Without them, reads of blank
// lines and lookups that end in the cache cost far more time than they are
// charged.
const LINE_READ_WORK = 32;
const LOOKUP_WORK = 64;
// The work charged for building a name's `nameReader`, fixed and per
// character of the name. Measured: about 70 us and 7 KB for a 4-character
// name, 350 us and 30 KB for a 256-character one.
const READER_WORK = 10000;
const READER_WORK_PER_CHAR = 128;

// The longest name Axis 2 resolves (#5104). A longer one is charged as the
// whole budget, so its write and every later write in the file are reported
// unresolved. It bounds the cost of a name search and the size of a
// `nameReader`. Over the 1728 tracked script and source files the longest
// name the resolver looks up is 32 characters (27 in `src/`), and the
// longest identifier in `src/` is 52.
const MAX_RESOLVED_NAME_LENGTH = 256;

// A `for (const|let|var <pattern> of …)` loop header, or a `const|let|var`
// destructuring declaration: each binds a name WITHOUT a `name =` that
// `nearestPrecedingAssignment` can see.
//
// The loop header's pattern was read as `\s+(.+?)\s+of\b`. On a long run of
// whitespace every position of that run tried `\s+of` to its end, and a failed
// match also backtracked the `\s+` after the keyword, so one line cost time
// quadratic in the run. `(.*?\S)` can only end before a run, and the
// lookahead-and-backreference takes the keyword's whitespace whole (JavaScript
// has no possessive quantifier), so the read is linear in the line. The verdict
// is unchanged: the pattern read is the same whenever a header matches, and a
// match the old form found only by backtracking read whitespace alone, which
// binds no name.
const LOOP_BINDING_RE = /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)(?=(\s+))\1(?<pattern>.*?\S)\s+of\b/d;
const DESTRUCTURING_BINDING_RE = /\b(?:const|let|var)\s+(?<pattern>[[{].*?[\]}])\s*=/d;

/**
 * True when `line` binds `name` through a `for...of` loop header or a
 * destructuring pattern. A `{ key: alias }` entry binds `alias`, not `key`.
 */
function bindsByPattern(line, name, reader, positions) {
  return [LOOP_BINDING_RE, DESTRUCTURING_BINDING_RE].some((re) => {
    const m = re.exec(line);
    if (m === null) return false;
    const pattern = m.groups.pattern;
    if (!reader) return patternBindingRegex(name).test(pattern);
    // Under a cache: try the sticky regex only where the name occurs inside
    // the pattern (see `assignedValue`), on the pattern's own text.
    const [start, end] = m.indices.groups.pattern;
    return positions.some((p) => {
      if (p < start || p + name.length > end) return false;
      reader.binds.lastIndex = p - start;
      return reader.binds.test(pattern);
    });
  });
}

// `name` as a binding in a destructuring or loop pattern: not a property
// (`.name`), not part of a longer name, and not a `{ name: alias }` key.
function patternBindingRegex(name, flags = '') {
  return new RegExp(`(?<![\\w$.])${escapeRegex(name)}(?![\\w$])(?!\\s*:)`, flags);
}

/**
 * AXIS 3: every `stateReplaceField(` call in `EXECUTOR_FILE` whose field-name
 * argument is a VARIABLE (not a quoted literal) — the only shape that can
 * ever rewrite YAML frontmatter, since `stateReplaceField`'s `^field:` line
 * pattern is case-insensitive and matches any line starting with that name,
 * literal or not — AND whose content argument was not assigned from
 * `stripFrontmatter(` at the nearest preceding assignment. A literal
 * field-name argument is never flagged regardless of stripping: every fixed
 * string this file's `stateReplaceField` calls use is a Title-Case body
 * label (`'Phase'`, `'Total Plans in Phase'`, ...) that cannot collide with
 * a lowercase/snake_case frontmatter key by construction, so checking its
 * content argument would only add false positives on the ~20 already-safe
 * `sectionBody`-scoped calls this axis must NOT report (mirrors
 * `updateCore`'s strip-then-replace shape, and `beginPhaseCore`'s
 * `stateReplaceField(body, name, value)`, both legitimately unflagged).
 */
function findUnstrippedContentWrites(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    STATE_REPLACE_FIELD_CALL_RE.lastIndex = 0;
    let m;
    while ((m = STATE_REPLACE_FIELD_CALL_RE.exec(line)) !== null) {
      const contentArg = m[1];
      const fieldArg = m[2];
      if (isQuotedLiteralArg(fieldArg)) continue;
      const assignment = nearestPrecedingAssignment(stripped, i - 1, contentArg);
      const isStripped = assignment !== null && /^stripFrontmatter\s*\(/.test(assignment);
      if (isStripped) continue;
      // `file`/`source` sanitized for the same fork-PR reason as every other
      // finding in this guard; `contentArg` is captured out of repo source
      // (an identifier name), attacker-controlled on the same basis.
      out.push({
        reason: REASON.UNSTRIPPED_CONTENT_WRITE,
        axis: 'frontmatter-write',
        file: sanitizeForReport(rel),
        line: i + 1,
        field: sanitizeForReport(contentArg),
        source: sanitizeForReport(rawLines[i].trim()),
      });
    }
  }
  return out;
}

// AXIS 2 (§8.6, retained): `fs.writeFileSync(<targetArg>, ...)`, capturing
// the target-path argument up to the next comma. The type system (ADR-3473
// §8.6's `StateTransaction` constructors) closes the `writeStateMd`/
// `syncStateFrontmatter`/`applyPostSyncPreservation` bypass shape this guard
// used to scan for by function name; it cannot close a call site that skips
// those functions ENTIRELY and reaches for Node's raw `fs` module directly —
// that residual risk is what this axis stays alive to catch.
const RAW_WRITE_CALL_START_RE = /\bfs\.writeFileSync\s*\(/g;

/**
 * Capture `fs.writeFileSync`'s first-argument text starting at `startIdx`
 * (the offset right after its opening `(`), stopping at the first TOP-LEVEL
 * comma or the call's own closing paren — bracket/paren/brace depth and
 * string-literal spans are tracked so a nested call in the target expression
 * (e.g. `path.join(cwd, 'STATE.md')`) does not stop the scan at ITS internal
 * comma. A naive `[^,]+` capture (the guard's prior encoding) stopped at
 * `path.join(cwd` for exactly that shape, silently missing every
 * `fs.writeFileSync(path.join(cwd, 'STATE.md'), …)` call in the wild
 * (found via `tests/state-write-path-drift-guard.test.cjs` F1: "guard:
 * fs.writeFileSync against a STATE.md literal is reported").
 *
 * `line` may span several lines: `findRawStateWrites` passes the whole
 * comment-stripped file, so a call wrapped after its `(` is captured too
 * (#5104).
 *
 * `limit`, optional, bounds the scan: it reads and returns at most
 * `limit + 1` characters (a backslash's escaped character is skipped, not
 * returned), so a result longer than `limit` means the argument is longer
 * than `limit` (a call left open takes the rest of the text). The caller
 * decides what that means.
 */
function captureFirstArg(line, startIdx, limit = Infinity) {
  let depth = 0;
  let inStr = null;
  let i = startIdx;
  for (; i < line.length && i - startIdx <= limit; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // the call's own closing paren — no comma found
      depth--;
      continue;
    }
    if (c === ',' && depth === 0) break;
  }
  return line.slice(startIdx, Math.min(i, startIdx + limit + 1));
}

// True when the captured target-path expression plausibly names the STATE.md
// path: either the canonical `statePath` identifier this codebase uses at
// every real write site (see `src/state.cts`'s `writeStateMd`,
// `readModifyWriteStateMd`, `cmdStateMilestoneSwitch`), or a literal/template
// segment containing `STATE.md` outright.
function targetsStatePath(arg) {
  return /\bstatePath\b/.test(arg) || /STATE\.md/.test(arg);
}

// How many assignments Axis 2 follows back from a raw write's target before
// giving up (#5104). Each hop resumes above the assignment it followed, so the
// scan always terminates; the bound keeps it a string match, not dataflow.
// Termination alone does not bound the work: every hop branches over each
// identifier of a right-hand side, so `resolvesToStatePath` memoizes each
// name's verdict (see there).
const MAX_TARGET_RESOLUTION_HOPS = 4;

// The most characters Axis 2 reads of one write's own text before it gives up
// on resolving that write (#5104): its first argument, and its line before
// the call. Past either, the write is reported unresolved
// (`RAW_STATE_WRITE_UNRESOLVED`), never passed. Without it a call left open
// took the rest of the file as its target, once per call, and each of many
// writes on one line re-read the line before it. Over the 1728 tracked
// script and source files, the longest first argument of a write and the
// longest line before a call are each 129 characters (35 and 103 in
// `src/`), so this is over 30 times either.
const MAX_RAW_WRITE_TEXT_LENGTH = 4096;

// The most work Axis 2 spends resolving the writes of one file (#5104): the
// characters of each write's argument and of its line before the call, each
// `nearestPrecedingAssignment` call (`LOOKUP_WORK` plus the name), each
// name's reader built (`READER_WORK` plus `READER_WORK_PER_CHAR` per
// character), each line it reads (`lineReadWork`), and each assignment's
// right-hand side read (`assignmentVerdict`). A name longer than
// `MAX_RESOLVED_NAME_LENGTH` is charged as the whole budget. Once spent,
// nothing more is read: the write that ran out, unless already found to name
// the state path, is reported unresolved (`RAW_STATE_WRITE_UNRESOLVED`), never
// passed; so is every later write in the file, even one whose argument names
// `statePath` itself, since its argument is no longer read. Over the 1728
// tracked script and source files the most any file takes is 9315920
// (`tests/state.test.cjs`, 1 MB); in `src/` it is 308033
// (`src/commands.cts`). So this is over 25 times the first and over 800
// times the second.
const MAX_RAW_WRITE_RESOLVER_WORK = 250000000;

// How Axis 2 reads an assignment through `nearestPrecedingAssignment` (#5104).
const RAW_WRITE_ASSIGNMENT_OPTIONS = Object.freeze({ typed: true, stopAtPatternBinding: true, withLine: true });

/**
 * The identifiers an expression reads. Quoted `'…'` / `"…"` string contents
 * are dropped, and a name after a single `.` is a property, not a variable
 * (a spread, `...parts`, is still a variable). A template literal is kept
 * whole, so the names in its `${…}` interpolations are read, and so is any
 * word in its text: that can only add a lookup, never drop one.
 */
function identifiersIn(expr, counter) {
  const code = stripQuotedStrings(expr, counter);
  return [...new Set(code.match(/(?<![\w$])(?<!(?:^|[^.])\.)[A-Za-z_$][\w$]*/g) || [])];
}

// A line terminator: `.` in a regex does not match it.
const isLineTerminator = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

/**
 * `expr` with each quoted `'...'` or `"..."` literal replaced by `''`: the same
 * result as `expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")`, in
 * time linear in `expr` (#5104). That regex, from every quote with no closer,
 * scans to the end of the text and fails, then tries the next quote, so a
 * run of escaped quotes costs time quadratic in its length. Here a quote
 * with no closer records where its failed scan stopped, and quotes of the
 * same kind before that point are not tried: the failed scan passed each of
 * them as the escaped half of `\\.`, so a scan from one would stop at the
 * same point. A backslash before a line terminator (which `.` does not
 * match) also stops a scan. Backticks are kept as text, as before.
 *
 * `counter.stringScanChars`, when given, counts the characters examined.
 */
function stripQuotedStrings(expr, counter) {
  const failedBefore = { "'": -1, '"': -1 };
  let examined = 0;
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    examined++;
    if ((c === "'" || c === '"') && i >= failedBefore[c]) {
      let j = i + 1;
      let closed = false;
      while (j < expr.length) {
        examined++;
        const d = expr[j];
        if (d === c) {
          closed = true;
          break;
        }
        if (d === '\\') {
          if (j + 1 < expr.length && !isLineTerminator(expr[j + 1])) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (closed) {
        out += "''";
        i = j + 1;
        continue;
      }
      failedBefore[c] = j;
    }
    out += c;
    i++;
  }
  if (counter) counter.stringScanChars += examined;
  return out;
}

// A body opener, closer or arrow between an assignment and the write: the
// assignment may sit in a closed sibling block or arrow body, out of scope at
// the write (#5104). Textual, not a brace-depth tracker.
const BODY_BOUNDARY_RE = /[{}]|=>/;

/**
 * True when `expr`, the target of the raw write `write`, names the state path
 * (`targetsStatePath`), or when one of its identifiers resolves to an
 * expression that does, following at most `hopsLeft` same-function
 * assignments through `nearestPrecedingAssignment` (#5104).
 *
 * `write` is made by `findRawStateWrites`, one per write, and never kept in
 * module state:
 *   - `lines` is the comment-stripped file and `line` the write's line.
 *     `ownLine` is that line cut at the `fs.writeFileSync(` call, so an
 *     assignment earlier on the write's line is read and one after the call
 *     is not (it is empty when the cut holds a named-function header, which
 *     then does not end the scan). `index` is the last line an assignment may
 *     sit on; each hop resumes on the line above the assignment it followed,
 *     so `p = p + '.tmp'` reaches the earlier assignment of `p`.
 *   - `bindings` is the file's assignment cache, one object shared by every
 *     write in the file (`nearestPrecedingAssignment`'s `cache`). A line
 *     above the write's own is the same text for every write, so each line
 *     is read at most once per name in the file; the write's own line is read
 *     per write.
 *   - `boundaryLinesBefore[i]` counts the lines among `lines[0..i-1]` that
 *     hold a body boundary (`BODY_BOUNDARY_RE`), so the boundary rule below
 *     reads no line range per write.
 *   - A name's verdict is memoized on `name`, `index` and `hopsLeft`.
 *     Below the write's line it depends on the write only through whether a
 *     body boundary lies after `index`, up to the call
 *     (`boundaryAfterLine`): the lines it reads are the same for every write,
 *     and each hop's boundary flag follows from that one and the lines
 *     between. So those verdicts are kept in `verdicts`, shared by every
 *     write in the file and keyed on that flag too. A verdict from the
 *     write's own line goes in `memo`, kept for this write only. Neither
 *     changes a verdict. Together they bound the lookups per write to names
 *     x lines x `MAX_TARGET_RESOLUTION_HOPS` x (assignments per name + 1),
 *     and the lookups below the write's line are shared; without them,
 *     right-hand sides that each read many names branch exponentially in the
 *     hop bound. `assignmentLookups` counts the `nearestPrecedingAssignment`
 *     calls. `assignmentVerdict` keeps what one assignment below the write's
 *     line gives in `verdicts` too, under the same flag (keys starting
 *     `=`), so later writes do not read its right-hand side again.
 *   - `ownLineChars` counts the characters of the write's line before the
 *     call read by its lookups (the `stats` seam of `findRawStateWrites`).
 *
 * Unresolved is not flagged: a parameter, a name bound by a `for...of`
 * header or a destructuring declaration, or a chain longer than the bound.
 *
 * Boundary rule: the nearest assignment of a name ends its search only when
 * no `{`, `}` or `=>` (`BODY_BOUNDARY_RE`) lies between that assignment's
 * right-hand side and the write. Past such a boundary the nearest assignment
 * may be a closed sibling block's, so when it does not reach the state path
 * the search goes on to the next earlier assignment of that name. This can
 * only add reports: an assignment that reaches the state path reports at
 * once.
 */
function resolvesToStatePath(write, index, expr, hopsLeft) {
  if (targetsStatePath(expr)) return true;
  if (hopsLeft === 0) return false;
  return identifiersIn(expr, write.bindings).some((name) => nameResolvesToStatePath(write, index, name, hopsLeft));
}

// One identifier's part of `resolvesToStatePath`: its assignments, nearest
// first, memoized in `write.memo`.
function nameResolvesToStatePath(write, index, name, hopsLeft) {
  const below = index < write.line;
  const memo = below ? write.verdicts : write.memo;
  const key = below ? `${name}\0${index}\0${hopsLeft}\0${boundaryAfterLine(write, index)}` : `${name}\0${index}\0${hopsLeft}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  let verdict = false;
  for (let from = index; from >= 0; ) {
    write.assignmentLookups++;
    if (from === write.line) write.ownLineChars += write.ownLine.length;
    const found = nearestPrecedingAssignment(write.lines, from, name, {
      ...RAW_WRITE_ASSIGNMENT_OPTIONS,
      cache: write.bindings,
      firstLine: from === write.line ? write.ownLine : undefined,
    });
    if (found === null) break;
    const assigned = assignmentVerdict(write, name, found, hopsLeft);
    if (assigned.hit) {
      verdict = true;
      break;
    }
    if (!assigned.rhsHasBoundary && !(found.line < write.line && boundaryAfterLine(write, found.line))) break;
    from = found.line - 1;
  }
  memo.set(key, verdict);
  return verdict;
}

// What the assignment `found` of `name` gives `nameResolvesToStatePath`:
// `hit`, whether its right-hand side resolves to the state path in
// `hopsLeft - 1` more hops, and `rhsHasBoundary`, whether that right-hand
// side holds a body boundary (the rest of the boundary rule is
// `boundaryAfterLine`). Reading the right-hand side is charged to the file's
// budget. Below the write's line the result depends on the write only through
// the boundary flag after `found.line - 1`, as for `write.verdicts`, so it is
// kept there under that flag and every later write reuses it instead of
// reading the right-hand side again. When the budget is spent the result is
// `{ hit: false, rhsHasBoundary: false }` and the write is reported
// unresolved.
function assignmentVerdict(write, name, found, hopsLeft) {
  const key = found.line < write.line ? `=\0${name}\0${found.line}\0${hopsLeft}\0${boundaryAfterLine(write, found.line - 1)}` : null;
  if (key !== null) {
    const known = write.verdicts.get(key);
    if (known !== undefined) return known;
  }
  let result = { hit: false, rhsHasBoundary: false };
  if (chargeWork(write.bindings, found.rhs.length + 1)) {
    result = {
      hit: resolvesToStatePath(write, found.line - 1, found.rhs, hopsLeft - 1),
      rhsHasBoundary: BODY_BOUNDARY_RE.test(found.rhs),
    };
  }
  if (key !== null) write.verdicts.set(key, result);
  return result;
}

// Adds `amount` to `budget.work` (a `nearestPrecedingAssignment` cache)
// and returns true, unless the budget is spent or the sum would pass
// `budget.maxWork`: then it sets `budget.exhausted` and returns false.
function chargeWork(budget, amount) {
  if (budget.exhausted) return false;
  const work = budget.work + amount;
  if (work > budget.maxWork) {
    budget.exhausted = true;
    return false;
  }
  budget.work = work;
  return true;
}

// True when a body boundary lies on a line after `index` (below the write's
// line), up to the write's call.
function boundaryAfterLine(write, index) {
  return write.ownLineHasBoundary || write.boundaryLinesBefore[write.line] > write.boundaryLinesBefore[index + 1];
}

/**
 * AXIS 2: every `fs.writeFileSync(` call in `text` whose target argument
 * names the state path is a raw write that bypasses BOTH the write seam
 * (`writeStateMd` / `syncAndPreserveStateMd`) and the OS Shell Projection
 * seam (`platformWriteSync`, `src/shell-command-projection.cts`) — no
 * legitimate call site in this codebase writes STATE.md this way today
 * (every real writer goes through `platformWriteSync`, whose OWN internal
 * `fs.writeFileSync` calls take a generic `filePath`/`tmpPath` argument, not
 * `statePath`, and are therefore never matched by `targetsStatePath` above).
 * Unratcheted, unexempted: any occurrence is a violation.
 *
 * #5104 extended the target check in two ways. The scan runs over the
 * comment-stripped text JOINED across lines, so a call wrapped after its `(`
 * is still captured (before, its first argument came back empty). And a
 * target that is neither `statePath` nor a `STATE.md` literal is resolved
 * through same-function assignments (`resolvesToStatePath`).
 *
 * This axis's zero is not proof that no raw writer exists (ADR-3408
 * Decision 5). Verified misses, each with a test row (a known gap beside its
 * correct verdict, or the hop-bound row); the syntax-tree follow-up is #5279:
 *   - A file name built in another function (a `Map` key, a return value)
 *     or held in a module-level constant: resolution stops at the
 *     named-function boundary.
 *   - A one-line function that assigns and writes: a named-function header
 *     on the write's line drops that line from the scan.
 *   - Two assignments of a chain on one line (`const d = …; const p = d;`):
 *     each hop resumes on the line above.
 *   - A `+=` that adds the STATE.md segment, a value that starts on the line
 *     after `=`, an annotation holding `;`, a CRLF file (`.` does not
 *     match `\r`, so no assignment is read), and a chain longer than
 *     `MAX_TARGET_RESOLUTION_HOPS`.
 *   - A value that starts on the `=` line and continues on later lines
 *     (`const p = path.join(` with `dir,` and `'STATE.md',` below it, or a
 *     name holding `'STATE.md'` there): only the `=` line is read.
 *   - A default parameter (`function w(p = path.join(dir, 'STATE.md'))`):
 *     the named-function header ends the scan before its line is read.
 *   - A STATE.md name not spelled as one literal: split across literals
 *     (`'STATE' + '.md'`, inline or through a variable) or built in a
 *     template (`` `STATE${'.md'}` ``): `targetsStatePath` matches the text,
 *     not its value.
 *   - Any call but the literal text `fs.writeFileSync(` (`fs.promises.
 *     writeFile`, `fs.appendFileSync`, `fs.renameSync(tmp, statePath)`, an
 *     alias or destructured `writeFileSync`), and a call after a `//` inside a
 *     string or regex literal on its line (`stripComments` does not track
 *     them).
 * Verified false positives, pinned the same way: a statePath-derived
 * directory joined with another file name (`path.join(path.dirname(
 * statePath), 'ROADMAP.md')`, inline or through a variable), a same-name
 * parameter of an arrow or one-line nested function shadowing an outer
 * STATE.md variable, a one-line top-level function's parameter resolved
 * into an earlier function (its header is dropped, see above), a parameter
 * of a class method (`save(p, c) {`, `async save(p, c) {`) resolved to a
 * sibling method's STATE.md variable, a parameter of an unnamed
 * `function (p)` expression resolved to a sibling function expression's
 * STATE.md variable or to an outer one it shadows (only a named `function`
 * header ends the scan), an arrow's parameter resolved to a sibling arrow
 * body's variable of the same name, a
 * block-scoped binding or `for` header's `let` earlier on the write's line
 * (`if (a) { const p = statePath; } else { fs.writeFileSync(p, c); }`), a target
 * computed from the state file, a longer name such as `STATE.md.bak`, a
 * word in a template literal's text that names a statePath variable (the
 * template is read whole), a right-hand side that runs past its own `;` into
 * a later statement on that line, and a string that spells the call.
 *
 * Cost: the file's lines are read once per name across every write (the
 * `bindings` cache) and each write's own line once per name it resolves. A
 * long run of whitespace, with or without a line terminator `.` does not
 * match after it, costs a read time linear in the line (`assignedValue`,
 * `LOOP_BINDING_RE`).
 *
 * Cap, fail closed: a write is not resolved when its first argument runs
 * past `MAX_RAW_WRITE_TEXT_LENGTH` characters with no top-level `,` or `)`
 * (a call left open, which would take the rest of the file as its target),
 * or when its line holds more than that many characters before the call (a
 * line of many writes, each of which would re-read the line before it). It
 * is reported as `RAW_STATE_WRITE_UNRESOLVED` instead, at most once per line,
 * so the cap can add reports but never drop one. Each write then reads at
 * most `MAX_RAW_WRITE_TEXT_LENGTH + 1` characters of its argument, and at
 * most `MAX_RAW_WRITE_TEXT_LENGTH` characters of its line before the call,
 * a fixed number of times plus once per name it resolves. A finding's
 * `source` is built once per line.
 *
 * Budget, fail closed: the work of resolving a file's writes is charged
 * against `MAX_RAW_WRITE_RESOLVER_WORK`: each write's argument and line
 * before the call, by length; each `nearestPrecedingAssignment` call; each
 * name's reader, once (its regexes are compiled and kept for the file, so the
 * charge bounds their memory too); each line it reads, by `lineReadWork`, which bounds the steps a read takes even
 * when the line repeats a declaration or `for` header of the name; and each
 * right-hand side read, which `assignmentVerdict` keeps for later writes so
 * a wide one is not read once per write. A name longer than
 * `MAX_RESOLVED_NAME_LENGTH` is charged as the whole budget. A charge that would
 * pass the budget is not made and its read not done. The write that ran out,
 * unless already found to name the state path, is reported as
 * `RAW_STATE_WRITE_UNRESOLVED`; so is every later write in the file, even one
 * whose argument names `statePath` itself, since once the budget is spent no
 * argument is read. At most one unresolved report per line, so the budget
 * too can add reports but never drop one. Without it, many writes that
 * each name a different variable read back to the enclosing named function
 * once per name (distinct names x lines), a line that repeats a declaration
 * scanned to its end once per repeat (quadratic in the line), each write
 * re-read a shared right-hand side, and each write walked every earlier
 * assignment of its name past a body boundary.
 * With both caps, a file costs time linear in its length (finding the calls,
 * counting lines) plus work bounded by the budget.
 *
 * `stats`, optional, receives eight counts over every write in `text`:
 * `assignmentLookups`, the `nearestPrecedingAssignment` calls, `linesRead`,
 * the lines those calls read, `assignmentMatches`, the assignment heads
 * decided on those lines (each in constant time once matched),
 * `argumentChars`, the characters `captureFirstArg` read (the target text
 * that `targetsStatePath` and `identifiersIn` then read), and `ownLineChars`,
 * the characters of each write's line before the call, counted at each read,
 * `resolverWork`, the work charged against the budget, `readersBuilt`,
 * the names a `nameReader` was built for, and `stringScanChars`, the
 * characters `stripQuotedStrings` examined in the expressions read.
 * A test seam that bounds the work without a clock; `collect` passes none.
 * Each call overwrites the counts. Anything but an object (`null`,
 * `undefined`) receives nothing.
 */
function findRawStateWrites(rel, text, stats) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const joined = stripped.join('\n');
  const boundaryLinesBefore = [0];
  for (const line of stripped) boundaryLinesBefore.push(boundaryLinesBefore[boundaryLinesBefore.length - 1] + (BODY_BOUNDARY_RE.test(line) ? 1 : 0));
  const bindings = { byName: new Map(), readers: new Map(), linesRead: 0, assignmentMatches: 0, work: 0, maxWork: MAX_RAW_WRITE_RESOLVER_WORK, exhausted: false, stringScanChars: 0 };
  const verdicts = new Map();
  let assignmentLookups = 0;
  let argumentChars = 0;
  let ownLineChars = 0;
  const out = [];
  // `file`/`source` sanitized for the same fork-PR reason as every other
  // finding in this guard. A line's `source` is built once, however many
  // findings it holds.
  const sources = new Map();
  const report = (reason, index) => {
    let source = sources.get(index);
    if (source === undefined) sources.set(index, (source = sanitizeForReport(rawLines[index].trim())));
    out.push({ reason, axis: 'raw-write', file: sanitizeForReport(rel), line: index + 1, source });
  };
  let unresolvedLine = -1;
  const reportUnresolved = (index) => {
    if (unresolvedLine === index) return;
    unresolvedLine = index;
    report(REASON.RAW_STATE_WRITE_UNRESOLVED, index);
  };
  let lineIdx = 0;
  let lineStart = 0;
  let counted = 0;
  RAW_WRITE_CALL_START_RE.lastIndex = 0;
  let m;
  while ((m = RAW_WRITE_CALL_START_RE.exec(joined)) !== null) {
    for (; counted < m.index; counted++) {
      if (joined[counted] === '\n') {
        lineIdx++;
        lineStart = counted + 1;
      }
    }
    // The caps (see above): the file's budget is checked before anything is
    // read, the line before the call is measured before it is read, and the
    // argument read stops one character past the cap.
    if (bindings.exhausted || m.index - lineStart > MAX_RAW_WRITE_TEXT_LENGTH) {
      reportUnresolved(lineIdx);
      continue;
    }
    const rawArg = captureFirstArg(joined, m.index + m[0].length, MAX_RAW_WRITE_TEXT_LENGTH);
    argumentChars += rawArg.length;
    if (rawArg.length > MAX_RAW_WRITE_TEXT_LENGTH) {
      reportUnresolved(lineIdx);
      continue;
    }
    // The argument and the line before the call are charged to the budget.
    if (!chargeWork(bindings, rawArg.length + (m.index - lineStart))) {
      reportUnresolved(lineIdx);
      continue;
    }
    const targetArg = rawArg.trim();
    // The write's own line is read up to the call. When that text holds a
    // named-function header (a one-line nested function), it is dropped
    // instead, so the header does not end the scan: the write may read its
    // enclosing function's variable.
    const cut = joined.slice(lineStart, m.index);
    ownLineChars += cut.length;
    const ownLine = FUNCTION_DECL_LINE_RE.test(cut) ? '' : cut;
    const write = {
      lines: stripped,
      line: lineIdx,
      ownLine,
      ownLineHasBoundary: BODY_BOUNDARY_RE.test(ownLine),
      bindings,
      boundaryLinesBefore,
      verdicts,
      memo: new Map(),
      assignmentLookups: 0,
      ownLineChars: 0,
    };
    const hit = resolvesToStatePath(write, lineIdx, targetArg, MAX_TARGET_RESOLUTION_HOPS);
    assignmentLookups += write.assignmentLookups;
    ownLineChars += write.ownLineChars;
    if (hit) report(REASON.RAW_STATE_WRITE, lineIdx);
    else if (bindings.exhausted) reportUnresolved(lineIdx);
  }
  if (stats !== null && typeof stats === 'object') {
    stats.assignmentLookups = assignmentLookups;
    stats.linesRead = bindings.linesRead;
    stats.assignmentMatches = bindings.assignmentMatches;
    stats.argumentChars = argumentChars;
    stats.ownLineChars = ownLineChars;
    stats.resolverWork = bindings.work;
    stats.readersBuilt = bindings.readers.size;
    stats.stringScanChars = bindings.stringScanChars;
  }
  return out;
}

// ADR-4629 §8.1 (epic #4629, C1) — OPAQUE-TRANSFORM RECOGNITION.
//
// A residual `readModifyWriteStateMd(path, (content) => …)` call whose transform
// (2nd) argument is an inline anonymous arrow / function expression is the opaque
// shape §8.1 replaces with a declared StateWriteIntent: `readModifyWriteStateMd`
// goes THROUGH the seam (it is NOT a raw-write bypass — Axis 2's concern), but its
// opaque body transform is neither verified (§8.2) nor bounded (§8.3). This
// function RECOGNIZES that shape.
//
// C1 ships recognition as a CAPABILITY: it is exported and unit-tested (positive
// control on a seeded fixture) but is DELIBERATELY NOT wired into `collect()`'s
// failing scan. §8.1's caller-side rule is *Required — Phase 2*; wiring it now
// would turn the ~16 residual callers red at once, and ADR-3473 §8.6 retired the
// ratchet that would otherwise be needed to absorb them. C2 wires this terminal as
// the verifying executor lands and the callers migrate under ADR-3408 §6 phasing.
//
// String match, never an AST — same over-report-safe posture as every axis here.
const OPAQUE_RMW_CALL_RE = /\breadModifyWriteStateMd\s*\(/g;
// The transform arg is OPAQUE when it BEGINS an inline anonymous function: an
// arrow (`(…) =>`, `ident =>`, optionally `async`) or a `function` expression. A
// bare identifier / object (a declared StateWriteIntent, Phase 2+) is NOT opaque.
const ANON_TRANSFORM_RE =
  /^\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:async\s+)?function\b/;

/**
 * Capture the top-level, comma-separated argument list of a call, starting at
 * `startIdx` (the index just AFTER the opening `(`) — across newlines and
 * string-aware, tracking `()[]{}` depth. Returns the raw arg strings, or null if
 * the parens never balance (a truncated arg list is never flagged). Generalizes
 * `captureFirstArg`'s depth/inStr bookkeeping to every argument.
 */
function captureCallArgList(text, startIdx) {
  let depth = 0;
  let inStr = null;
  const args = [];
  let cur = '';
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr && text[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        if (cur.trim() !== '' || args.length) args.push(cur);
        return args;
      }
      depth--; cur += ch; continue;
    }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return null; // parens never balanced
}

/**
 * Recognize residual opaque-transform STATE.md writes (ADR-4629 §8.1). Returns a
 * finding per `readModifyWriteStateMd(` call whose 2nd argument is an inline
 * anonymous transform. CAPABILITY only in C1 — not called by `collect()`.
 */
function findOpaqueStateTransforms(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text).join('\n');
  const out = [];
  let m;
  OPAQUE_RMW_CALL_RE.lastIndex = 0;
  while ((m = OPAQUE_RMW_CALL_RE.exec(stripped)) !== null) {
    const args = captureCallArgList(stripped, m.index + m[0].length);
    if (!args || args.length < 2) continue;
    if (!ANON_TRANSFORM_RE.test(args[1])) continue;
    const lineNo = stripped.slice(0, m.index).split('\n').length;
    out.push({
      reason: REASON.OPAQUE_STATE_TRANSFORM,
      axis: 'opaque-transform',
      file: sanitizeForReport(rel),
      line: lineNo,
      source: sanitizeForReport((rawLines[lineNo - 1] || '').trim()),
    });
  }
  return out;
}

// The two write-seam STAGE functions, matched only as CALLS (`\(`
// immediately after, modulo whitespace) — never as bare mentions of the
// name. `writeStateMd(` is deliberately NOT included here (that arm is
// retired — ADR-3473 §8.6 gates it at the type level instead).
const SEAM_CALL_RE = /\b(syncStateFrontmatter|applyPostSyncPreservation)\s*\(/g;
// A line that IS one of the two seam stage functions' own definitions —
// skipped outright, never counted as a call to itself.
const SEAM_DEF_LINE_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:syncStateFrontmatter|applyPostSyncPreservation)\b/;

/**
 * AXIS 5 (§8.3, RETAINED, issue #3871): every direct `syncStateFrontmatter(`/
 * `applyPostSyncPreservation(` call in `text`, outside the two functions' own
 * definitions and (only inside `SEAM_OWNER_FILE`) outside
 * `SEAM_OWNER_EXEMPT_FUNCTIONS`'s own bodies. Terminal: unlike the old
 * `findSeamBypasses` this axis descends from, there is no ratchet — any
 * occurrence is `REASON.COMPOSITION_BYPASS` directly.
 */
function findCompositionBypasses(rel, text) {
  const rawLines = text.split('\n');
  const stripped = stripComments(text);
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;
    if (SEAM_DEF_LINE_RE.test(line)) continue;
    SEAM_CALL_RE.lastIndex = 0;
    let m;
    while ((m = SEAM_CALL_RE.exec(line)) !== null) {
      if (rel === SEAM_OWNER_FILE) {
        const fn = enclosingFunction(stripped, i);
        if (fn && SEAM_OWNER_EXEMPT_FUNCTIONS.includes(fn)) continue;
      }
      // `file`/`source` sanitized for the same fork-PR reason as every other
      // finding in this guard.
      out.push({
        reason: REASON.COMPOSITION_BYPASS,
        axis: 'composition-bypass',
        file: sanitizeForReport(rel),
        line: i + 1,
        symbol: m[1],
        source: sanitizeForReport(rawLines[i].trim()),
      });
    }
  }
  return out;
}

// Prose in the prompt layer shelling out to a write-side `gsd-tools`
// subcommand — the SAME write seam, expressed as markdown instructing an
// agent to run a command, rather than TypeScript calling a function
// directly (Decision 4(d)'s "the scan surface is declared, and is not just
// `src/`"). Matched on RAW lines — no comment stripping — because markdown
// carries no comment syntax this guard should be stripping in the first
// place. `g`-flagged so multiple candidate occurrences on one line are all
// checked against backtick spans below, rather than only the first.
const PROMPT_SEAM_RE = /gsd[-_]?tools[^\n]*\b(state\.patch|state\.planned-phase|state\.sync|phase\.complete)\b/g;

/**
 * Every `` `...` `` inline-code span on `line`, as `[start, end)` character
 * ranges (end exclusive). Handles multiple spans on one line correctly by
 * repeated `exec` over a global, non-overlapping backtick-pair pattern —
 * unlike a naive "count backticks before the match" parity check, this does
 * not get confused by a line that mixes code spans with unrelated literal
 * backticks (e.g. an unmatched one in prose).
 */
const CODE_SPAN_RE = /`[^`\n]+`/g;
function codeSpanRanges(line) {
  const ranges = [];
  CODE_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = CODE_SPAN_RE.exec(line)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * True when character offset `index` of `line` falls inside one of `line`'s
 * inline-code spans.
 */
function isInsideCodeSpan(line, index) {
  return codeSpanRanges(line).some(([start, end]) => index >= start && index < end);
}

/**
 * AXIS 4: every prompt-layer line instructing an agent to shell out to a
 * write-side `gsd-tools` subcommand. Terminal (unratcheted): any occurrence
 * is a violation — this baseline was always empty for the prompt layer (no
 * prompt-layer entry was ever acknowledged), so removing the ratchet changes
 * nothing observable here.
 *
 * A candidate occurrence enclosed in backticks is a MENTION, not an
 * invocation, and is deliberately not reported — CONTRIBUTING.md's "Every
 * `commit` invocation in shipped content must declare `--files`" section
 * states the repo's settled convention verbatim: "Write the command
 * reference in backticks — the repo's own convention — and it is correctly
 * read as a mention." ADR-3180 Amendment 3 records the cost of getting this
 * wrong: the first `lint-phase-enumeration-drift.cjs` flagged JSDoc that
 * merely documented the canonical owner as drift, which trains readers to
 * reflexively exempt documentation instead of trusting the guard — the
 * opposite of Decision 4(a)'s intent.
 */
function findPromptSeamUses(rel, text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    PROMPT_SEAM_RE.lastIndex = 0;
    let m;
    while ((m = PROMPT_SEAM_RE.exec(line)) !== null) {
      if (isInsideCodeSpan(line, m.index)) continue;
      // `file` is sanitized here for the same reason as every other finding
      // in this guard: `rel` is attacker-controlled on a fork PR, exactly
      // like `source`.
      out.push({
        reason: REASON.PROMPT_LAYER_STATE_WRITE,
        axis: 'write-seam',
        file: sanitizeForReport(rel),
        line: i + 1,
        symbol: 'prompt-layer-state-write',
        source: sanitizeForReport(line.trim()),
      });
    }
  }
  return out;
}

/**
 * Run both scan passes (the `src/` tree for Axis 1 + Axis 2 + Axis 3 + Axis 5,
 * the prompt layer for Axis 4) and return the flat, already-terminal finding
 * list — every finding this guard produces carries its own `reason`; there
 * is no longer a ratcheted axis needing a second pass against a baseline.
 *
 * `root` defaults to `REPO_ROOT` (this repo) so every existing caller —
 * `npm run lint:ci`, a bare `node scripts/lint-state-write-path-drift.cjs`,
 * every other module that `require`s `collect` with no argument — is
 * byte-identical to before this parameter existed. It is overridable so a
 * test can exercise the guard's real scanning/reporting logic against a
 * throwaway synthetic tree instead of mutating this repository's own `src/`
 * to prove the guard can fail (see `--root` on the CLI, and F2 in
 * `tests/state-write-path-drift-guard.test.cjs`).
 */
function collect(root = REPO_ROOT) {
  const srcFindings = scanTree({
    root,
    scanDirs: SRC_DIRS,
    scanExt: SRC_EXT,
    onFile(rel, text) {
      const relPosix = toPosixRel(rel);
      const found = [];
      if (relPosix === EXECUTOR_FILE) {
        found.push(...findPolicyDispatchDrift(relPosix, text));
        found.push(...findUnimplementedPolicies(text, relPosix));
        found.push(...findUnstrippedContentWrites(relPosix, text));
      }
      found.push(...findRawStateWrites(relPosix, text));
      found.push(...findCompositionBypasses(relPosix, text));
      return found;
    },
  });

  const promptFindings = scanTree({
    root,
    scanDirs: PROMPT_DIRS,
    scanExt: PROMPT_EXT,
    onFile(rel, text) {
      return findPromptSeamUses(toPosixRel(rel), text);
    },
  });

  return { findings: [...srcFindings, ...promptFindings] };
}

const GOODHART_NOTE =
  'Goodhart note (ADR-3408 Decision 5): this "0 write-path violations" is a LAGGING metric — report ' +
  'it only alongside the behavioral identity test\'s result (asserted at the consumer\'s output), ' +
  'never alone.';

function printFindings(findings) {
  for (const f of findings) {
    process.stderr.write(`[${f.reason}] ${sanitizeForReport(f.file)}:${f.line}\n`);
    process.stderr.write(`    ${sanitizeForReport(f.source)}\n`);
  }
}

/**
 * Parse `argv` into `{ root, wantJson, unknown }`. `--root <dir>` overrides
 * the scan root (default `REPO_ROOT`, resolved relative to `process.cwd()`
 * when given); `--json` is a bare flag. Anything else lands in `unknown` so
 * `main` can report a usage error rather than silently ignoring a typo.
 */
function parseArgs(argv) {
  const args = argv || [];
  let root = REPO_ROOT;
  let wantJson = false;
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      wantJson = true;
      continue;
    }
    if (a === '--root') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--root requires a directory argument' };
      }
      root = path.resolve(value);
      i += 1;
      continue;
    }
    unknown.push(a);
  }
  return { root, wantJson, unknown };
}

/**
 * `argv`: `--json` prints the machine-readable finding set instead of the
 * human-readable report; `--root <dir>` overrides the scan root (defaults to
 * this repo — see `parseArgs`'s own docstring). Exit codes: 0 clean, 1 a
 * finding was reported, 2 usage error.
 */
function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`lint-state-write-path-drift: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { root, wantJson, unknown } = parsed;
  if (unknown.length > 0) {
    process.stderr.write(
      `lint-state-write-path-drift: unrecognized argument(s): ${unknown.map((a) => sanitizeForReport(a)).join(', ')} ` +
        '(expected --json and/or --root <dir>)\n',
    );
    process.exitCode = 2;
    return;
  }

  const { findings } = collect(root);
  const summary = {
    policyDispatchViolations: findings.filter((f) => f.axis === 'policy-dispatch').length,
    frontmatterWriteViolations: findings.filter((f) => f.axis === 'frontmatter-write').length,
    rawWriteViolations: findings.filter((f) => f.axis === 'raw-write').length,
    writeSeamViolations: findings.filter((f) => f.axis === 'write-seam').length,
    compositionBypassViolations: findings.filter((f) => f.axis === 'composition-bypass').length,
  };

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings, summary }, null, 2)}\n`);
    process.exitCode = findings.length === 0 ? 0 : 1;
    return;
  }

  if (findings.length === 0) {
    process.stdout.write(
      'ok state-write-path-drift: no policy-dispatch, frontmatter-write, raw-write, prompt-layer, or ' +
        'composition-bypass violations found\n',
    );
    process.stdout.write(`${GOODHART_NOTE}\n`);
    process.exitCode = 0;
    return;
  }

  process.stderr.write(
    'state-write-path-drift: violation(s) found (ADR-3408 §8.1/§8.3, ADR-3473 §8.6). See ' +
      'docs/adr/3408-state-write-path-preservation.md and docs/adr/3473-enforcement-by-construction.md ' +
      'for the contract:\n',
  );
  printFindings(findings);
  process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  REASON,
  REPO_ROOT,
  SRC_DIRS,
  SRC_EXT,
  PROMPT_DIRS,
  PROMPT_EXT,
  EXECUTOR_FILE,
  SEAM_OWNER_FILE,
  SEAM_OWNER_EXEMPT_FUNCTIONS,
  toPosixRel,
  stripComments,
  enclosingFunction,
  readPolicyUnion,
  findPolicyDispatchDrift,
  findUnimplementedPolicies,
  findUnstrippedContentWrites,
  isQuotedLiteralArg,
  nearestPrecedingAssignment,
  findRawStateWrites,
  targetsStatePath,
  MAX_TARGET_RESOLUTION_HOPS,
  MAX_RAW_WRITE_TEXT_LENGTH,
  MAX_RAW_WRITE_RESOLVER_WORK,
  MAX_RESOLVED_NAME_LENGTH,
  READER_WORK,
  READER_WORK_PER_CHAR,
  LOOKUP_WORK,
  lineReadWork,
  findOpaqueStateTransforms,
  captureCallArgList,
  findCompositionBypasses,
  findPromptSeamUses,
  isInsideCodeSpan,
  parseArgs,
  collect,
  main,
};

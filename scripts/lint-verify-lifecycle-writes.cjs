#!/usr/bin/env node
'use strict';

/**
 * #5105 R4 — verify-lifecycle post-fingerprint write guard.
 *
 * Design: `.gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md` §R "R4".
 *
 * Three rules, all deny-by-default:
 *
 *   L1 (gating) — every `loop render-hooks verify:post` invocation anywhere
 *   under `gsd-core/workflows/**\/*.md` must carry `--after-fingerprint`,
 *   unless an allowlist entry names its exact site with a reason.
 *   `execute-phase.md` is allowlisted: it dispatches these hooks BEFORE its
 *   own fingerprint (`execute-phase.md:1202`), so gating would be a no-op
 *   there by construction, not a defect. The invocation may be split across
 *   a backslash-continued line, and `verify:post` may appear quoted
 *   (#5105 S12) — both are joined/matched before the flag check runs.
 *
 *   L2 (raw write, fail-closed) — in post-fingerprint text (`verify-work.md`
 *   and `verify-work/**`), a `query commit … --files <p...>`, `git add
 *   <p...>`, or `query frontmatter.set <p>` whose pathspec is not PROVABLY
 *   inert (a verification report path, or a `.planning/`-root shared
 *   planning doc) is flagged — including an unresolvable variable pathspec,
 *   which fails closed rather than being treated as safe. EVERY pathspec
 *   token following `--files`/`add`, not just the first, is checked
 *   (#5105 S11).
 *
 *   L3 (secure-phase enablement phrasing, #5105 S1) — in a file that
 *   somewhere invokes `loop render-hooks verify:post ... --after-fingerprint`
 *   (i.e. is subject to L1's post-fingerprint `skippedHooks` split), a prose
 *   line matching "active secure-phase step hook exists" or "no active
 *   secure-phase step hook" that does NOT also mention `skippedHooks` on that
 *   same line is flagged. `--after-fingerprint` moves an already-satisfied
 *   secure-phase hook out of `activeHooks` into `skippedHooks` — prose that
 *   tests only `activeHooks` membership for this hook silently stops gating
 *   `threats_open` once the phase dir already holds a SECURITY.md. Narrow by
 *   design: it does not try to parse the surrounding shell/JSON logic, only
 *   catches the specific phrase resurfacing without its required caveat.
 *
 * Commands are extracted with the ONE shipped-command tokenizer
 * (`tests/helpers/shipped-command-scan.cjs`'s `tokenize`) — no second
 * tokenizer is lifted into `scripts/lib` (grilling-pass finding F8).
 *
 * Report-path and shared-planning-doc detection (#5105 S15) are NOT
 * re-derived here — `isVerificationReportPath` and `isSharedPlanningDoc` are
 * imported directly from the compiled `gsd-core/bin/lib/verification.cjs`,
 * the same functions `resolveVerificationFile` / `computeCoveredDigest` use,
 * so this guard can never silently drift from what the runtime itself
 * considers a report or a shared planning doc.
 *
 * Allowlist: `scripts/lint-verify-lifecycle-writes.allowlist.json`, entries
 * `{ file, rule, command, reason }`. `command` pins the EXACT site: the
 * whitespace-normalized text of the violating line/invocation — keying on
 * `file`+`rule` alone would let one allowlisted site silently exempt a
 * different, unrelated offender that happens to share a file and rule
 * (#5105 S13). `reason` must cite `#\d+` (a bare URL no longer qualifies —
 * S13 also drops that alternative). A stale entry (no longer matching any
 * real finding) is itself a violation — enforced via
 * `scripts/lib/allowlist-ratchet.cjs`'s `assertWithinAllowlist`, the same
 * "no masking blind spot" primitive every sibling drift guard uses.
 *
 * Fail-closed (#5105 S14): scanning zero host files, or finding zero
 * `loop render-hooks verify:post` sites at all, is itself a violation —
 * an inert scan must never report a clean repo. A malformed (non-JSON or
 * non-array) allowlist is a hard error, not a silently-empty allowlist.
 */

const fs = require('node:fs');
const path = require('node:path');
const { tokenize, bareCommandName } = require('../tests/helpers/shipped-command-scan.cjs');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { isSharedPlanningDoc, isVerificationReportPath } = require('../gsd-core/bin/lib/verification.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'lint-verify-lifecycle-writes.allowlist.json');

// #5105 S12: `verify:post` may appear bare or quoted, and `loop render-hooks`
// may be separated from it by a backslash-continued line join (a single
// space is inserted at the join point by `joinContinuations`) — so `\s+`
// rather than a single literal space between the two words.
const RENDER_HOOKS_VERIFY_POST_RE = /loop\s+render-hooks\s+"?verify:post"?\b/;
const ISSUE_REF_RE = /#\d+/;
const SECURE_PHASE_ENABLEMENT_PHRASE_RE = /active secure-phase step hook exists|no active secure-phase step hook/i;

// #5105 R4: post-fingerprint text — verify-work.md (the raw commits census
// found in it, #4887/#4981) and everything under its `verify-work/` detail
// tree. Every other workflow file is scanned for L1 only.
function isPostFingerprintHost(relPosixPath) {
  return relPosixPath === 'gsd-core/workflows/verify-work.md'
    || relPosixPath.startsWith('gsd-core/workflows/verify-work/');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function stripQuotes(raw) {
  let v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1);
    }
  }
  return v;
}

/**
 * #5105 S12: join backslash-continued physical lines into logical lines, so
 * `loop render-hooks \` / `  verify:post …` on the next physical line reads
 * as one invocation. Returns `{ text, line }[]` — `line` is the 1-based
 * number of the FIRST physical line in each logical group, which is what a
 * reported violation should point at.
 */
function joinContinuations(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const startLine = i + 1;
    let text = lines[i];
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      text = `${text.replace(/\\\s*$/, '')} ${lines[i + 1].trim()}`;
      i += 1;
    }
    out.push({ text, line: startLine });
    i += 1;
  }
  return out;
}

/**
 * L1 — a `loop render-hooks verify:post` invocation with no
 * `--after-fingerprint` anywhere in its (possibly continuation-joined)
 * logical line. Applies to every scanned host, regardless of
 * `postFingerprint` — execute-phase.md's own pre-fingerprint dispatch is
 * exempted via the allowlist, not via this option.
 */
function scanForMissingGating(file, lines) {
  const violations = [];
  for (const { text, line } of joinContinuations(lines)) {
    if (RENDER_HOOKS_VERIFY_POST_RE.test(text) && !text.includes('--after-fingerprint')) {
      violations.push({
        rule: 'L1',
        file,
        line,
        target: 'loop render-hooks verify:post',
        text: text.trim(),
      });
    }
  }
  return violations;
}

/**
 * L2 — a raw write of a coverable phase artifact in post-fingerprint text.
 * Fail-closed: anything not PROVABLY inert (a report path, or a shared
 * planning doc) is flagged, including an unresolvable variable pathspec.
 * Every pathspec token following `--files`/`git add` is checked, not just
 * the first (#5105 S11) — the run stops at the next flag (a token starting
 * with `-`), an operator, or a redirection.
 */
function scanForRawWrites(file, lines) {
  const violations = [];
  const flag = (i, pathspecRaw) => {
    const p = stripQuotes(pathspecRaw);
    if (isVerificationReportPath(p) || isSharedPlanningDoc(p)) return;
    violations.push({ rule: 'L2', file, line: i + 1, target: p, text: lines[i].trim() });
  };
  const collectPathTokens = (tokens, startIdx) => {
    const paths = [];
    let ti = startIdx;
    while (ti < tokens.length) {
      const t = tokens[ti];
      if (t.op || t.redir) break;
      if (t.value.startsWith('-')) break; // the next flag ends this pathspec run
      paths.push(t.value);
      ti += 1;
    }
    return { paths, nextIdx: ti };
  };
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenize(lines[i]);
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (t.op || t.redir) continue;
      if (t.value === '--files' || t.value === '--files=') {
        const { paths, nextIdx } = collectPathTokens(tokens, ti + 1);
        for (const p of paths) flag(i, p);
        ti = nextIdx - 1;
        continue;
      }
      if (t.value.startsWith('--files=') && t.value.length > '--files='.length) {
        flag(i, t.value.slice('--files='.length));
        continue;
      }
      if (t.value === 'add' && ti > 0 && bareCommandName(tokens[ti - 1]) === 'git') {
        const { paths, nextIdx } = collectPathTokens(tokens, ti + 1);
        for (const p of paths) flag(i, p);
        ti = nextIdx - 1;
        continue;
      }
      if (t.value === 'frontmatter.set') {
        const next = tokens[ti + 1];
        if (next && !next.op && !next.redir) flag(i, next.value);
      }
    }
  }
  return violations;
}

/**
 * L3 — a "(no) active secure-phase step hook (exists)" prose line, in a file
 * that carries at least one `--after-fingerprint`-gated
 * `loop render-hooks verify:post` invocation, which does not also mention
 * `skippedHooks` on the SAME line (#5105 S1). Narrow and line-scoped by
 * design — see the module docblock's L3 section.
 */
function scanForSecurePhaseEnablementPhrasing(file, lines) {
  const violations = [];
  const hasGatedInvocation = joinContinuations(lines).some(
    ({ text }) => RENDER_HOOKS_VERIFY_POST_RE.test(text) && text.includes('--after-fingerprint'),
  );
  if (!hasGatedInvocation) return violations;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECURE_PHASE_ENABLEMENT_PHRASE_RE.test(line) && !line.includes('skippedHooks')) {
      violations.push({
        rule: 'L3',
        file,
        line: i + 1,
        target: 'secure-phase enablement phrasing',
        text: line.trim(),
      });
    }
  }
  return violations;
}

/**
 * Scan a single host's text. `opts.postFingerprint` gates L2 only — L1 and L3
 * are always checked (the allowlist, not this option, is what exempts a
 * pre-fingerprint host like execute-phase.md from L1; L3 self-gates on the
 * presence of a `--after-fingerprint`-carrying invocation in the same text).
 */
function scanText(file, text, opts = {}) {
  const lines = text.split('\n');
  const violations = scanForMissingGating(file, lines);
  violations.push(...scanForSecurePhaseEnablementPhrasing(file, lines));
  if (opts.postFingerprint === true) {
    violations.push(...scanForRawWrites(file, lines));
  }
  return violations;
}

/** #5105 S13: collapse a command/line's whitespace so a re-wrapped or
 * re-indented (but otherwise identical) site still keys the same. */
function normalizeCommandText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** #5105 S13: the allowlist key pins file + rule + the EXACT normalized site
 * text — not file + rule alone, which would let one allowlisted site exempt
 * an unrelated offender sharing only the file and rule. */
function keyFor(file, rule, commandText) {
  return `${file}::${rule}::${normalizeCommandText(commandText)}`;
}

function idFor(violation) {
  return keyFor(violation.file, violation.rule, violation.text);
}

function idForEntry(entry) {
  return keyFor(entry.file, entry.rule, entry.command);
}

/** #5105 S13: filter `violations` against allowlist `entries`, keyed on the
 * exact site (file + rule + normalized command text). Exported so the
 * per-site pinning behavior is testable without touching the real repo
 * tree or `scanRepo`'s hardcoded `REPO_ROOT`. */
function filterAllowedViolations(violations, entries) {
  const allowedIds = new Set(entries.map(idForEntry));
  return violations.filter((v) => !allowedIds.has(idFor(v)));
}

/**
 * Validate the allowlist itself against the real findings it is meant to
 * cover: every entry's `reason` must cite an issue (#\d+), and every entry
 * must still match a real finding (no stale entries) — the "no masking
 * blind spot" primitive (`assertWithinAllowlist`) shared with every sibling
 * drift guard. Returns a flat list of `{ message }` problems (empty when
 * clean).
 */
function validateAllowlist(entries, violations) {
  const problems = [];
  for (const e of entries) {
    if (!ISSUE_REF_RE.test(String(e.reason || ''))) {
      problems.push({
        message: `lint-verify-lifecycle-writes allowlist entry ${idForEntry(e)} has a reason that does not cite an issue (#NNN): ${JSON.stringify(e.reason)}`,
      });
    }
  }
  assertWithinAllowlist({
    label: 'lint-verify-lifecycle-writes allowlist',
    current: violations.map(idFor),
    known: entries.map(idForEntry),
    fail: (message) => problems.push({ message }),
    pruneHint: 'edit scripts/lint-verify-lifecycle-writes.allowlist.json',
  });
  return problems;
}

/**
 * #5105 S14: parse allowlist JSON text, failing HARD (not silently
 * returning `[]`) on malformed JSON or a non-array shape. Extracted from
 * `loadAllowlist` so this parsing/validation contract is directly testable
 * without touching the real allowlist file on disk.
 */
function parseAllowlist(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`lint-verify-lifecycle-writes: malformed allowlist JSON at ${ALLOWLIST_PATH}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`lint-verify-lifecycle-writes: allowlist at ${ALLOWLIST_PATH} must be a JSON array, got ${typeof parsed}`);
  }
  return parsed;
}

/** A missing allowlist file is treated as "no entries yet" (ENOENT only);
 * any other read failure, or malformed content, is a hard error via
 * `parseAllowlist` — never a silent `[]` (#5105 S14). */
function loadAllowlist() {
  let raw;
  try {
    raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new Error(`lint-verify-lifecycle-writes: cannot read allowlist ${ALLOWLIST_PATH}: ${err.message}`);
  }
  return parseAllowlist(raw);
}

/** Recursively collect every `.md` file under `dir` (repo-relative POSIX paths). */
function collectMarkdownFiles(root, dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(root, full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(toPosix(path.relative(root, full)));
    }
  }
  return out;
}

/**
 * Scan the real repo tree: every `gsd-core/workflows/**\/*.md` host. Returns
 * `{ scannedHosts, renderHookSites, violations }` — `violations` already has
 * allowlisted findings removed, but gains an entry for any invalid/stale
 * allowlist entry (an allowlist that no longer earns its keep is itself red)
 * and for a fail-closed integrity check (#5105 S14): scanning zero hosts, or
 * finding zero render-hooks sites at all, is itself a violation.
 */
function scanRepo(root) {
  const workflowsDir = path.join(root, 'gsd-core', 'workflows');
  const files = collectMarkdownFiles(root, workflowsDir);

  const renderHookSites = [];
  const rawViolations = [];
  let scannedHosts = 0;

  for (const relFile of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, relFile), 'utf-8');
    } catch {
      continue;
    }
    scannedHosts += 1;
    const lines = text.split('\n');
    for (const { text: logicalText, line } of joinContinuations(lines)) {
      if (RENDER_HOOKS_VERIFY_POST_RE.test(logicalText)) {
        renderHookSites.push({ file: relFile, line });
      }
    }
    rawViolations.push(...scanText(relFile, text, { postFingerprint: isPostFingerprintHost(relFile) }));
  }

  const entries = loadAllowlist();
  const violations = filterAllowedViolations(rawViolations, entries);

  const allowlistProblems = validateAllowlist(entries, rawViolations);
  for (const p of allowlistProblems) {
    violations.push({ rule: 'allowlist', file: ALLOWLIST_PATH, message: p.message });
  }

  // #5105 S14: fail closed. An inert scan (nothing scanned, or nothing found
  // to gate) must never report a clean repo — that is indistinguishable from
  // a broken path/glob silently swallowing every real host.
  if (scannedHosts === 0) {
    violations.push({
      rule: 'integrity',
      file: workflowsDir,
      message: `lint-verify-lifecycle-writes: scanned zero host files under ${toPosix(path.relative(root, workflowsDir))} — failing closed rather than reporting a clean repo.`,
    });
  }
  if (renderHookSites.length === 0) {
    violations.push({
      rule: 'integrity',
      file: workflowsDir,
      message: 'lint-verify-lifecycle-writes: found zero "loop render-hooks verify:post" sites — failing closed rather than reporting a clean repo.',
    });
  }

  return { scannedHosts, renderHookSites, violations };
}

function main() {
  const result = scanRepo(REPO_ROOT);

  if (result.violations.length === 0) {
    process.stdout.write(
      `ok verify-lifecycle-writes: ${result.scannedHosts} host(s) scanned, ${result.renderHookSites.length} render-hooks verify:post site(s), zero violations\n`,
    );
    return;
  }

  process.stderr.write('verify-lifecycle-writes: post-fingerprint write violation(s) found.\n');
  for (const v of result.violations) {
    if (v.message) {
      process.stderr.write(`  [${v.rule}] ${v.message}\n`);
    } else {
      process.stderr.write(`  [${v.rule}] ${v.file}:${v.line}  target=${v.target}\n`);
    }
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  scanText,
  scanRepo,
  validateAllowlist,
  filterAllowedViolations,
  parseAllowlist,
  isPostFingerprintHost,
  isVerificationReportPath,
  isSharedPlanningDoc,
  scanForSecurePhaseEnablementPhrasing,
};

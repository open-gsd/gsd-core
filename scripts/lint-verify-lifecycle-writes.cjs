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
 *   unless an allowlist entry names its file with a reason. `execute-phase.md`
 *   is allowlisted: it dispatches these hooks BEFORE its own fingerprint
 *   (`execute-phase.md:1202`), so gating would be a no-op there by
 *   construction, not a defect.
 *
 *   L2 (raw write, fail-closed) — in post-fingerprint text (`verify-work.md`
 *   and `verify-work/**`), a `query commit … --files <p>`, `git add <p>`, or
 *   `query frontmatter.set <p>` whose pathspec is not PROVABLY inert (a
 *   verification report path, or a `.planning/`-root shared planning doc) is
 *   flagged — including an unresolvable variable pathspec, which fails closed
 *   rather than being treated as safe.
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
 * Allowlist: `scripts/lint-verify-lifecycle-writes.allowlist.json`, entries
 * `{ file, rule, target, reason }`. `reason` must cite `#\d+` or a URL. A
 * stale entry (no longer matching any real finding) is itself a violation —
 * enforced via `scripts/lib/allowlist-ratchet.cjs`'s `assertWithinAllowlist`,
 * the same "no masking blind spot" primitive every sibling drift guard uses.
 */

const fs = require('node:fs');
const path = require('node:path');
const { tokenize, bareCommandName } = require('../tests/helpers/shipped-command-scan.cjs');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'lint-verify-lifecycle-writes.allowlist.json');

const RENDER_HOOKS_VERIFY_POST_RE = /loop render-hooks verify:post\b/;
const ISSUE_REF_RE = /#\d+|https?:\/\//;
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

/** #4623/#5095-shaped report basename test — mirrors isVerificationReportPath. */
function isReportPathspec(p) {
  const basename = p.split('/').pop() || p;
  return basename === 'VERIFICATION.md' || basename.endsWith('-VERIFICATION.md');
}

/** A root-level shared planning doc: `.planning/<Name>.<md|json>` — never `phases/`/`workstreams/`. */
function isSharedPlanningDocPathspec(p) {
  return /(^|\/)\.planning\/[^/]+\.(?:md|json)$/.test(p);
}

/**
 * L1 — a `loop render-hooks verify:post` invocation with no
 * `--after-fingerprint` on the SAME line. Applies to every scanned host,
 * regardless of `postFingerprint` — execute-phase.md's own pre-fingerprint
 * dispatch is exempted via the allowlist, not via this option.
 */
function scanForMissingGating(file, lines) {
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RENDER_HOOKS_VERIFY_POST_RE.test(line) && !line.includes('--after-fingerprint')) {
      violations.push({
        rule: 'L1',
        file,
        line: i + 1,
        target: 'loop render-hooks verify:post',
        text: line.trim(),
      });
    }
  }
  return violations;
}

/**
 * L2 — a raw write of a coverable phase artifact in post-fingerprint text.
 * Fail-closed: anything not PROVABLY inert (a report path, or a shared
 * planning doc) is flagged, including an unresolvable variable pathspec.
 */
function scanForRawWrites(file, lines) {
  const violations = [];
  const flag = (i, pathspecRaw) => {
    const p = stripQuotes(pathspecRaw);
    if (isReportPathspec(p) || isSharedPlanningDocPathspec(p)) return;
    violations.push({ rule: 'L2', file, line: i + 1, target: p });
  };
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenize(lines[i]);
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (t.op || t.redir) continue;
      if (t.value === '--files' || t.value === '--files=') {
        const next = tokens[ti + 1];
        if (next && !next.op && !next.redir) flag(i, next.value);
        continue;
      }
      if (t.value.startsWith('--files=') && t.value.length > '--files='.length) {
        flag(i, t.value.slice('--files='.length));
        continue;
      }
      if (t.value === 'add' && ti > 0 && bareCommandName(tokens[ti - 1]) === 'git') {
        const next = tokens[ti + 1];
        if (next && !next.op && !next.redir) flag(i, next.value);
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
  const hasGatedInvocation = lines.some(
    (line) => RENDER_HOOKS_VERIFY_POST_RE.test(line) && line.includes('--after-fingerprint'),
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

function idFor(x) {
  return `${x.file}::${x.rule}::${x.target}`;
}

/**
 * Validate the allowlist itself against the real findings it is meant to
 * cover: every entry's `reason` must cite an issue/URL, and every entry must
 * still match a real finding (no stale entries) — the "no masking blind
 * spot" primitive (`assertWithinAllowlist`) shared with every sibling drift
 * guard. Returns a flat list of `{ message }` problems (empty when clean).
 */
function validateAllowlist(entries, violations) {
  const problems = [];
  for (const e of entries) {
    if (!ISSUE_REF_RE.test(String(e.reason || ''))) {
      problems.push({
        message: `lint-verify-lifecycle-writes allowlist entry ${idFor(e)} has a reason that does not cite an issue (#NNN) or URL: ${JSON.stringify(e.reason)}`,
      });
    }
  }
  assertWithinAllowlist({
    label: 'lint-verify-lifecycle-writes allowlist',
    current: violations.map(idFor),
    known: entries.map(idFor),
    fail: (message) => problems.push({ message }),
    pruneHint: 'edit scripts/lint-verify-lifecycle-writes.allowlist.json',
  });
  return problems;
}

function loadAllowlist() {
  try {
    const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
 * allowlist entry (an allowlist that no longer earns its keep is itself red).
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
    for (let i = 0; i < lines.length; i++) {
      if (RENDER_HOOKS_VERIFY_POST_RE.test(lines[i])) {
        renderHookSites.push({ file: relFile, line: i + 1 });
      }
    }
    rawViolations.push(...scanText(relFile, text, { postFingerprint: isPostFingerprintHost(relFile) }));
  }

  const entries = loadAllowlist();
  const allowedIds = new Set(entries.map(idFor));
  const violations = rawViolations.filter((v) => !allowedIds.has(idFor(v)));

  const allowlistProblems = validateAllowlist(entries, rawViolations);
  for (const p of allowlistProblems) {
    violations.push({ rule: 'allowlist', file: ALLOWLIST_PATH, message: p.message });
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
    if (v.rule === 'allowlist') {
      process.stderr.write(`  [allowlist] ${v.message}\n`);
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
  isPostFingerprintHost,
  isReportPathspec,
  isSharedPlanningDocPathspec,
  scanForSecurePhaseEnablementPhrasing,
};

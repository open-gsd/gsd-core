#!/usr/bin/env node
'use strict';

/**
 * lint-allow-test-rule-refs.cjs — enforce that NEW `allow-test-rule:` exemption
 * comments carry a tracking-issue reference.
 *
 * ## Why
 *
 * `allow-test-rule:` is an inline comment that disables the `no-source-grep`
 * ESLint rule for a whole test file.  Today many such comments exist with no
 * issue reference, making it impossible to audit or revisit them.  Per ADR-456
 * (docs/adr/456-test-rigor-architecture.md) every NEW exemption must carry a
 * `#NNN` issue reference or an https:// URL so the decision is traceable.
 *
 * ## What "compliant" means
 *
 * A compliant `allow-test-rule:` comment is one whose reason text (everything
 * after the colon) contains either:
 *   - a `#\d+` token  (e.g. `// allow-test-rule: see #1234`)
 *   - an https?:// URL
 *
 * Any other comment is an OFFENDER.
 *
 * ## Grandfathering
 *
 * All pre-existing untracked exemptions are recorded in
 * scripts/lint-allow-test-rule-refs.allowlist.json (seeded at gate introduction
 * time).  The identity ratchet (scripts/lib/allowlist-ratchet.cjs) means:
 *   - A NEW non-compliant comment not in the allowlist → gate fails.
 *   - A previously-offending comment that is now compliant → allowlist entry is
 *     STALE and must be pruned (ratchet-down; the baseline only ever shrinks).
 *
 * ## Offender identifiers
 *
 * Identifiers are stable cross-rename-safe strings of the form:
 *   `<repo-relative-path> :: <trimmed-reason>`
 *
 * e.g. `tests/foo.test.cjs :: source-text-is-the-product`
 *
 * If a file has multiple non-compliant comments with the SAME reason text, only
 * one identifier is recorded (deduped via Set).
 *
 * See docs/adr/456-test-rigor-architecture.md for the full policy.
 */

const fs = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const TESTS_DIR = process.env.GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR || path.join(ROOT, 'tests');
const ALLOWLIST_PATH =
  process.env.GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST ||
  path.join(__dirname, 'lint-allow-test-rule-refs.allowlist.json');

/**
 * Extracts the reason text after `allow-test-rule:` from a single line of source
 * text in any comment form that the no-source-grep ESLint rule honours.
 *
 * The ESLint rule tests `c.value` (AST comment node value, delimiters stripped)
 * with /allow-test-rule:\s*\S/, which fires on BOTH:
 *   // allow-test-rule: <reason>    (line comment)
 *   /* allow-test-rule: <reason> * / (block comment, single-line)
 *
 * By scanning line-by-line and extracting everything after `allow-test-rule:` on
 * each line, we cover both forms without a cross-line regex (which was previously
 * matching arbitrary `/* ... * /` pairs spanning hundreds of lines, causing false
 * positives).
 *
 * The trailing `*\/` and whitespace are stripped so block-comment closers don't
 * bleed into the extracted reason.
 */
const ALLOW_TEST_RULE_LINE_RE = /allow-test-rule:\s*(.+)/;
/** Matches a compliant issue reference or URL */
const ISSUE_REF_RE = /#\d+|https?:\/\//;

/**
 * Recursively collect offender identifiers from all *.test.cjs files under dir.
 *
 * @param {string} dir  absolute path to scan
 * @returns {string[]}  sorted, deduped list of `<relpath> :: <reason>` strings
 */
function collectOffenders(dir) {
  const offenders = new Set();

  function scan(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
        const relpath = path.relative(ROOT, full).split(path.sep).join('/');
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch {
          // skip unreadable files (e.g. binary)
          continue;
        }
        // Scan line-by-line.  By testing each line for `allow-test-rule:` we
        // cover BOTH comment forms without a cross-line regex:
        //   // allow-test-rule: <reason>         ← line comment
        //   /* allow-test-rule: <reason> */      ← single-line block comment
        //
        // For each matching line we extract the reason (everything after the
        // colon), then strip any trailing block-comment closer `*/` and
        // whitespace so the identifier stays clean.
        for (const line of content.split('\n')) {
          const m = ALLOW_TEST_RULE_LINE_RE.exec(line);
          if (!m) continue;
          // Strip trailing block-comment closer and whitespace if present
          const reason = m[1].replace(/\s*\*\/\s*$/, '').trim();
          if (!reason) continue;
          if (ISSUE_REF_RE.test(reason)) continue; // compliant — skip
          offenders.add(`${relpath} :: ${reason}`);
        }
      }
    }
  }

  scan(dir);
  return [...offenders].sort();
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--help');
  if (unknown.length > 0) {
    throw new ExitError(2, `lint-allow-test-rule-refs: unknown argument(s): ${unknown.join(', ')}`);
  }

  const current = collectOffenders(TESTS_DIR);
  const known = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

  const failures = [];
  const { novel } = assertWithinAllowlist({
    label: 'allow-test-rule-refs',
    current,
    known,
    fail: (msg) => failures.push(msg),
    pruneHint: 'edit scripts/lint-allow-test-rule-refs.allowlist.json',
  });

  if (failures.length > 0) {
    for (const msg of failures) process.stderr.write(`${msg}\n`);
    if (novel.length > 0) {
      process.stderr.write(
        '\nNew allow-test-rule exemption without an issue ref — add `see #NNN` per ADR-456' +
          ' (docs/adr/456-test-rigor-architecture.md).\n'
      );
    }
    throw new ExitError(1);
  }

  console.log(
    `ok lint-allow-test-rule-refs: ${current.length} grandfathered exemption(s) tracked, no novel untracked offenders`
  );
}

runMain(main);

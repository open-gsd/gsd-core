'use strict';

/**
 * portability-rule-disable-ban: the out-of-band disable-ban scan (ADR-1703).
 *
 * ESLint inline suppression of portability rules is banned. This check runs
 * OUTSIDE ESLint, so it cannot itself be eslint-disabled. It was
 * tests/portability-rule-disable-ban.test.cjs (76 s of Linux test time); it is
 * a static check of repo content, so it runs in scripts/run-static-checks.cjs
 * (ADR-6315 item 19, #6414).
 *
 * Fails on:
 *   (a) any `eslint-disable*` comment that NAMES a protected portability rule;
 *   (b) any BLANKET `eslint-disable*` comment (no rule list), which suppresses
 *       every rule including the protected ones;
 *   (c) a file that holds a disable keyword and does not parse (fail CLOSED: a
 *       file that cannot be read as JavaScript could hide a real directive). A
 *       file that does not spell the keyword cannot hold a directive, so it is
 *       not parsed and its parse errors are ESLint's to report, not this check's;
 *   (d) fewer than MIN_FILES files to scan, so an empty or broken file set
 *       cannot pass as clean.
 *
 * PROTECTED_RULES grows as later phases add rules; each new portability rule in
 * the `local/` namespace is appended to the list.
 *
 * This file references the disable keyword only inside concatenated strings, so
 * it contains no directive of its own.
 */

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const tsEstree = require('@typescript-eslint/typescript-estree');
const { globSync } = require('glob');

const PROTECTED_RULES = Object.freeze([
  'no-path-literal-in-assert',
  'no-posix-mode-bit-assert',
  'no-unguarded-nonportable-exec',
  // ADR-1703 Phase 4 rules (issue #1726)
  'no-crlf-fragile-split',
  'no-hardcoded-tmp',
  'no-bare-npm-exec',
  'require-userprofile-with-home',
  // ADR-1703 Phase 5 rule (issue #1733), applies to src/**/*.cts (production sources)
  'normalize-path-in-content',
  // ADR-1703 Phase 6 rule (issue #1740), applies to src/**/*.cts and the build/install
  // surface (bin/install.js, scripts/build-hooks.js) brought under lint by the glob expansion
  'require-fs-op-fallback',
  // #4244 hardening (origin #4020 / #4220 Windows CI hang), applies to tests/**/*.test.cjs
  'require-full-tmpdir-triad',
  'no-unbounded-dirname-walk',
  // #4590 (epic #4589 Phase 1)
  'no-rendered-text-length-assert',
]);

/** The scan must find at least this many files, or it proved nothing. */
const MIN_FILES = 10;

// The three directive forms ESLint recognises (built as concatenated strings so
// this source file contains NO real disable directive of its own).
const D = 'eslint-' + 'disable';
const DN = 'eslint-' + 'disable-next-line';
const DL = 'eslint-' + 'disable-line';
const DISABLE_PREFIXES = [DN, DL, D]; // longest first so prefix-match is greedy

/**
 * Classify a comment node's text. Returns:
 *   'blanket': a disable with NO rule list (suppresses everything)
 *   'named':   a disable that lists at least one protected portability rule
 *   null:      not a disable directive, or a non-portability named disable
 */
function classifyComment(commentValue) {
  const txt = commentValue.trim();
  for (const prefix of DISABLE_PREFIXES) {
    if (!txt.startsWith(prefix)) continue;
    const rest = txt.slice(prefix.length).trim();
    // Blanket: nothing after the keyword, or only a prose comment (starts with --)
    if (!rest || rest.startsWith('--')) return 'blanket';
    // Named: rest is a comma-separated rule list (possibly with -- prose)
    const rules = rest.split('--')[0].split(',').map((r) => r.trim()).filter(Boolean);
    for (const rule of rules) {
      for (const protectedRule of PROTECTED_RULES) {
        if (rule === 'local/' + protectedRule || rule === protectedRule) return 'named';
      }
    }
    return null; // named disable but not for a protected rule
  }
  return null;
}

/**
 * The files the ban covers:
 *   - tests/**\/*.test.cjs: test sources (phase 1 to 4 scope)
 *   - src/**\/*.cts: production TypeScript sources (phase 5 protects
 *     normalize-path-in-content, which applies to src/**\/*.cts)
 *   - bin/install.js and scripts/build-hooks.js: the ADR-1703 phase 6 glob
 *     expansion surface (DEFECT.WINDOWS-FS-OPS)
 * @param {string} root repository root
 * @returns {string[]} absolute paths
 */
function collectFiles(root) {
  const globbed = (pattern) => globSync(pattern, { cwd: root }).map((rel) => path.join(root, rel));
  const extra = [path.join(root, 'bin', 'install.js'), path.join(root, 'scripts', 'build-hooks.js')]
    .filter((abs) => fs.existsSync(abs));
  return [...globbed('tests/**/*.test.cjs'), ...globbed('src/**/*.cts'), ...extra];
}

/**
 * Scan one file. A file whose text holds no disable keyword cannot hold a
 * directive (a directive is a comment that spells the keyword), so only files
 * that do are parsed: that is what takes the scan from every file to a handful.
 * A file that holds the keyword and does not parse throws (fail closed).
 * @param {string} absPath
 * @returns {{blanket: object[], named: object[]}}
 */
function scanFile(absPath) {
  let src;
  try {
    src = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${absPath}: ${err.message}`);
  }
  if (!src.includes(D)) return { blanket: [], named: [] };

  // bin/install.js (generated installer) starts with a `#!/usr/bin/env node`
  // shebang that espree cannot parse. Rewrite the leading `#!` to `//` so it
  // becomes a valid line comment, keeping byte length and line numbers.
  if (src.startsWith('#!')) src = '//' + src.slice(2);

  let ast;
  try {
    ast = absPath.endsWith('.cts')
      ? tsEstree.parse(src, { comment: true, loc: true, range: true })
      : espree.parse(src, { comment: true, ecmaVersion: 2022, loc: true, range: true, tolerant: true });
  } catch (parseErr) {
    throw new Error(`Parse error in ${absPath}: ${parseErr.message}`);
  }

  const blanket = [];
  const named = [];
  for (const cmt of ast.comments || []) {
    const kind = classifyComment(cmt.value);
    if (!kind) continue;
    const entry = { file: absPath, line: cmt.loc ? cmt.loc.start.line : '?', text: cmt.value.trim() };
    (kind === 'blanket' ? blanket : named).push(entry);
  }
  return { blanket, named };
}

/**
 * @param {{root: string}} ctx
 * @returns {{file: string, line: number|string, message: string}[]}
 */
function run({ root, minFiles = MIN_FILES }) {
  const findings = [];
  const files = collectFiles(root);
  if (files.length < minFiles) {
    findings.push({ file: '(scan)', line: 0, message: `expected at least ${minFiles} files to scan, found ${files.length}: the file set is empty or the globs broke` });
  }
  for (const absPath of files) {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    let scanned;
    try {
      scanned = scanFile(absPath);
    } catch (err) {
      findings.push({ file: rel, line: 1, message: err.message });
      continue;
    }
    for (const o of scanned.named) {
      findings.push({
        file: rel,
        line: o.line,
        message: `inline disable suppresses a protected portability rule: ${o.text}. Remove it; the rule enforces cross-platform safety.`,
      });
    }
    for (const o of scanned.blanket) {
      findings.push({
        file: rel,
        line: o.line,
        message: `blanket disable suppresses every rule, including the portability rules: ${o.text}. Use a targeted per-rule disable for a non-portability rule, or remove it.`,
      });
    }
  }
  return findings;
}

module.exports = {
  name: 'portability-rule-disable-ban',
  run,
  scanFile,
  classifyComment,
  collectFiles,
  PROTECTED_RULES,
  MIN_FILES,
};

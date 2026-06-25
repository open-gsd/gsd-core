'use strict';

/**
 * portability-rule-disable-ban.test.cjs
 *
 * Out-of-band disable-ban scan (ADR-1703).
 *
 * ESLint inline suppression of portability rules is banned. This test runs
 * OUTSIDE ESLint so it cannot itself be eslint-disabled.
 *
 * PROTECTED_RULES grows as later phases add rules. Each new portability rule
 * in the `local/` namespace should be appended to this list.
 *
 * Hard-fails on:
 *   (a) Any `eslint-disable*` comment that NAMES a protected portability rule.
 *   (b) Any BLANKET `eslint-disable*` comment (no rule list) — these suppress
 *       every rule including the protected ones.
 *
 * NOTE: This file itself is excluded from the scan by absolute path. It
 * references the disable keyword only inside regex/string data structures to
 * avoid being detected as a real directive.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const espree = require('espree');
const { globSync } = require('glob');

// ── Protected portability rules (grows with each ADR-1703 phase) ──────────────
const PROTECTED_RULES = [
  'no-path-literal-in-assert',
  'no-posix-mode-bit-assert',
  // Future phases: add new local/ portability rules here.
];

// ── Detect disable directives via the comment text ───────────────────────────

// The three directive forms ESLint recognises (built as concatenated strings so
// this source file contains NO real disable directive of its own).
const D = 'eslint-' + 'disable';
const DN = 'eslint-' + 'disable-next-line';
const DL = 'eslint-' + 'disable-line';
const DISABLE_PREFIXES = [DN, DL, D]; // longest first so prefix-match is greedy

/**
 * Classify a comment node.  Returns:
 *   'blanket'   — a disable with NO rule list (suppresses everything)
 *   'named'     — a disable that lists at least one protected portability rule
 *   null        — not a disable directive, or a non-portability named disable
 */
function classifyComment(commentValue) {
  const txt = commentValue.trim();
  for (const prefix of DISABLE_PREFIXES) {
    if (txt.startsWith(prefix)) {
      // Text after the directive keyword
      const rest = txt.slice(prefix.length).trim();
      // Blanket: nothing after the keyword, or only a prose comment (starts with --)
      if (!rest || rest.startsWith('--')) {
        return 'blanket';
      }
      // Named: rest is a comma-separated rule list (possibly with -- prose)
      const ruleList = rest.split('--')[0]; // strip trailing prose
      const rules = ruleList.split(',').map(r => r.trim()).filter(Boolean);
      for (const rule of rules) {
        for (const protected_ of PROTECTED_RULES) {
          if (rule === 'local/' + protected_ || rule === protected_) {
            return 'named';
          }
        }
      }
      return null; // named disable but not for a protected rule
    }
  }
  return null;
}

// ── Collect test files ────────────────────────────────────────────────────────

const SELF_ABS = __filename;

function collectTestFiles() {
  return globSync('tests/**/*.test.cjs', { cwd: path.join(__dirname, '..') })
    .map(rel => path.join(__dirname, '..', rel))
    .filter(absPath => absPath !== SELF_ABS);
}

// ── Scan ──────────────────────────────────────────────────────────────────────

function scanFile(absPath) {
  let src;
  try {
    src = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${absPath}: ${err.message}`);
  }

  let ast;
  try {
    ast = espree.parse(src, {
      comment: true,
      ecmaVersion: 2022,
      loc: true,
      range: true,
      tolerant: true,
    });
  } catch (parseErr) {
    // C5: fail CLOSED on parse error — a file that fails to parse must FAIL the
    // test with its path, not be silently skipped.  Silent skip is a false-green:
    // an unparseable test file could contain a real disable directive.
    throw new Error(`Parse error in ${absPath}: ${parseErr.message}`);
  }

  const blanket = [];
  const named = [];

  for (const cmt of ast.comments || []) {
    const kind = classifyComment(cmt.value);
    if (!kind) continue;
    const line = cmt.loc ? cmt.loc.start.line : '?';
    const entry = { file: absPath, line, text: cmt.value.trim() };
    if (kind === 'blanket') blanket.push(entry);
    else if (kind === 'named') named.push(entry);
  }

  return { blanket, named };
}

// ── C5: parse-error fail-closed ───────────────────────────────────────────────

describe('C5 — scanFile fails closed on parse error', () => {
  test('C5: scanFile throws on parse error instead of silently returning empty result', () => {
    // Inject a parse error deterministically by monkeypatching espree.parse.
    // This is the cross-platform approach (works under root/Docker too).
    const origParse = espree.parse;
    try {
      espree.parse = () => { throw new SyntaxError('injected parse error for C5 test'); };
      // Create a minimal real file to scan (use this test file itself, which exists).
      assert.throws(
        () => scanFile(__filename),
        (err) => {
          return err instanceof Error &&
            err.message.includes('injected parse error for C5 test');
        },
        'scanFile must throw on parse error, not silently return empty result'
      );
    } finally {
      espree.parse = origParse;
    }
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('portability-rule disable-ban (ADR-1703)', () => {
  const testFiles = collectTestFiles();

  test('test file enumeration finds at least 10 test files', () => {
    assert.ok(
      testFiles.length >= 10,
      `Expected at least 10 test files, got ${testFiles.length}`,
    );
  });

  test('no test file contains a named eslint-disable for a portability rule (category a)', () => {
    const offenders = [];
    for (const absPath of testFiles) {
      const { named } = scanFile(absPath);
      for (const o of named) {
        offenders.push(`${path.relative(path.join(__dirname, '..'), o.file)}:${o.line} — ${o.text}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Found inline disable directives suppressing protected portability rules.\n' +
      'These MUST be removed — the rule exists to enforce cross-platform safety:\n\n' +
      offenders.map(s => '  ' + s).join('\n'),
    );
  });

  test('no test file contains a blanket eslint-disable (category b — suppresses all rules including portability)', () => {
    const offenders = [];
    for (const absPath of testFiles) {
      const { blanket } = scanFile(absPath);
      for (const o of blanket) {
        offenders.push(`${path.relative(path.join(__dirname, '..'), o.file)}:${o.line} — ${o.text}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Found blanket eslint-disable directives in test files.\n' +
      'Blanket disables suppress ALL rules including portability rules and are banned.\n' +
      'Replace with targeted per-rule disables for non-portability rules, or remove:\n\n' +
      offenders.map(s => '  ' + s).join('\n'),
    );
  });
});

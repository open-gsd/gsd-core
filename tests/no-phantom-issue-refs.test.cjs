// allow-test-rule: runtime-contract-is-the-product (see #1073) — this guard asserts the
// ABSENCE of phantom pre-migration issue references in repo text (docs, tests,
// workflows). The file *content* is the product surface here (#1073): dangling
// refs like #2551/#3182 that don't exist in open-gsd/gsd-core (highest real
// issue is in the low thousands of the redux repo, not here) mislead triage and
// manufacture phantom blockers. This test fails CI if such a ref is reintroduced.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Phantom pre-migration (get-shit-done-redux) issue numbers with NO equivalent
// in open-gsd/gsd-core. Matched only with a leading '#' or in an issues/ URL so
// SSH key patterns like `id_ed25519` (which contain the digits "2551") are NOT
// false-positives.
const PHANTOM = ['2551', '3182', '2361'];
const REF_RE = new RegExp(
  '(?:#(?:' + PHANTOM.join('|') + ')\\b)|(?:issues/(?:' + PHANTOM.join('|') + ')\\b)',
);

const SCAN_EXT = new Set(['.md', '.cjs', '.js', '.cts', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.changeset']);
// This guard file itself names the phantom numbers (by necessity); exclude it.
const SELF = path.relative(ROOT, __filename);

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

test('no phantom pre-migration issue references remain in repo text (#1073)', () => {
  const offenders = [];
  for (const file of walk(ROOT, [])) {
    const rel = path.relative(ROOT, file);
    if (rel === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (REF_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.strictEqual(
    offenders.length,
    0,
    `Phantom issue refs (${PHANTOM.map((n) => '#' + n).join('/')}) found — repoint to a real ` +
      `successor (#717/#720) or rewrite as prose (see #1073):\n` + offenders.join('\n'),
  );
});

// allow-test-rule: source-text-is-the-product
// localized INVENTORY prose is the shipped doc surface being locked
'use strict';

/**
 * #5601: the localized INVENTORY "coverage note" hard-coded agent counts that
 * drifted from docs/AGENTS.md. The English docs/INVENTORY.md states no counts,
 * so the localized pages must not either (DEFECT.INVENTORY-MERGE-UNDERCOUNT
 * class: counts in shared prose go stale silently).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const LOCALES = fs
  .readdirSync(DOCS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(DOCS, d.name, 'INVENTORY.md')))
  .map((d) => d.name);

function lines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

test('localized INVENTORY coverage note states no hard agent counts', () => {
  assert.ok(LOCALES.length > 0, 'expected at least one localized INVENTORY');
  for (const locale of LOCALES) {
    const note = lines(path.join(DOCS, locale, 'INVENTORY.md')).find(
      (l) => l.includes('docs/AGENTS.md') && l.includes('agents/gsd-*.md'),
    );
    if (!note) continue;
    assert.doesNotMatch(note, /\d/, `${locale}/INVENTORY.md coverage note contains a number: ${note}`);
  }
});

test('localized docs do not link the retired count-bearing INVENTORY anchor', () => {
  const offenders = [];
  for (const locale of LOCALES) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md') && /INVENTORY\.md#agents-\d+-shipped/.test(fs.readFileSync(p, 'utf8'))) {
          offenders.push(path.relative(DOCS, p));
        }
      }
    };
    walk(path.join(DOCS, locale));
  }
  assert.deepEqual(offenders, []);
});

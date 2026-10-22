'use strict';

/**
 * #5601: the localized INVENTORY "coverage note" and the localized
 * multi-agent-orchestration / ARCHITECTURE cross-references hard-coded agent
 * counts that drifted from docs/AGENTS.md. The English docs/INVENTORY.md
 * states none, so the localized pages must not either.
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

function coverageNote(locale) {
  const text = fs.readFileSync(path.join(DOCS, locale, 'INVENTORY.md'), 'utf8');
  return text
    .split(/\r?\n/)
    .find((l) => l.includes('`docs/AGENTS.md`') && l.includes('`agents/gsd-*.md`'));
}

test('localized INVENTORY pages exist to be checked', () => {
  assert.ok(LOCALES.length >= 4, `expected ja-JP, ko-KR, pt-BR, zh-CN; found ${LOCALES.join(', ')}`);
});

test('every localized INVENTORY has a coverage note that states no agent counts', () => {
  for (const locale of LOCALES) {
    const note = coverageNote(locale);
    assert.ok(note, `${locale}/INVENTORY.md: coverage note not found (reworded? update this locator)`);
    const prose = note.replace(/`[^`]*`/g, '');
    assert.doesNotMatch(prose, /\d/, `${locale}/INVENTORY.md coverage note states a count: ${note}`);
  }
});

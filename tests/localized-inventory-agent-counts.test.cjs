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

function slugOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

test('localized INVENTORY section headings carry no "(N shipped)" count', () => {
  for (const locale of LOCALES) {
    const offenders = fs
      .readFileSync(path.join(DOCS, locale, 'INVENTORY.md'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^##\s+.+\(\d+[^)]*\)\s*$/.test(l));
    assert.deepEqual(offenders, [], `${locale}/INVENTORY.md headings carry counts`);
  }
});

test('every localized link to its INVENTORY.md#anchor resolves to a heading', () => {
  for (const locale of LOCALES) {
    const inventory = path.join(DOCS, locale, 'INVENTORY.md');
    const slugs = new Set(
      fs
        .readFileSync(inventory, 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^#{1,6}\s/.test(l))
        .map((l) => slugOf(l.replace(/^#+\s+/, ''))),
    );
    const dead = [];
    for (const file of markdownFiles(path.join(DOCS, locale))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/((?:\.\.\/|\.\/){0,8}INVENTORY\.md)#([^)\s]{1,200})/g)) {
        if (path.resolve(path.dirname(file), m[1]) !== inventory) continue;
        if (!slugs.has(decodeURIComponent(m[2]))) dead.push(`${path.relative(DOCS, file)} -> #${m[2]}`);
      }
    }
    assert.deepEqual(dead, [], `${locale}: links to INVENTORY.md anchors that match no heading`);
  }
});

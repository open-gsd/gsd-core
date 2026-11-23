'use strict';

// The localized INVENTORY pages (docs/<locale>/INVENTORY.md) hard-coded agent counts that drifted from
// docs/reference/agents.md (#5601); the English docs/INVENTORY.md states none, so the localized pages must not
// either: each has a coverage note without a digit, no `## ... (N ...)` section heading, and every link to its
// INVENTORY.md#anchor from the locale resolves to a heading slug. At least four locales must exist to be checked.
// Was tests/localized-inventory-agent-counts.test.cjs.

const path = require('node:path');

const MIN_LOCALES = 4;

const slugOf = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

module.exports = {
  id: 'localized-inventory-agent-counts',
  issue: '#5601',
  check(ctx) {
    // docs/<locale>/INVENTORY.md, one level down (the test took the directories of docs/ that carry one).
    const inventories = ctx.list('docs', 'INVENTORY.md', 'the localized inventories are what the counts are checked on')
      .filter((rel) => rel.endsWith('/INVENTORY.md') && rel.split('/').length === 3);
    // The English inventory is the page the localized ones mirror, so it carries the count of how many were found.
    ctx.doc('docs/INVENTORY.md').satisfies(
      () => inventories.length >= MIN_LOCALES || `found ${inventories.length}: ${inventories.join(', ')}`,
      `at least ${MIN_LOCALES} localized INVENTORY pages (ja-JP, ko-KR, pt-BR, zh-CN) must exist to be checked`,
    );

    for (const inventoryRel of inventories) {
      const locale = inventoryRel.split('/')[1];
      const inventory = ctx.doc(inventoryRel);

      inventory.satisfies((text) => {
        const note = text.split('\n').find((line) => line.includes('`docs/reference/agents.md`') && line.includes('`agents/gsd-*.md`'));
        if (!note) return 'the coverage note was not found (reworded? update this locator)';
        return !/\d/.test(note.replace(/`[^`]{0,500}`/g, '')) || `the coverage note states a count: ${note}`;
      }, `${locale}/INVENTORY.md must have a coverage note that states no agent counts`);

      inventory.satisfies((text) => {
        const offenders = text.split('\n').filter((line) => /^##\s{1,20}.{1,500}\(\d{1,6}[^)]{0,200}\)\s{0,20}$/.test(line));
        return offenders.length === 0 || offenders.join('; ');
      }, `${locale}/INVENTORY.md section headings must carry no "(N shipped)" count`);

      // Every link to this locale's INVENTORY.md#anchor from a page of the locale resolves to a heading.
      const slugs = new Set(inventory.text.split('\n').filter((line) => /^#{1,6}\s/.test(line)).map((line) => slugOf(line.replace(/^#{1,6}\s/, ''))));
      for (const rel of ctx.list(`docs/${locale}`, '.md', 'the locale pages are what the anchors are checked on')) {
        ctx.doc(rel).satisfies((text) => {
          const dead = [];
          for (const match of text.matchAll(/((?:\.\.\/|\.\/){0,8}INVENTORY\.md)#([^)\s]{1,200})/g)) {
            if (path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1])) !== inventoryRel) continue;
            let anchor;
            try {
              anchor = decodeURIComponent(match[2]);
            } catch {
              dead.push(`#${match[2]} (not a decodable anchor)`);
              continue;
            }
            if (!slugs.has(anchor)) dead.push(`#${match[2]}`);
          }
          return dead.length === 0 || dead.join(', ');
        }, `${locale}: a link to an INVENTORY.md anchor that matches no heading`);
      }
    }
  },
};

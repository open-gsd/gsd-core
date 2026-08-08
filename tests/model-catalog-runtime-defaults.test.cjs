// allow-test-rule: source-text-is-the-product
// These docs tables are the shipped operator surface for runtime model tiers.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { catalog, KNOWN_RUNTIMES } = require('../gsd-core/bin/lib/model-catalog.cjs');
const { allRuntimes } = require('../bin/install.js');

const ROOT = path.join(__dirname, '..');
const SETTINGS_ADVANCED = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'settings-advanced.md'), 'utf8');
const CONFIG_DOC = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIGURATION.md'), 'utf8');
const catalogPath = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'model-catalog.json');
const CATALOG_RAW = fs.readFileSync(catalogPath, 'utf8');

// The ID this PR (#2683) supersedes on the claude opus tier. It must survive
// only in the providerPresets `medium` rung, never in a runtime-defaults row.
const SUPERSEDED_OPUS_ID = 'claude-opus-4-8';

// Pull the single markdown row whose first backtick-wrapped cell is `${runtime}`
// from the runtime-defaults table, located by its `anchor` heading (the doc has
// other `| `claude` |`-shaped rows, e.g. the effort table). Anchored at line
// start so a `anthropic/claude-...` model cell can never be mistaken for a
// runtime cell.
function runtimeRow(doc, anchor, runtime) {
  const start = doc.indexOf(anchor);
  if (start < 0) return null;
  const region = doc.slice(start);
  const re = new RegExp('^\\|\\s*`' + runtime + '`\\s*\\|.*$', 'm');
  const m = region.match(re);
  return m ? m[0] : null;
}

// Backtick-wrapped tokens in row order: [runtime, opus, sonnet, haiku, ...effort].
function backtickCells(row) {
  return [...row.matchAll(/`([^`]+)`/g)].map(x => x[1]);
}

// Pull the three tier cells (opus|sonnet|haiku, in that column order) from the
// providerPresets budget-tier table for a given (provider, budget) row.
function budgetRowCells(doc, provider, budget) {
  const re = new RegExp('^\\|\\s*' + provider + '\\s*\\|\\s*' + budget + '\\s*\\|(.+)$', 'm');
  const m = doc.match(re);
  if (!m) return null;
  return m[1].split('|').map(s => s.trim()).filter(Boolean);
}

describe('model catalog runtime defaults parity (#3229)', () => {
  test('known runtimes include hermes and match catalog keys', () => {
    assert.ok(KNOWN_RUNTIMES.has('hermes'));
    assert.ok(KNOWN_RUNTIMES.has('kimi'));
    assert.deepStrictEqual([...KNOWN_RUNTIMES].sort(), Object.keys(catalog.runtimeTierDefaults).sort());
  });

  test('installer-supported runtimes are all known to the model catalog', () => {
    assert.deepStrictEqual([...allRuntimes].sort(), [...KNOWN_RUNTIMES].sort());
  });

  // Row-exact, not whole-file substring: the earlier `includes(model)` guard
  // passed as long as an ID appeared ANYWHERE in the doc, so it could not catch
  // a half-swept table or a stale ID left in the wrong runtime's row.
  const RUNTIME_TABLES = [
    ['settings-advanced.md', SETTINGS_ADVANCED, 'Built-in tier defaults by runtime:'],
    ['CONFIGURATION.md', CONFIG_DOC, 'Built-in tier maps:'],
  ];
  for (const [docName, DOC, anchor] of RUNTIME_TABLES) {
    test(`${docName} runtime defaults table row-matches catalog exactly`, () => {
      for (const [runtime, tiers] of Object.entries(catalog.runtimeTierDefaults)) {
        if (!tiers.opus) continue; // Group B runtimes intentionally have no built-ins
        const row = runtimeRow(DOC, anchor, runtime);
        assert.ok(row, `${docName} missing ${runtime} row`);
        const cells = backtickCells(row);
        assert.equal(cells[0], runtime, `${docName} ${runtime} row: first cell must be the runtime name`);
        const aliases = ['opus', 'sonnet', 'haiku'];
        aliases.forEach((alias, i) => {
          const entry = tiers[alias];
          assert.ok(entry?.model, `${runtime}.${alias} missing model in catalog`);
          assert.equal(
            cells[i + 1],
            entry.model,
            `${docName} ${runtime}.${alias} cell must equal catalog (${entry.model})`,
          );
        });
        assert.ok(
          !row.includes(SUPERSEDED_OPUS_ID),
          `${docName} ${runtime} row must not carry the superseded ${SUPERSEDED_OPUS_ID}`,
        );
      }
    });
  }

  // The guard that would have caught M2: every providerPresets cell (each
  // provider x budget x tier) must equal the budget-tier table in
  // settings-advanced.md. Table columns high|medium|low map to tiers
  // opus|sonnet|haiku in that order.
  test('providerPresets budget-tier table in settings-advanced matches catalog exactly (#2683)', () => {
    const tierByColumn = ['opus', 'sonnet', 'haiku'];
    for (const [provider, tierMap] of Object.entries(catalog.providerPresets)) {
      // Skip fully-null providers (e.g. `generic`) — no concrete row to check.
      const hasConcrete = Object.values(tierMap)
        .some(byBudget => Object.values(byBudget).some(v => v && v.model));
      if (!hasConcrete) continue;
      for (const budget of ['high', 'medium', 'low']) {
        const cells = budgetRowCells(SETTINGS_ADVANCED, provider, budget);
        assert.ok(cells, `settings-advanced.md missing "${provider} | ${budget}" budget row`);
        assert.equal(cells.length, 3, `"${provider} | ${budget}" row must have 3 tier cells, got ${cells.length}`);
        tierByColumn.forEach((tier, i) => {
          const expected = tierMap[tier][budget].model;
          assert.equal(
            cells[i],
            expected,
            `"${provider} | ${budget}" ${tier} cell (column ${i + 1}) must equal catalog (${expected})`,
          );
        });
      }
    }
  });

  test('Group B runtimes remain documented as having no built-in defaults', () => {
    const groupB = Object.keys(catalog.runtimeTierDefaults)
      .filter(runtime => !catalog.runtimeTierDefaults[runtime].opus);
    assert.ok(groupB.length > 0, 'expected at least one Group B runtime in catalog');
    for (const runtime of groupB) {
      const tiers = catalog.runtimeTierDefaults[runtime];
      assert.equal(tiers.opus, null);
      assert.equal(tiers.sonnet, null);
      assert.equal(tiers.haiku, null);
    }
    assert.ok(SETTINGS_ADVANCED.includes('Group B'));
    assert.ok(CONFIG_DOC.includes('Group B'));
  });

  test('catalog contains no retired/invalid model IDs', () => {
    // Retired per issue #779 verify-first audit (gemini-cli source + OpenAI Codex models page).
    const RETIRED = ['"gemini-3-pro"', '"gpt-5.3-codex"'];
    for (const id of RETIRED) {
      assert.ok(!CATALOG_RAW.includes(id), `retired model ID ${id} must not appear in model-catalog.json (see #779)`);
    }
  });
});

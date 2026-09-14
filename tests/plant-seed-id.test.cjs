// allow-test-rule: source-text-is-the-product (#4378)
// gsd-core/workflows/plant-seed.md is runtime-loaded text — the workflow IS its
// markdown. Asserting on the shipped `generate-seed-id` and `parse-idea` text
// tests the deployed contract (the alternative — executing cross-worktree
// collisions end-to-end — is not reproducible in a single checkout).

'use strict';

/**
 * Writer-contract tests for seed id generation (#4378).
 *
 * Defect: plant-seed.md derived the next seed id from `ls | wc -l` — a count of
 * files the local worktree happens to see. Two workstreams planting before
 * either merges computed the same id and git merged both files silently.
 *
 * Contract shipped by the fix:
 *   1. `generate-seed-id` derives `SEED-YYMMDD-xxx` from the local date plus a
 *      3-char random base36 suffix — computable in one worktree alone, with a
 *      same-day regen guard — and NO shared counter remains.
 *   2. The `parse-idea` enrich pattern accepts the new-format id in full (and
 *      legacy `SEED-NNN` still resolves) — writer and reader grammars must not
 *      diverge (the reader grammar is pinned behaviorally in
 *      tests/list-seeds.test.cjs / .property.test.cjs on the SAME sample ids).
 *   3. No counting-era placeholder (`SEED-{PADDED}`) survives anywhere in the
 *      file — a stale placeholder would write malformed ids at runtime.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLANT_SEED_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'plant-seed.md');

function readPlantSeedNormalized() {
  const src = fs.readFileSync(PLANT_SEED_PATH, 'utf8');
  return src.replace(/\r\n/g, '\n');
}

/** Extract the body of a named <step> block, or throw naming the missing step. */
function stepBlock(src, stepName) {
  const start = src.indexOf(`<step name="${stepName}">`);
  assert.ok(start !== -1, `plant-seed.md must contain <step name="${stepName}">`);
  const end = src.indexOf('</step>', start);
  assert.ok(end !== -1, `<step name="${stepName}"> must be closed`);
  return src.slice(start, end);
}

describe('plant-seed id contract (#4378)', () => {
  const src = readPlantSeedNormalized();

  test('generate-seed-id derives the id from local date + random, never a shared count (#4378)', () => {
    const block = stepBlock(src, 'generate-seed-id');

    // Date component: local YYMMDD.
    assert.match(
      block,
      /date \+%y%m%d/,
      'generate-seed-id must derive the date part via `date +%y%m%d`'
    );

    // Random base36 suffix: exactly 3 chars of [a-z0-9]. urandom is present on
    // every supported platform (macOS, Linux, Git Bash); if it is ever absent
    // the redirect fails loudly rather than minting a silent empty suffix.
    assert.match(
      block,
      /tr -dc 'a-z0-9'/,
      'generate-seed-id must draw the suffix from [a-z0-9] (base36)'
    );
    assert.match(
      block,
      /head -c 3/,
      'generate-seed-id must take exactly 3 random characters'
    );
    assert.match(
      block,
      /SEED-\$\{?SEED_DATE\}?-\$\{?SEED_SUFX\}?|SEED-\$\(date \+%y%m%d\)-\$\(/,
      'generate-seed-id must assemble SEED-<date>-<suffix>'
    );

    // Same-day regen guard: a 1-in-46656 local collision must be visible and
    // retried, not shipped silently.
    assert.match(
      block,
      /ls \.planning\/seeds\/\$\{SEED_ID\}-\*\.md/,
      'generate-seed-id must check the freshly drawn id against existing same-day seeds'
    );

    // The shared counter must be GONE — every counting idiom of the old step.
    assert.doesNotMatch(block, /wc -l/, 'the `wc -l` counter must not remain');
    assert.doesNotMatch(
      block,
      /NEXT=\$\(\(EXISTING/,
      'the `NEXT=$((EXISTING + 1))` derivation must not remain'
    );
    assert.doesNotMatch(
      src,
      /printf "%03d" \$NEXT/,
      'the `%03d` padding of the counted id must not remain anywhere in the file'
    );
  });

  test('enrich flag parsing accepts legacy and new-format ids (#4378)', () => {
    const block = stepBlock(src, 'parse-idea');
    const m = block.match(/grep -oE '([^']+)'/);
    assert.ok(m, 'parse-idea must extract ENRICH_TARGET via `grep -oE`');
    const pattern = m[1];

    // The pattern is executed by grep -E at runtime; exercise the same grammar
    // through the JS regex engine (the constructs used are common to both).
    const re = new RegExp(pattern);

    // New-format id: the FULL id must be captured, never truncated at the date.
    const newMatch = '--seed --enrich SEED-260914-k3x'.match(re);
    assert.ok(newMatch, 'pattern must match a new-format id');
    assert.strictEqual(
      newMatch[0],
      'SEED-260914-k3x',
      'the captured ENRICH_TARGET must be the complete new-format id'
    );

    // Legacy id: still resolves, still captured whole.
    const legacyMatch = '--seed --enrich SEED-081'.match(re);
    assert.ok(legacyMatch, 'pattern must match a legacy id');
    assert.strictEqual(legacyMatch[0], 'SEED-081');
  });

  test('no counting-era placeholder remains (#4378)', () => {
    assert.doesNotMatch(
      src,
      /SEED-\{PADDED\}/,
      'the SEED-{PADDED} placeholder would write malformed ids at runtime; write-seed/confirm must use {SEED_ID}'
    );
    assert.match(src, /\{SEED_ID\}/, 'write-seed/confirm must reference {SEED_ID}');
  });
});

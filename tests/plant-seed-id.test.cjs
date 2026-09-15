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
 *      3-char random base36 suffix — computable in one worktree alone — with a
 *      loud failure when the suffix cannot be drawn, a same-day regen guard,
 *      and NO shared counter.
 *   2. The `parse-idea` enrich pattern is anchored to the `--enrich` flag and
 *      captures the COMPLETE id, uppercase-tolerant (legacy `SEED-NNN` still
 *      resolves) — writer and reader grammars must not diverge (the reader
 *      grammar is pinned behaviorally in tests/list-seeds.test.cjs /
 *      .property.test.cjs on the SAME sample ids, and the parity property at
 *      the bottom of this file proves every id the writer grammar can mint
 *      round-trips through the reader). A truncated or ambiguous target fails
 *      closed instead of enriching an arbitrary same-day seed.
 *   3. No counting-era placeholder (`SEED-{PADDED}`) survives anywhere in the
 *      file — a stale placeholder would write malformed ids at runtime.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const ROOT = path.join(__dirname, '..');
const PLANT_SEED_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'plant-seed.md');

// allow-test-rule: source-text-is-the-product (#4378)
// The readFileSync below is the marker's suppression site: plant-seed.md is
// runtime-loaded text — the workflow IS its markdown — so asserting on the
// shipped `generate-seed-id` and `parse-idea` text tests the deployed contract
// (the alternative — executing cross-worktree collisions end-to-end — is not
// reproducible in a single checkout).
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
    // every supported platform (macOS, Linux, Git Bash). `tr` reads an infinite
    // stream, so the pipeline takes a harmless SIGPIPE once `head -c` has its
    // bytes — `|| true` keeps that from aborting the step under pipefail.
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
      /\|\| true/,
      'the suffix draw must tolerate the expected SIGPIPE under pipefail'
    );
    // A missing /dev/urandom must fail LOUDLY, not mint `SEED-<date>-` (whose
    // ids would all collapse to the bare date — the #4378 collision reborn).
    assert.match(
      block,
      /\[ \$\{#SEED_SUFFIX\} -ne 3 \]/,
      'the drawn suffix must be length-checked; an empty suffix must abort the step'
    );
    assert.match(
      block,
      /could not draw a random id suffix/,
      'the empty-suffix abort must say so on stderr'
    );
    assert.match(
      block,
      /SEED-\$\{SEED_DATE\}-\$\{SEED_SUFFIX\}/,
      'generate-seed-id must assemble SEED-<date>-<suffix>'
    );

    // Same-day regen guard — as a find existence test, never `ls <glob>`
    // (under a stray nullglob that shape silently degenerates: #3409 drift
    // guard, Detector B) — with a loud terminal failure if the retry also
    // collides.
    assert.match(
      block,
      /find \.planning\/seeds -maxdepth 1 -name "\$\{SEED_ID\}-\*\.md"/,
      'generate-seed-id must check the freshly drawn id against existing same-day seeds via find'
    );
    assert.match(
      block,
      /could not draw an unused seed id/,
      'a regen retry that also collides must abort loudly, not ship a duplicate'
    );
    assert.doesNotMatch(
      block,
      /ls .*SEED_ID.*\*\.md/,
      'the regen guard must not use the `ls <glob>` shape (#3409 Detector B)'
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

  test('enrich flag parsing is flag-anchored, complete, and uppercase-tolerant (#4378)', () => {
    const block = stepBlock(src, 'parse-idea');
    const m = block.match(/grep -oE '([^']+)'/);
    assert.ok(m, 'parse-idea must extract the enrich target via `grep -oE`');
    const pattern = m[1];

    // The extraction must be ANCHORED to the --enrich flag: a leftmost
    // `SEED-[0-9]+` would grab a seed id mentioned anywhere in $ARGUMENTS
    // instead of the one the flag names (#4378 review).
    assert.match(
      pattern,
      /\\-\\-enrich/,
      'the extractor pattern must anchor on the --enrich flag'
    );
    // The pattern is executed by grep -E at runtime; exercise the same grammar
    // through the JS regex engine, translating the one POSIX class grep
    // understands and JS does not (`[[:space:]]` -> `[ \t]`).
    const jsPattern = pattern.replace(/\[\[:space:\]\]/g, '[ \\t]');
    const re = new RegExp(jsPattern);
    const targetOf = (args) => {
      const match = args.match(re);
      assert.ok(match, `pattern must match: ${args}`);
      return match[0].replace(/^.*[ \t]/, '');
    };

    // New-format id: the FULL id must be captured, never truncated at the date
    // — and uppercase-tolerant, since the docs display SEED-YYMMDD-XXX.
    assert.strictEqual(
      targetOf('--seed --enrich SEED-260914-K3X'),
      'SEED-260914-K3X',
      'an uppercase new-format id must be captured in full'
    );
    assert.strictEqual(
      targetOf('--seed --enrich SEED-260914-k3x'),
      'SEED-260914-k3x',
      'a lowercase new-format id must be captured in full'
    );
    // Legacy id: still resolves, still captured whole.
    assert.strictEqual(targetOf('--seed --enrich SEED-081'), 'SEED-081');

    // A seed id mentioned in the idea text must NOT be picked up when the flag
    // names a different seed.
    assert.strictEqual(
      targetOf('"see SEED-5 first" --enrich SEED-7'),
      'SEED-7',
      'the extractor must follow the --enrich flag, not the leftmost id'
    );

    // Truncated/ambiguous targets fail closed instead of enriching an
    // arbitrary same-day seed (`head -1` over a date glob).
    assert.match(
      block,
      /matches multiple seed files/,
      'a target matching several seed files must fail closed, naming the files'
    );
    assert.match(
      block,
      /no seed file matches/,
      'a target matching no seed file must fail closed instead of falling back'
    );
    assert.match(
      block,
      /-gt 1/,
      'the ambiguity check must compare the match count, not take head -1'
    );
  });

  test('no counting-era placeholder remains (#4378)', () => {
    assert.doesNotMatch(
      src,
      /SEED-\{PADDED\}/,
      'the SEED-{PADDED} placeholder would write malformed ids at runtime; write-seed/confirm must use {SEED_ID}'
    );
    assert.match(src, /\{SEED_ID\}/, 'write-seed/confirm must reference {SEED_ID}');
  });

  test('parity: every id the writer grammar can mint round-trips through the reader (#4378)', () => {
    // The writer (plant-seed.md generate-seed-id) and the reader
    // (deriveSeedIdentity) are parallel surfaces owning one grammar — per
    // CLAUDE.md's generative-fix rule their agreement must be ASSERTED, not
    // assumed. The widths are parsed out of the shipped MINT sites (the
    // `date +%y%m%d` directive and the `head -c N` draw) so a width drift on
    // either side fails here. (The enrich matcher is deliberately wider — it
    // must also accept legacy `SEED-NNN` — so it is not the parity source.)
    const { deriveSeedIdentity } = require('../gsd-core/bin/lib/commands.cjs');
    const genBlock = stepBlock(src, 'generate-seed-id');
    const suffixWidth = Number(genBlock.match(/head -c (\d+)/)?.[1]);
    const dateFormat = genBlock.match(/date \+(\S+)/)?.[1] ?? '';
    const dateWidth = (dateFormat.match(/%[ymd]/g) ?? []).length * 2;
    assert.ok(dateWidth > 0, 'writer mint block must declare the date format via %y%m%d');
    assert.ok(suffixWidth > 0, 'writer mint block must declare the suffix width via head -c N');

    const digits = fc.integer({ min: 0, max: 10 ** dateWidth - 1 })
      .map((n) => String(n).padStart(dateWidth, '0'));
    const base36 = fc.tuple(
      ...Array.from({ length: suffixWidth }, () =>
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')))
    ).map((parts) => parts.join(''));

    fc.assert(
      fc.property(digits, base36, fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/), (date, suf, slug) => {
        const id = `SEED-${date}-${suf}`;
        const result = deriveSeedIdentity(`${id}-${slug}`, id);
        assert.strictEqual(result.seed_id, id, `reader must accept the writer's id ${id}`);
        assert.strictEqual(result.slug, slug);
      }),
      { numRuns: 200 }
    );
  });
});

'use strict';

/**
 * Property-based tests for the seed-identity derivation behind `list-seeds` (#441).
 *
 * Module: gsd-core/bin/lib/commands.cjs
 * Exported (pure): deriveSeedIdentity(stem, rawFmId) -> { seed_id, slug }
 *
 * The `SEED-NNN-<slug>.md` filename + frontmatter `id:` -> `{ seed_id, slug }`
 * mapping is a parsing/transformation contract, so per RULESET.TESTS.property-based-testing
 * it carries property coverage in addition to the example-based branch tests.
 *
 * Properties tested:
 *   (a) never throws on arbitrary (string | non-string) input
 *   (b) always returns string seed_id and slug
 *   (c) canonical case: id `SEED-NNN` + stem `SEED-NNN-<slug>` => seed_id === id, slug === <slug>
 *   (d) no usable frontmatter id => seed_id falls back to the filename's `SEED-NNN` prefix
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { deriveSeedIdentity } = require('../gsd-core/bin/lib/commands.cjs');

// SEED number: 1+ digits, no leading-zero constraint (filenames are zero-padded
// but the parser is agnostic — \d+ matches either way).
const seedNum = fc.integer({ min: 1, max: 99999 }).map((n) => String(n));
// Slug remainder: leading alphanumeric then the usual filename-safe set, no slashes.
const slug = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,30}$/);

describe('list-seeds: deriveSeedIdentity properties', () => {
  // (a) Never throws — including non-string frontmatter ids (arrays, objects, undefined).
  test('property: deriveSeedIdentity never throws on arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.oneof(fc.string({ maxLength: 40 }), fc.array(fc.string()), fc.object(), fc.constant(undefined)),
        (stem, rawFmId) => {
          assert.doesNotThrow(() => deriveSeedIdentity(stem, rawFmId));
        }
      )
    );
  });

  // (b) Always returns string fields — the JSON contract never leaks a non-string.
  test('property: deriveSeedIdentity always returns string seed_id and slug', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.oneof(fc.string({ maxLength: 40 }), fc.array(fc.string()), fc.constant(undefined)),
        (stem, rawFmId) => {
          const { seed_id, slug: derivedSlug } = deriveSeedIdentity(stem, rawFmId);
          assert.strictEqual(typeof seed_id, 'string');
          assert.strictEqual(typeof derivedSlug, 'string');
        }
      )
    );
  });

  // (c) Canonical: matching frontmatter id wins for seed_id; slug is the filename remainder.
  test('property: id `SEED-NNN` + stem `SEED-NNN-<slug>` => seed_id === id, slug === <slug>', () => {
    fc.assert(
      fc.property(seedNum, slug, (n, s) => {
        const id = `SEED-${n}`;
        const stem = `SEED-${n}-${s}`;
        const result = deriveSeedIdentity(stem, id);
        assert.strictEqual(result.seed_id, id);
        assert.strictEqual(result.slug, s);
      })
    );
  });

  // (d) No usable frontmatter id => seed_id falls back to the filename's numeric prefix.
  test('property: missing/non-string id => seed_id falls back to the `SEED-NNN` filename prefix', () => {
    fc.assert(
      fc.property(
        seedNum,
        slug,
        fc.oneof(fc.constant(undefined), fc.constant(''), fc.array(fc.string()), fc.constant('not-a-seed-id')),
        (n, s, badId) => {
          const stem = `SEED-${n}-${s}`;
          const result = deriveSeedIdentity(stem, badId);
          assert.strictEqual(result.seed_id, `SEED-${n}`);
          assert.strictEqual(result.slug, s);
        }
      )
    );
  });

  // ── #4378: the new-format grammar `SEED-YYMMDD-xxx` (date + 3 base36 chars) ──

  // New-format short suffix: exactly 6 digits, hyphen, exactly 3 lowercase base36.
  const seedDate = fc.integer({ min: 0, max: 99 })
    .map((n) => String(n).padStart(2, '0'))
    .chain((yy) =>
      fc.integer({ min: 1, max: 12 }).map((m) => yy + String(m).padStart(2, '0'))
        .chain((ym) =>
          fc.integer({ min: 1, max: 31 }).map((d) => ym + String(d).padStart(2, '0'))
        )
    );
  const seedSuffix = fc.tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  ).map(([a, b, c]) => a + b + c);

  // (e) Canonical new format: frontmatter id wins; slug is the filename remainder.
  test('property: new-format id `SEED-YYMMDD-xxx` round-trips (#4378)', () => {
    fc.assert(
      fc.property(seedDate, seedSuffix, slug, (date, suf, s) => {
        const id = `SEED-${date}-${suf}`;
        const stem = `${id}-${s}`;
        const result = deriveSeedIdentity(stem, id);
        assert.strictEqual(result.seed_id, id);
        assert.strictEqual(result.slug, s);
      })
    );
  });

  // (f) The filename-prefix fallback must keep the FULL new-format id. Truncating
  // at `SEED-<digits>` (the date) gives every same-day seed the same id — the
  // exact ambiguity #4378 files.
  test('property: missing id falls back to the full new-format prefix (#4378)', () => {
    fc.assert(
      fc.property(
        seedDate,
        seedSuffix,
        slug,
        fc.oneof(fc.constant(undefined), fc.constant(''), fc.constant(42)),
        (date, suf, s, badId) => {
          const stem = `SEED-${date}-${suf}-${s}`;
          const result = deriveSeedIdentity(stem, badId);
          assert.strictEqual(result.seed_id, `SEED-${date}-${suf}`);
          assert.strictEqual(result.slug, s);
        }
      )
    );
  });

  // (g) Width boundaries — the new grammar is exactly 6 digits + exactly 3
  // base36 chars; off-by-one widths must resolve through the documented
  // grammar branches, never by mis-parsing as a different seed's id
  // (CLAUDE.md: boundary coverage at limit-1 / limit / limit+1). Verified
  // against the real module: the SLUG regex's alternation backtracks to the
  // legacy branch whenever the canonical branch cannot complete, so the slug
  // is always the remainder after the legacy numeric prefix for these
  // off-grammar stems.
  describe('width boundaries (limit-1 / limit+1 vs the new grammar)', () => {
    test('5-digit date (limit-1) parses as legacy', () => {
      const r = deriveSeedIdentity('SEED-26091-k3x-slug', 'SEED-26091');
      assert.strictEqual(r.seed_id, 'SEED-26091');
      assert.strictEqual(r.slug, 'k3x-slug');
    });

    test('7-digit date (limit+1) parses as legacy (the 7th digit breaks the {6}-dash anchor)', () => {
      const r = deriveSeedIdentity('SEED-2609147-k3x-slug', 'SEED-2609147');
      assert.strictEqual(r.seed_id, 'SEED-2609147');
      assert.strictEqual(r.slug, 'k3x-slug');
    });

    test('4-char suffix (limit+1): canonical frontmatter wins; without frontmatter the id prefix absorbs exactly 3 suffix chars', () => {
      // Off-grammar input is never minted by the writer (it length-checks the
      // draw), so this pins the parser's documented greedy-then-legacy
      // behavior rather than a contract the writer can produce.
      assert.deepStrictEqual(
        deriveSeedIdentity('SEED-260914-k3xy-slug', 'SEED-260914'),
        { seed_id: 'SEED-260914', slug: 'k3xy-slug' }
      );
      assert.deepStrictEqual(
        deriveSeedIdentity('SEED-260914-k3xy-slug', ''),
        { seed_id: 'SEED-260914-k3x', slug: 'k3xy-slug' },
        'the prefix fallback has no trailing anchor, so the new-format branch absorbs exactly 3 suffix chars; the slug regex backtracks to legacy and keeps the whole remainder'
      );
    });

    test('2-char suffix (limit-1) never parses as new-format', () => {
      const withFm = deriveSeedIdentity('SEED-260914-k3', 'SEED-260914-k3');
      assert.strictEqual(withFm.seed_id, 'SEED-260914',
        'a frontmatter id matching NO grammar is ignored; the filename fallback applies');
      assert.strictEqual(withFm.slug, 'k3');
      const noFm = deriveSeedIdentity('SEED-260914-k3', '');
      assert.strictEqual(noFm.seed_id, 'SEED-260914');
      assert.strictEqual(noFm.slug, 'k3');
    });

    test('property: a 5-digit date (below the {6} width) always resolves to the legacy numeric prefix', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10000, max: 99999 }), // 5-digit date, below {6}
          fc.stringMatching(/^[a-z0-9]{2}([a-z0-9])?$/), // 2 or 4 suffix chars
          slug,
          (date, suf, s) => {
            const stem = `SEED-${date}-${suf}-${s}`;
            const r = deriveSeedIdentity(stem, '');
            assert.strictEqual(r.seed_id, `SEED-${date}`,
              'a short date can never start a new-format id');
          }
        )
      );
    });
  });
});

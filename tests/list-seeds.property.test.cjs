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
});

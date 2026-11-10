'use strict';

/**
 * Property-based tests for the raw STATE.md write check's rule (#5120).
 *
 * Module: scripts/raw-state-write-guard.cjs
 * Rule:   classifyStateWrite({ destination, source, callerFile, viaSeam })
 *
 * The rule is a classification surface (TESTING-STANDARDS "Property-based
 * testing tier"): three predicates over paths decide whether a write is
 * recorded at all and, when it is, whether it is a violation. The example
 * rows in tests/raw-state-write-guard.test.cjs pin named cases; the
 * properties below state the contract over generated paths, with POSIX and
 * Windows separators mixed freely inside one path.
 *
 * Properties:
 *   (a) basename: a destination whose last segment is not exactly `STATE.md`
 *       is never recorded, whatever the caller, source or viaSeam
 *   (b) caller: a STATE.md destination from a caller that is not product code
 *       (no `gsd-core` segment directly followed by `bin`, or a file that does
 *       not end in `.cjs`, or no caller at all) is never recorded
 *   (c) verdict: for a product caller and a STATE.md destination whose source
 *       is absent or is not itself a STATE.md, the write is recorded and
 *       `violation === !viaSeam`, `seam === viaSeam`
 *   (d) relocation: the same product write whose source basename is
 *       `STATE.md` is never recorded (a rename or copy of an existing STATE.md)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyStateWrite } = require('../scripts/raw-state-write-guard.cjs');

const NOT_RECORDED = Object.freeze({ recorded: false, violation: false, seam: false });

// One path segment: non-empty, no separator of either family. Random strings almost never
// land on the rule's own tokens, so the near misses the rule must tell apart (case, a
// suffix, padding, the two product directory names and look-alikes) are mixed in by name:
// the filtered arbitraries below then reject and accept real candidates instead of passing
// on arbitrary strings.
const NEAR_MISSES = [
  'STATE.md', 'state.md', 'STATE.MD', 'State.md', 'STATE.md.tmp', 'STATE.md.bak', 'STATE.md.lock', 'XSTATE.md',
  ' STATE.md', 'STATE.md ', 'STATE', 'PROJECT.md',
  'gsd-core', 'bin', 'lib', 'Bin', 'gsd-core-x', 'gsdcore', 'gsd_core', 'x.cjs', 'x.js',
];
const segment = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/[\\/]/.test(s)),
  fc.constantFrom(...NEAR_MISSES),
);
const separator = fc.constantFrom('/', '\\');

/** Join segments with a generated separator between each pair (mixed within one path). */
const joinPath = (segments, separators) =>
  segments.map((s, i) => (i === 0 ? s : separators[i % separators.length] + s)).join('');

const pathOf = (segmentsArb) =>
  fc
    .tuple(segmentsArb, fc.array(separator, { minLength: 1, maxLength: 4 }))
    .map(([segments, separators]) => joinPath(segments, separators));

const anyPath = pathOf(fc.array(segment, { minLength: 1, maxLength: 6 }));

// A destination whose basename is NOT exactly STATE.md (case-sensitive).
const nonStateDestination = pathOf(
  fc.array(segment, { minLength: 1, maxLength: 6 }).filter((segs) => segs[segs.length - 1] !== 'STATE.md'),
);

// A destination whose basename IS STATE.md, under any directory.
const stateDestination = pathOf(
  fc.array(segment, { minLength: 0, maxLength: 5 }).map((segs) => [...segs, 'STATE.md']),
);

// A product caller: <parent> / ... / gsd-core / bin / ... / <name>.cjs, separators mixed.
// A V8 callsite file name is absolute, so a `gsd-core` directory always has a parent
// segment before it (`/`-rooted or `C:`); the rule keys on the `/gsd-core/bin/` run.
const productCaller = pathOf(
  fc
    .tuple(
      fc.array(segment, { minLength: 1, maxLength: 3 }),
      fc.array(segment, { minLength: 0, maxLength: 3 }),
      segment,
    )
    .map(([before, between, name]) => [...before, 'gsd-core', 'bin', ...between, `${name}.cjs`]),
);

const hasProductPair = (segs) => segs.some((s, i) => s === 'gsd-core' && segs[i + 1] === 'bin');

// A caller that is not product code, in three families: a `.cjs` file with no
// gsd-core/bin pair (the directory names are in the segment pool, so the filter
// rejects real `.../gsd-core/bin/...` candidates and keeps `gsd-core/lib/x.cjs`,
// `gsd-core-x/bin/x.cjs` and `bin/gsd-core/x.cjs`); a file under gsd-core/bin that
// does not end in `.cjs` (the name itself may not end in `.cjs` when the extension is
// empty, or the family would emit a real product path); no caller at all.
const nonProductCaller = fc.oneof(
  pathOf(
    fc
      .tuple(fc.array(segment, { minLength: 0, maxLength: 5 }), segment)
      .map(([dirs, name]) => [...dirs, `${name}.cjs`])
      .filter((segs) => !hasProductPair(segs)),
  ),
  pathOf(
    fc
      .tuple(
        fc.array(segment, { minLength: 0, maxLength: 3 }),
        segment.filter((name) => !name.endsWith('.cjs')),
        fc.constantFrom('.js', '.cts', '.mjs', '.cjs.bak', '.CJS', ''),
      )
      .map(([before, name, ext]) => [...before, 'gsd-core', 'bin', 'lib', `${name}${ext}`]),
  ),
  fc.constantFrom(null, undefined, ''),
);

// A source argument: absent, or a path whose basename is not STATE.md.
const nonStateSource = fc.oneof(fc.constant(undefined), fc.constant(null), nonStateDestination);

describe('classifyStateWrite properties (#5120)', () => {
  test('(a) a destination whose basename is not exactly STATE.md is never recorded', () => {
    fc.assert(
      fc.property(
        nonStateDestination,
        fc.oneof(productCaller, nonProductCaller),
        fc.oneof(fc.constant(undefined), anyPath),
        fc.boolean(),
        (destination, callerFile, source, viaSeam) => {
          assert.deepEqual(classifyStateWrite({ destination, source, callerFile, viaSeam }), NOT_RECORDED);
        },
      ),
    );
  });

  test('(b) a STATE.md destination from a caller that is not product code is never recorded', () => {
    fc.assert(
      fc.property(stateDestination, nonProductCaller, nonStateSource, fc.boolean(), (destination, callerFile, source, viaSeam) => {
        assert.deepEqual(classifyStateWrite({ destination, source, callerFile, viaSeam }), NOT_RECORDED);
      }),
    );
  });

  test('(c) a product write onto STATE.md is recorded and its verdict is exactly the seam bit', () => {
    fc.assert(
      fc.property(stateDestination, productCaller, nonStateSource, fc.boolean(), (destination, callerFile, source, viaSeam) => {
        assert.deepEqual(
          classifyStateWrite({ destination, source, callerFile, viaSeam }),
          { recorded: true, violation: !viaSeam, seam: viaSeam },
        );
      }),
    );
  });

  test('(d) a product rename or copy whose source is itself a STATE.md relocates a file and is never recorded', () => {
    fc.assert(
      fc.property(stateDestination, productCaller, stateDestination, fc.boolean(), (destination, callerFile, source, viaSeam) => {
        assert.deepEqual(classifyStateWrite({ destination, source, callerFile, viaSeam }), NOT_RECORDED);
      }),
    );
  });
});

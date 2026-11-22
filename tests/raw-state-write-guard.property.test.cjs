'use strict';

/**
 * Property-based tests for classifyStateWrite, the raw STATE.md write check's rule (#5120;
 * scripts/raw-state-write-guard.cjs). The rule is a classification surface (TESTING-STANDARDS
 * "Property-based testing tier"); tests/raw-state-write-guard.test.cjs pins named cases, and the
 * properties below state the contract over generated paths, POSIX and Windows separators mixed:
 *   (a) a destination whose last segment is not exactly STATE.md is not recorded;
 *   (b) a STATE.md destination from a caller that is not product code is not recorded;
 *   (c) a product write onto STATE.md from no source or a non-STATE.md source passes only as a
 *       seam write with the destination lock held (lockHeld === true); else raw or unlocked;
 *   (d) the same write from a STATE.md source made by no seam function is a relocation that
 *       passes only when lockHeld and sourceLockHeld are both exactly true (#5120 review Major 3).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyStateWrite } = require('../scripts/raw-state-write-guard.cjs');

const NOT_RECORDED = Object.freeze({ recorded: false, violation: false, seam: false, relocation: false, reason: null });

// The lock bits as a caller may pass them: the guard passes booleans (and null for a source that
// is not a STATE.md), but only exactly `true` may count as held.
const lockBit = fc.constantFrom(true, false, null, undefined, 1, 'true');

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
        lockBit,
        lockBit,
        (destination, callerFile, source, viaSeam, lockHeld, sourceLockHeld) => {
          assert.deepEqual(classifyStateWrite({ destination, source, callerFile, viaSeam, lockHeld, sourceLockHeld }), NOT_RECORDED);
        },
      ),
    );
  });

  test('(b) a STATE.md destination from a caller that is not product code is never recorded', () => {
    fc.assert(
      fc.property(stateDestination, nonProductCaller, fc.oneof(nonStateSource, stateDestination), fc.boolean(), lockBit, (destination, callerFile, source, viaSeam, lockHeld) => {
        assert.deepEqual(classifyStateWrite({ destination, source, callerFile, viaSeam, lockHeld }), NOT_RECORDED);
      }),
    );
  });

  test('(c) a product write onto STATE.md is recorded and passes only as a seam write under the destination lock', () => {
    fc.assert(
      fc.property(stateDestination, productCaller, nonStateSource, fc.boolean(), lockBit, lockBit, (destination, callerFile, source, viaSeam, lockHeld, sourceLockHeld) => {
        const passes = viaSeam && lockHeld === true;
        assert.deepEqual(
          classifyStateWrite({ destination, source, callerFile, viaSeam, lockHeld, sourceLockHeld }),
          { recorded: true, violation: !passes, seam: viaSeam, relocation: false, reason: passes ? null : (viaSeam ? 'unlocked' : 'raw') },
        );
      }),
    );
  });

  test('(d) a product rename or copy whose source is itself a STATE.md is a relocation that passes only with both locks held', () => {
    fc.assert(
      fc.property(stateDestination, productCaller, stateDestination, lockBit, lockBit, (destination, callerFile, source, lockHeld, sourceLockHeld) => {
        const passes = lockHeld === true && sourceLockHeld === true;
        assert.deepEqual(
          classifyStateWrite({ destination, source, callerFile, viaSeam: false, lockHeld, sourceLockHeld }),
          { recorded: true, violation: !passes, seam: false, relocation: true, reason: passes ? null : 'unlocked' },
        );
      }),
    );
  });
});

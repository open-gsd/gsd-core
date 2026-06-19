'use strict';

/**
 * Property-based tests for runtime-homes.cjs dot-home-nested probe resolution.
 *
 * Module: gsd-core/bin/lib/runtime-homes.cjs
 * Exported: resolveConfigHomeFromDescriptor(descriptor, opts)
 *
 * `resolveConfigHomeFromDescriptor` (dot-home-nested kind) is a deterministic
 * transformation: (descriptor + filesystem-existence state) → resolved path.
 * Per RULESET.TESTS.property-based-testing it carries an invariant worth
 * pinning across randomized existence/marker combinations — especially the
 * #213/#217 `probeExists` marker-priority branch.
 *
 * Properties tested:
 *   (a) Membership: the resolved dir is ALWAYS one of `base/<candidate>` for
 *       some candidate in `probe` (never an off-list path).
 *   (b) Precedence: resolution follows the documented order —
 *       first marked candidate (when probeExists set) → first bare-existing
 *       candidate → `probe[0]` fallback.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { resolveConfigHomeFromDescriptor } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'),
);

const MARKER = 'gsd-core/VERSION';
const CANDIDATE_POOL = ['antigravity', 'antigravity-ide', 'antigravity-cli', 'foo', 'bar'];

describe('runtime-homes: dot-home-nested probe resolution properties', () => {
  test('property: resolved dir is always a probe candidate, in documented precedence', () => {
    fc.assert(
      fc.property(
        fc.record({
          home: fc.constantFrom('/home/u', '/Users/x', '/root', '/srv/app'),
          probe: fc.uniqueArray(fc.constantFrom(...CANDIDATE_POOL), { minLength: 1, maxLength: 5 }),
          useMarker: fc.boolean(),
          existMask: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
          markMask: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
        }),
        ({ home, probe, useMarker, existMask, markMask }) => {
          const parent = '.gemini';
          const base = path.join(home, parent);
          const candDir = (c) => path.join(base, c);

          // Which candidate dirs exist on disk, and which carry the marker.
          // A marker only matters where the dir itself exists (realistic install).
          const exists = new Set();
          const marked = new Set();
          probe.forEach((c, i) => {
            if (existMask[i]) exists.add(candDir(c));
            if (useMarker && markMask[i] && existMask[i]) marked.add(candDir(c));
          });

          const existsSync = (p) =>
            exists.has(p) || [...marked].some((d) => p === path.join(d, MARKER));

          const descriptor = {
            kind: 'dot-home-nested',
            name: 'antigravity',
            parent,
            env: ['ANTIGRAVITY_CONFIG_DIR'],
            probe,
          };
          if (useMarker) descriptor.probeExists = MARKER;

          const result = resolveConfigHomeFromDescriptor(descriptor, {
            env: {},
            home,
            existsSync,
          });

          // (a) Membership invariant.
          const allCandidateDirs = probe.map(candDir);
          assert.ok(
            allCandidateDirs.includes(result),
            `result ${result} must be one of ${JSON.stringify(allCandidateDirs)}`,
          );

          // (b) Precedence oracle: first marked → first bare-existing → probe[0].
          const firstMarked = allCandidateDirs.find((d) => marked.has(d));
          const firstExisting = allCandidateDirs.find((d) => exists.has(d));
          const expected =
            (useMarker && firstMarked) || firstExisting || candDir(probe[0]);
          assert.equal(result, expected);
        },
      ),
    );
  });

  test('property: an env override always wins over any probe/marker state', () => {
    fc.assert(
      fc.property(
        fc.record({
          home: fc.constantFrom('/home/u', '/root'),
          // Absolute overrides only: the resolver's env branch tilde-expands
          // against the real os.homedir(), so a '~/' case would not be hermetic.
          override: fc.constantFrom('/custom/ag', '/opt/x', '/var/data/ag'),
          probe: fc.uniqueArray(fc.constantFrom(...CANDIDATE_POOL), { minLength: 1, maxLength: 5 }),
          useMarker: fc.boolean(),
        }),
        ({ home, override, probe, useMarker }) => {
          const descriptor = {
            kind: 'dot-home-nested',
            name: 'antigravity',
            parent: '.gemini',
            env: ['ANTIGRAVITY_CONFIG_DIR'],
            probe,
          };
          if (useMarker) descriptor.probeExists = MARKER;

          const result = resolveConfigHomeFromDescriptor(descriptor, {
            env: { ANTIGRAVITY_CONFIG_DIR: override },
            home,
            existsSync: () => true, // every dir + marker "exists" — override must still win
          });
          assert.equal(result, override);
        },
      ),
    );
  });
});

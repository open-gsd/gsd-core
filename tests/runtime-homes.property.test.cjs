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


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1676-path-prefix-collapse-idempotency.property.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1676-path-prefix-collapse-idempotency.property (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Property-based tests for the relocated rewrite engine (ADR-1508 Phase 2).
 *
 * Module: gsd-core/bin/lib/runtime-artifact-conversion.cjs
 * Exports under test:
 *   - _computePathPrefix (private; the path-prefix derivation owner)
 *   - _applyRuntimeRewrites (the per-runtime content-rewrite engine)
 *
 * Issue #1676 (epic #1507 / ADR-1508): delivers the fast-check property
 * coverage promised in #1511's test scope but not landed there.
 *
 * Properties under test:
 *   (A) $HOME-collapse invariant — a global install whose target lives under
 *       $HOME (and is not opencode) MUST project to a `$HOME/<suffix>/`
 *       prefix, never the resolved absolute homedir path. opencode is the
 *       documented exception (it uses ~/.config/opencode, which breaks the
 *       $HOME shorthand inside double-quoted content). Asserted by EXACT
 *       equality (not substring) so short homes like `/root` or `/a` do not
 *       false-positive — the same trap handled at
 *       tests/path-replacement.test.cjs:38-47.
 *   (B) backslash→posix invariance (#1615 Windows path-leak fix): feeding
 *       Windows backslash paths yields the same prefix as their posix form.
 *   (C) path-rewrite idempotency — applying the engine twice yields the same
 *       bytes as once (no double-prefixing, no `$HOME`-of-`$HOME`).
 *       attribution is held at undefined to isolate the path-rewrite axis.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const conversion = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs'),
);
const { getDirName } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'),
);

// Runtimes whose _applyRuntimeRewrites branch performs real path rewrites
// (~/.claude/ → pathPrefix). copilot/antigravity only do attribution; claude
// and the gemini/kilo family are omitted to keep the property on the path axis
// the issue names. getDirName(`.${rt}`) == `.${rt}` for every entry here.
const PATH_REWRITE_RUNTIMES = ['codex', 'cline', 'cursor', 'windsurf', 'augment', 'trae', 'codebuddy'];

const HOMES = ['/home/u', '/Users/x', '/root', '/srv/app', '/a'];
const SEG = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);

// Build a posix `home/<segs>` target with no leading/trailing/double slashes.
const target = (home, segs) => `${home}/${segs.join('/')}`;

describe('_computePathPrefix: $HOME-collapse invariant (#1676 / ADR-1508)', () => {
  test('property: global-under-home collapses to $HOME/<suffix>/ unless opencode', () => {
    fc.assert(
      fc.property(
        fc.record({
          home: fc.constantFrom(...HOMES),
          segs: fc.array(SEG, { minLength: 1, maxLength: 3 }),
          isOpencode: fc.boolean(),
        }),
        ({ home, segs, isOpencode }) => {
          const resolvedTarget = target(home, segs);
          const suffix = segs.join('/');
          const prefix = conversion._computePathPrefix({
            isGlobal: true,
            isOpencode,
            isWindowsHost: false,
            resolvedTarget,
            homeDir: home,
          });
          if (!isOpencode) {
            // Collapse: exact $HOME form, never the resolved homedir path.
            assert.equal(prefix, `$HOME/${suffix}/`);
            assert.ok(prefix.startsWith('$HOME/'), 'prefix must start with $HOME token');
          } else {
            // opencode: absolute resolved form, never the $HOME shorthand.
            assert.equal(prefix, `${resolvedTarget}/`);
            assert.ok(!prefix.startsWith('$HOME'), 'opencode must not use $HOME shorthand');
          }
        },
      ),
    );
  });

  test('property: non-global never collapses — always the resolved absolute form', () => {
    fc.assert(
      fc.property(
        fc.record({
          home: fc.constantFrom(...HOMES),
          segs: fc.array(SEG, { minLength: 1, maxLength: 3 }),
        }),
        ({ home, segs }) => {
          const resolvedTarget = target(home, segs);
          const prefix = conversion._computePathPrefix({
            isGlobal: false,
            isOpencode: false,
            isWindowsHost: false,
            resolvedTarget,
            homeDir: home,
          });
          assert.equal(prefix, `${resolvedTarget}/`);
          assert.ok(!prefix.startsWith('$HOME'));
        },
      ),
    );
  });

  test('property: backslash paths project identically to their posix form (#1615)', () => {
    fc.assert(
      fc.property(
        fc.record({
          home: fc.constantFrom(...HOMES),
          segs: fc.array(SEG, { minLength: 1, maxLength: 3 }),
        }),
        ({ home, segs }) => {
          const posixTarget = target(home, segs);
          const backslashTarget = posixTarget.replace(/\//g, '\\');
          const backslashHome = home.replace(/\//g, '\\');
          const fromBackslash = conversion._computePathPrefix({
            isGlobal: true,
            isOpencode: false,
            isWindowsHost: false,
            resolvedTarget: backslashTarget,
            homeDir: backslashHome,
          });
          const fromPosix = conversion._computePathPrefix({
            isGlobal: true,
            isOpencode: false,
            isWindowsHost: false,
            resolvedTarget: posixTarget,
            homeDir: home,
          });
          assert.equal(fromBackslash, fromPosix);
        },
      ),
    );
  });
});

describe('_applyRuntimeRewrites: path-rewrite idempotency (#1676 / ADR-1508)', () => {
  test('property: f(f(content)) === f(content) across path-rewriting runtimes', () => {
    fc.assert(
      fc.property(
        fc.record({
          runtime: fc.constantFrom(...PATH_REWRITE_RUNTIMES),
          home: fc.constantFrom(...HOMES),
          isGlobal: fc.boolean(),
          segs: fc.array(SEG, { minLength: 1, maxLength: 4 }),
        }),
        ({ runtime, home, isGlobal, segs }) => {
          // configDir under $HOME so global collapses to $HOME/.<dirName>/;
          // non-global projects to an absolute form. Both are prefix shapes
          // that contain no matchable ~/.claude or $HOME/.claude token, so a
          // second rewrite pass is a no-op.
          const dirName = getDirName(runtime).replace(/^\./, '');
          const configDir = target(home, [`.${dirName}`]);
          const pathPrefix = conversion._computePathPrefix({
            isGlobal,
            isOpencode: false,
            isWindowsHost: false,
            resolvedTarget: configDir,
            homeDir: home,
          });

          // Seed content with every reference shape the engine rewrites,
          // interleaved with inert prose so rewrites land mid-line.
          const lines = segs.map((s) =>
            `See ~/.claude/skills/${s} or $HOME/.claude/agents/${s}; also ./.claude/${s}.`);
          const content = lines.join('\n');

          const once = conversion._applyRuntimeRewrites(content, runtime, pathPrefix, isGlobal, undefined);
          const twice = conversion._applyRuntimeRewrites(once, runtime, pathPrefix, isGlobal, undefined);
          assert.equal(twice, once, 'second rewrite pass must be a no-op (idempotent)');
          // Sanity: the seed references were actually rewritten on the first pass.
          assert.ok(!once.includes('~/.claude/'), 'first pass must eliminate ~/.claude/ refs');
        },
      ),
    );
  });
});
  });
}

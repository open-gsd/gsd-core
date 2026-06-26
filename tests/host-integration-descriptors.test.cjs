'use strict';

/**
 * ADR-1239 Phase A: Descriptor tests — validate that all 16 role:runtime
 * capability descriptors have correct hostIntegration axes, pass the validator,
 * and negotiate correctly via the host-integration module.
 *
 * Expectations are derived from the generated capability registry and
 * .host-cli-final.json (source of truth). Values are verbatim; 'undocumented'
 * sentinels fail-closed in negotiation (safe documented default, never propagate).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  negotiateHostCapabilities,
  profileOf,
  shouldFlattenDispatch,
} = require(path.join(__dirname, '../gsd-core/bin/lib/host-integration.cjs'));

const registry = require(path.join(__dirname, '../gsd-core/bin/lib/capability-registry.cjs'));

const {
  validateCapability,
} = require(path.join(__dirname, '../gsd-core/bin/lib/capability-validator.cjs'));

// All 8 scalar hostIntegration axis keys
const SCALAR_AXES = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];
// All 6 dispatch sub-keys (includes backgroundDispatch added in feat/1679-dispatch-flatten)
const DISPATCH_KEYS = ['namedDispatch', 'nested', 'maxDepth', 'background', 'subagentToolkit', 'backgroundDispatch'];

// All 16 runtime IDs (ordered alphabetically)
const RUNTIME_IDS = [
  'antigravity', 'augment', 'claude', 'cline', 'codebuddy',
  'codex', 'copilot', 'cursor', 'gemini', 'hermes',
  'kilo', 'kimi', 'opencode', 'qwen', 'trae', 'windsurf',
];

// Contract-pinned profile split (derived from .host-cli-final.json):
// programmatic-cli: claude, cline, cursor, hermes, kilo, kimi, opencode, qwen, trae (9)
// declarative-cli:  antigravity, augment, codebuddy, codex, copilot, gemini, windsurf (7)
// ide: 0
const EXPECTED_PROFILES = {
  claude:      'programmatic-cli',
  cline:       'programmatic-cli',
  cursor:      'programmatic-cli',
  hermes:      'programmatic-cli',
  kilo:        'programmatic-cli',
  kimi:        'programmatic-cli',
  opencode:    'programmatic-cli',
  qwen:        'programmatic-cli',
  trae:        'programmatic-cli',
  antigravity: 'declarative-cli',
  augment:     'declarative-cli',
  codebuddy:   'declarative-cli',
  codex:       'declarative-cli',
  copilot:     'declarative-cli',
  gemini:      'declarative-cli',
  windsurf:    'declarative-cli',
};

describe('ADR-1239 Phase A: hostIntegration descriptors', () => {
  // ─── Registry shape ──────────────────────────────────────────────────────────

  test('registry.runtimes contains all 16 expected runtime ids', () => {
    for (const id of RUNTIME_IDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.runtimes, id),
        'registry.runtimes must contain "' + id + '"',
      );
    }
    assert.strictEqual(
      Object.keys(registry.runtimes).length,
      16,
      'registry.runtimes must have exactly 16 entries',
    );
  });

  // ─── Per-runtime assertions ───────────────────────────────────────────────────

  for (const id of RUNTIME_IDS) {
    describe('runtime: ' + id, () => {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;

      // (i) Validator passes with zero errors
      test('(i) validateCapability returns zero errors', () => {
        const errors = validateCapability(cap, id);
        assert.deepEqual(
          errors,
          [],
          id + ': validateCapability must return no errors, got: ' + JSON.stringify(errors),
        );
      });

      // (ii) hostIntegration object is present with all required keys
      test('(ii) cap.runtime.hostIntegration is present with all 8 axis keys and 6 dispatch sub-keys', () => {
        assert.ok(
          hi !== undefined && hi !== null && typeof hi === 'object',
          id + ': cap.runtime.hostIntegration must be a non-null object',
        );
        // All 8 scalar axes present
        for (const axis of SCALAR_AXES) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(hi, axis),
            id + ': hostIntegration must have axis "' + axis + '"',
          );
        }
        // dispatch is an object
        assert.ok(
          hi.dispatch !== null && typeof hi.dispatch === 'object',
          id + ': hostIntegration.dispatch must be a non-null object',
        );
        // All 5 dispatch sub-keys present
        for (const key of DISPATCH_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(hi.dispatch, key),
            id + ': hostIntegration.dispatch must have key "' + key + '"',
          );
        }
      });

      // (iii) negotiateHostCapabilities does not throw and behaves correctly
      test('(iii) negotiateHostCapabilities: documented scalars pass through; undocumented scalars degrade with warning', () => {
        assert.ok(hi, id + ': hostIntegration must exist to negotiate');
        let result;
        assert.doesNotThrow(() => {
          result = negotiateHostCapabilities(hi);
        }, id + ': negotiateHostCapabilities must not throw');

        const eff = result.effective;

        // For each scalar axis: if declared !== 'undocumented', effective === declared
        // If declared === 'undocumented', effective !== 'undocumented' (safe default) and
        // warnings must mention that axis.
        for (const axis of SCALAR_AXES) {
          const declared = hi[axis];
          if (declared !== 'undocumented') {
            assert.strictEqual(
              eff[axis],
              declared,
              id + ': effective.' + axis + ' must equal declared (' + JSON.stringify(declared) + '), got: ' + JSON.stringify(eff[axis]),
            );
          } else {
            // fail-closed: effective must be a documented safe default, not 'undocumented'
            assert.notStrictEqual(
              eff[axis],
              'undocumented',
              id + ': effective.' + axis + ' must NOT be "undocumented" (fail-closed)',
            );
            // warnings must mention this axis
            const mentionsAxis = result.warnings.some((w) => w.includes(axis));
            assert.ok(
              mentionsAxis,
              id + ': result.warnings must mention axis "' + axis + '" when declared is undocumented, got: ' + JSON.stringify(result.warnings),
            );
          }
        }
      });

      // (iii-b) dispatch negotiation for namedDispatch
      test('(iii-b) dispatch.namedDispatch negotiation', () => {
        assert.ok(hi, id + ': hostIntegration must exist to negotiate');
        const result = negotiateHostCapabilities(hi);

        const declaredND = hi.dispatch && hi.dispatch.namedDispatch;

        if (declaredND === true) {
          // documented as true → effective must be true
          assert.strictEqual(
            result.effective.dispatch.namedDispatch,
            true,
            id + ': effective.dispatch.namedDispatch must be true when declared is true',
          );
        } else if (declaredND === 'undocumented') {
          // undocumented → fail-closed: effective namedDispatch must be false
          assert.strictEqual(
            result.effective.dispatch.namedDispatch,
            false,
            id + ': effective.dispatch.namedDispatch must be false when declared is "undocumented" (fail-closed)',
          );
          // dispatch.effectiveLevel must be 'absent' (no named dispatch)
          assert.strictEqual(
            result.points.dispatch.effectiveLevel,
            'absent',
            id + ': points.dispatch.effectiveLevel must be "absent" when namedDispatch is undocumented',
          );
        }
      });

      // (iv) profileOf returns expected profile
      test('(iv) profileOf returns expected profile', () => {
        assert.ok(hi, id + ': hostIntegration must exist to profile');
        const profile = profileOf(hi);
        assert.ok(
          profile !== null,
          id + ': profileOf must return a non-null profile',
        );
        assert.strictEqual(
          profile,
          EXPECTED_PROFILES[id],
          id + ': profileOf must return "' + EXPECTED_PROFILES[id] + '" (got: "' + profile + '")',
        );
      });
    });
  }

  // ─── Contract-pin profile split ───────────────────────────────────────────────

  test('contract-pin: exactly 9 programmatic-cli, 7 declarative-cli, 0 ide', () => {
    const counts = { 'programmatic-cli': 0, 'declarative-cli': 0, 'ide': 0 };
    for (const id of RUNTIME_IDS) {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;
      assert.ok(hi, id + ': hostIntegration must exist for profile count');
      const profile = profileOf(hi);
      assert.ok(profile !== null, id + ': profileOf must be non-null');
      if (counts[profile] !== undefined) {
        counts[profile]++;
      }
    }
    assert.strictEqual(counts['programmatic-cli'], 9, 'Must have exactly 9 programmatic-cli runtimes');
    assert.strictEqual(counts['declarative-cli'], 7, 'Must have exactly 7 declarative-cli runtimes');
    assert.strictEqual(counts['ide'], 0, 'Must have exactly 0 ide runtimes');
  });

  // ─── backgroundDispatch presence ─────────────────────────────────────────────

  test('every runtime descriptor has dispatch.backgroundDispatch (boolean or "undocumented")', () => {
    for (const id of RUNTIME_IDS) {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      assert.ok(
        dispatch !== null && typeof dispatch === 'object',
        id + ': hostIntegration.dispatch must be an object',
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(dispatch, 'backgroundDispatch'),
        id + ': dispatch must have a backgroundDispatch key',
      );
      const v = dispatch.backgroundDispatch;
      assert.ok(
        v === true || v === false || v === 'undocumented',
        id + ': dispatch.backgroundDispatch must be true, false, or "undocumented", got: ' + JSON.stringify(v),
      );
    }
  });

  // ─── shouldFlattenDispatch per-host (#853 discriminator) ─────────────────────

  // Expected: false (may background) for codex and cursor ONLY; true (must inline) for the other 14.
  const EXPECTED_FLATTEN = {
    antigravity: true,
    augment:     true,
    claude:      true,
    cline:       true,
    codebuddy:   true,
    codex:       false,
    copilot:     true,
    cursor:      false,
    gemini:      true,
    hermes:      true,
    kilo:        true,
    kimi:        true,
    opencode:    true,
    qwen:        true,
    trae:        true,
    windsurf:    true,
  };

  for (const id of RUNTIME_IDS) {
    test('shouldFlattenDispatch(' + id + ') === ' + EXPECTED_FLATTEN[id], () => {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      assert.ok(dispatch, id + ': dispatch must exist');
      const result = shouldFlattenDispatch(dispatch);
      assert.strictEqual(
        result,
        EXPECTED_FLATTEN[id],
        id + ': shouldFlattenDispatch must return ' + EXPECTED_FLATTEN[id] + ' (got: ' + result + ')',
      );
    });
  }

  test('contract-pin: exactly 2 hosts are background-eligible (shouldFlattenDispatch === false): codex and cursor', () => {
    const eligible = RUNTIME_IDS.filter((id) => {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      return dispatch && shouldFlattenDispatch(dispatch) === false;
    });
    assert.deepEqual(
      eligible.slice().sort(),
      ['codex', 'cursor'],
      'Exactly codex and cursor must be background-eligible, got: ' + JSON.stringify(eligible.sort()),
    );
  });

  test('contract-pin: spot-check claude→programmatic-cli, codex→declarative-cli, opencode→programmatic-cli, gemini→declarative-cli', () => {
    const checks = [
      ['claude', 'programmatic-cli'],
      ['codex', 'declarative-cli'],
      ['opencode', 'programmatic-cli'],
      ['gemini', 'declarative-cli'],
    ];
    for (const [id, expectedProfile] of checks) {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;
      assert.ok(hi, id + ': hostIntegration must exist');
      const profile = profileOf(hi);
      assert.strictEqual(
        profile,
        expectedProfile,
        id + ': profileOf must return "' + expectedProfile + '" (got: "' + profile + '")',
      );
    }
  });

  // ─── NEGATIVE cases ───────────────────────────────────────────────────────────

  describe('NEGATIVE: invalid hostIntegration.embeddingMode triggers validator error', () => {
    test('embeddingMode "bogus" produces a validator error naming embeddingMode', () => {
      const cap = {
        id: 'test-neg',
        role: 'runtime',
        version: '1.0.0',
        title: 'Test Negative',
        description: 'Negative case for hostIntegration validation.',
        tier: 'core',
        requires: [],
        runtime: {
          configHome: { kind: 'dot-home', name: '.test-neg', env: [] },
          configFormat: 'settings-json',
          artifactLayout: { global: [], local: [] },
          commandStyle: 'slash-hyphen',
          hooksSurface: 'settings-json',
          hookEvents: 'claude',
          sandboxTier: 'none',
          supportTier: 1,
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          extendedHookEvents: [],
          hostIntegration: {
            embeddingMode: 'bogus',
            commandSurface: 'slash-file',
            dispatch: { namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full', backgroundDispatch: false },
            modelMode: 'passive',
            hookBus: 'host',
            stateIO: 'filesystem',
            transport: 'mcp',
            runtime: 'node',
          },
        },
      };
      const errors = validateCapability(cap, 'test-neg');
      assert.ok(errors.length > 0, 'Expected validation errors for bogus embeddingMode');
      assert.ok(
        errors.some((e) => e.includes('embeddingMode')),
        'At least one error must mention embeddingMode, got: ' + JSON.stringify(errors),
      );
    });
  });

  describe('NEGATIVE: missing hostIntegration produces required-object error', () => {
    test('runtime body without hostIntegration produces the required-object error', () => {
      const cap = {
        id: 'test-missing-hi',
        role: 'runtime',
        version: '1.0.0',
        title: 'Test Missing HI',
        description: 'Negative case for missing hostIntegration.',
        tier: 'core',
        requires: [],
        runtime: {
          configHome: { kind: 'dot-home', name: '.test-missing-hi', env: [] },
          configFormat: 'settings-json',
          artifactLayout: { global: [], local: [] },
          commandStyle: 'slash-hyphen',
          hooksSurface: 'settings-json',
          hookEvents: 'claude',
          sandboxTier: 'none',
          supportTier: 1,
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          extendedHookEvents: [],
          // hostIntegration intentionally absent
        },
      };
      const errors = validateCapability(cap, 'test-missing-hi');
      assert.ok(errors.length > 0, 'Expected validation errors for missing hostIntegration');
      assert.ok(
        errors.some((e) => e.includes('hostIntegration') && e.includes('required')),
        'At least one error must mention hostIntegration and required, got: ' + JSON.stringify(errors),
      );
    });
  });
});

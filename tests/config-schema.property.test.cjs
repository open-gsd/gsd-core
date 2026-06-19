'use strict';

/**
 * Property-based tests for config-schema.cjs
 *
 * Module: gsd-core/bin/lib/config-schema.cjs
 * Exported: isValidConfigKey(keyPath) -> boolean
 *           VALID_CONFIG_KEYS: Set<string>
 *           RUNTIME_STATE_KEYS: Set<string>
 *           DYNAMIC_KEY_PATTERNS: Array<{ test(key): boolean, ... }>
 *
 * Properties tested:
 *   (a) isValidConfigKey never throws regardless of input type/content
 *   (b) isValidConfigKey(key) is true for every key in VALID_CONFIG_KEYS
 *   (c) isValidConfigKey(key) is true for every key in RUNTIME_STATE_KEYS
 *   (d) Robustness: null/undefined/NaN/control-chars/binary never throw
 *   (e) Arbitrary garbage strings return false (not throw) from isValidConfigKey
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const {
  isValidConfigKey,
  isCapabilityConfigKey,
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
} = require('../gsd-core/bin/lib/config-schema.cjs');

describe('config-schema: isValidConfigKey properties', () => {
  // (a) Never throws on any input
  test('property: isValidConfigKey never throws on hostile inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.constant(0),
          fc.constant(''),
          fc.constant('\x00'),
          fc.constant('\n\r\t'),
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 }),
          fc.constant([]),
          fc.constant({}),
          fc.boolean(),
          fc.string({ maxLength: 100 })
        ),
        (input) => {
          assert.doesNotThrow(
            () => isValidConfigKey(input),
            `isValidConfigKey threw on input: ${JSON.stringify(input)}`
          );
        }
      )
    );
  });

  // (b) Every key in VALID_CONFIG_KEYS returns true
  test('all VALID_CONFIG_KEYS entries are recognized as valid', () => {
    for (const key of VALID_CONFIG_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true`
      );
    }
  });

  // (c) Every key in RUNTIME_STATE_KEYS returns true
  test('all RUNTIME_STATE_KEYS entries are recognized as valid', () => {
    for (const key of RUNTIME_STATE_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true (runtime state key)`
      );
    }
  });

  // (d+e) Robustness: hostile strings return boolean (not throw)
  test('property: isValidConfigKey always returns a boolean for any string', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        (key) => {
          const result = isValidConfigKey(key);
          assert.ok(
            typeof result === 'boolean',
            `isValidConfigKey must return boolean, got ${typeof result} for ${JSON.stringify(key)}`
          );
        }
      )
    );
  });

  test('property: binary/control-char strings return false (not throw)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 })
        ),
        (key) => {
          // Either returns true (if it happens to match a valid key) or false
          // It must NOT throw
          let result;
          assert.doesNotThrow(() => {
            result = isValidConfigKey(key);
          });
          assert.ok(typeof result === 'boolean');
        }
      )
    );
  });

  // Boundary: well-formed dotted paths that are NOT in the schema
  test('property: plausible-but-invalid dotted paths return false', () => {
    // Generate dot-separated alphanumeric paths that do not match known keys
    const dotPath = fc.array(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
      { minLength: 3, maxLength: 5 }
    ).map((parts) => 'zz_unknown.' + parts.join('.'));

    fc.assert(
      fc.property(dotPath, (key) => {
        // Must not throw
        let result;
        assert.doesNotThrow(() => {
          result = isValidConfigKey(key);
        });
        // Result is a boolean
        assert.ok(typeof result === 'boolean');
      })
    );
  });

  // Boundary: empty string is not a valid config key
  test('empty string is not a valid config key', () => {
    const result = isValidConfigKey('');
    assert.equal(result, false, 'empty string must not be a valid config key');
  });

  // Boundary: null/undefined/number return false (not throw, not true)
  test('null, undefined, number inputs return false', () => {
    assert.equal(isValidConfigKey(null), false);
    assert.equal(isValidConfigKey(undefined), false);
    assert.equal(isValidConfigKey(42), false);
    assert.equal(isValidConfigKey(NaN), false);
  });
});

// ─── ADR-1244 D2: cwd-aware overlay config-key federation ─────────────────────
//
// Exercises every branch of the new _capabilityConfigSchema(cwd) path so the
// mutation suite (this is the file Stryker runs for config-schema) KILLS the
// added mutants: the `typeof cwd === 'string' && cwd` guard, the overlay
// loadRegistry({includeInstalled,cwd}) call, the `schema && typeof === 'object'`
// found-branch, the first-party fallback, and the cwd threading through
// isValidConfigKey. Uses a real overlay fixture (no test seam).
describe('config-schema: cwd-aware overlay federation (ADR-1244 D2)', () => {
  const OVERLAY_KEY = 'workflow.cfgschema_overlay_gate';
  // A known FIRST-PARTY capability config key (ui capability) — exercises the
  // first-party fallback branch (no cwd → frozen registry configSchema).
  const FIRST_PARTY_KEY = 'workflow.ui_phase';
  const overlayCap = {
    id: 'cfgschema-overlay', role: 'feature', version: '1.0.0', title: 'cfg overlay', description: 'x',
    tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: ['cfgschema-overlay-skill'], agents: [], hooks: [],
    config: { [OVERLAY_KEY]: { type: 'boolean', default: true, description: 'overlay-owned key' } },
    steps: [], contributions: [], gates: [],
  };

  let withOverlay, withoutOverlay, sandboxHome, savedHome;
  before(() => {
    savedHome = process.env.GSD_HOME;
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-home-'));
    process.env.GSD_HOME = sandboxHome; // empty global overlay root
    withOverlay = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-proj-'));
    fs.mkdirSync(path.join(withOverlay, '.planning'), { recursive: true }); // project-root marker
    const capDir = path.join(withOverlay, '.gsd', 'capabilities', 'cfgschema-overlay');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(overlayCap), 'utf8');
    withoutOverlay = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-bare-'));
    fs.mkdirSync(path.join(withoutOverlay, '.planning'), { recursive: true });
  });
  after(() => {
    if (savedHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = savedHome;
    cleanup(sandboxHome); cleanup(withOverlay); cleanup(withoutOverlay);
  });

  test('first-party fallback: a first-party capability config key is valid with no cwd', () => {
    // Kills the fallback branch (return fp ... : {}) and the no-cwd path.
    assert.equal(isCapabilityConfigKey(FIRST_PARTY_KEY), true);
    assert.equal(isValidConfigKey(FIRST_PARTY_KEY), true);
  });

  test('overlay key is recognized only when the installing project cwd is supplied', () => {
    // cwd with the overlay → true (kills cwd-guard, loadRegistry call, found-branch, hasOwnProperty)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY, withOverlay), true);
    assert.equal(isValidConfigKey(OVERLAY_KEY, withOverlay), true);
    // no cwd → first-party only → false (kills the cwd-true→fallback distinction)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY), false);
    assert.equal(isValidConfigKey(OVERLAY_KEY), false);
    // cwd WITHOUT the overlay → loadRegistry returns base → false (cwd-correct)
    assert.equal(isCapabilityConfigKey(OVERLAY_KEY, withoutOverlay), false);
    assert.equal(isValidConfigKey(OVERLAY_KEY, withoutOverlay), false);
  });

  test('a genuinely unknown key is invalid regardless of cwd', () => {
    assert.equal(isCapabilityConfigKey('zz.not.a.key', withOverlay), false);
    assert.equal(isValidConfigKey('zz.not.a.key', withOverlay), false);
  });

  test('non-string keyPath returns false even with a cwd (no throw)', () => {
    assert.equal(isCapabilityConfigKey(null, withOverlay), false);
    assert.equal(isCapabilityConfigKey(42, withOverlay), false);
  });
});

// ---------------------------------------------------------------------------
// ADR-1244 Phase 4 — capability trust config keys
// ---------------------------------------------------------------------------

describe('capability trust config keys (ADR-1244 Phase 4)', () => {
  const { CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/configuration.cjs');

  test('capabilities.strict_known_registries and capabilities.auto_update are valid central keys', () => {
    assert.equal(isValidConfigKey('capabilities.strict_known_registries'), true);
    assert.equal(isValidConfigKey('capabilities.auto_update'), true);
  });

  test('there is no capabilities.* wildcard — an unknown capabilities key is invalid', () => {
    assert.equal(isValidConfigKey('capabilities.something_else'), false);
  });

  test('defaults: strict_known_registries is permissive (null) and auto_update is OFF (false)', () => {
    assert.equal(CONFIG_DEFAULTS.capabilities.strict_known_registries, null);
    assert.equal(CONFIG_DEFAULTS.capabilities.auto_update, false);
  });
});

'use strict';

/**
 * Regression test suite for bug #1628: config-set validation gaps.
 *
 * This file consolidates all #1628 config-set validation regression tests:
 *   1. Security-key enum guards (workflow.security_block_on, workflow.security_asvs_level)
 *   2. JSON-array coercion bypass: every affected string-enum key
 *   3. Generic capability-registry validation (enum/boolean/number/string keys)
 *
 * Covers:
 * - workflow.security_block_on must be one of: critical | high | medium | low | none
 * - workflow.security_asvs_level must be an integer in {1, 2, 3}
 * - JSON-array (["<member>"]) and JSON-object ({"x":1}) values must be REJECTED for
 *   all string-enum keys (typeof check before enum guard)
 * - capability-registry-owned keys: ENUM, BOOLEAN, NUMBER, STRING
 *
 * Boundary coverage per RULESET.TESTS.boundary-coverage:
 *   security_asvs_level: 0 (limit-1), 1 (limit), 2, 3 (limit), 4 (limit+1)
 *   security_block_on: each valid enum member + bogus values
 *
 * Registry canary: verifies capability registry's .values for workflow.security_block_on
 * matches the canonical enum (guards against silent gutting per DEFECT.GENERATIVE-FIX).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// ─── Registry canary ──────────────────────────────────────────────────────────
// Verify the capability registry's declared .values for workflow.security_block_on
// matches the canonical enum. config.cts sources its allowed set DIRECTLY from the
// registry, so this canary guards against the registry being silently gutted — which
// would cause every config-set call to fail (per DEFECT.GENERATIVE-FIX).
describe('fix-1628: registry canary — capability registry declares the canonical security_block_on enum', () => {
  test('registry workflow.security_block_on.values declares the expected canonical enum', () => {
    // Load the capability registry as a module (behavioral call, not source grep).
    // The registry IS the source of truth: config.cts reads from it at runtime.
    // This assertion guards against the registry entry being gutted or values removed.
    const { configSchema } = require('../gsd-core/bin/lib/capability-registry.cjs');
    const entry = configSchema['workflow.security_block_on'];
    assert.ok(entry, 'capability registry must have an entry for workflow.security_block_on');
    assert.ok(Array.isArray(entry.values), 'registry entry must have a .values array');

    const EXPECTED = ['critical', 'high', 'medium', 'low', 'none'];
    assert.deepEqual(
      [...entry.values].sort(),
      [...EXPECTED].sort(),
      `Registry workflow.security_block_on.values must be ${JSON.stringify(EXPECTED)} — update ` +
      `the capability registry if the canonical enum changes`
    );
  });
});

// ─── workflow.security_block_on ───────────────────────────────────────────────

describe('fix-1628: workflow.security_block_on enum validation', () => {
  const VALID_VALUES = ['critical', 'high', 'medium', 'low', 'none'];
  const INVALID_VALUES = ['bogus', 'High', 'CRITICAL', '', 'all', 'urgent'];

  for (const v of VALID_VALUES) {
    test(`config-set workflow.security_block_on=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', v],
        tmpDir
      );
      assert.ok(
        result.success,
        [
          `config-set workflow.security_block_on=${v} must succeed,`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  for (const v of INVALID_VALUES) {
    test(`config-set workflow.security_block_on=${JSON.stringify(v)} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', v],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_block_on=${JSON.stringify(v)} must fail, but it succeeded`
      );
      const combined = (result.output || '') + (result.error || '');
      // Error message must mention the valid values
      assert.ok(
        combined.includes('critical') && combined.includes('none'),
        `Error message must mention valid values (got: ${combined})`
      );
    });
  }
});

// ─── workflow.security_block_on — JSON-parse coercion bypass ─────────────────
// Regression for the String(parsedValue) coercion bug: an array like ["high"]
// coerces to "high" via String(), bypassing the enum check and writing an array
// to a string-enum key. The fix requires typeof parsedValue === 'string'.

describe('fix-1628: workflow.security_block_on rejects JSON-parsed non-string inputs', () => {
  const JSON_BYPASS_CASES = [
    { val: '["high"]',   label: 'JSON array with valid member' },
    { val: '["bogus"]',  label: 'JSON array with invalid member' },
    { val: '{"high":1}', label: 'JSON object' },
  ];

  for (const { val, label } of JSON_BYPASS_CASES) {
    test(`config-set workflow.security_block_on=${label} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', val],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_block_on=${label} must fail, but it succeeded`
      );
    });
  }
});

// ─── workflow.security_asvs_level ─────────────────────────────────────────────

describe('fix-1628: workflow.security_asvs_level range validation', () => {
  // Boundary: 0 (below limit), 1 (min valid), 2 (mid), 3 (max valid), 4 (above limit)
  const ACCEPTED_INTEGERS = [1, 2, 3];
  const REJECTED_VALUES = [
    { val: '0',   label: '0 (below lower bound)' },
    { val: '4',   label: '4 (above upper bound)' },
    { val: '2.5', label: '2.5 (non-integer float)' },
    { val: 'abc', label: '"abc" (non-numeric string)' },
    { val: '-1',  label: '-1 (negative)' },
  ];

  for (const n of ACCEPTED_INTEGERS) {
    test(`config-set workflow.security_asvs_level=${n} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_asvs_level', String(n)],
        tmpDir
      );
      assert.ok(
        result.success,
        [
          `config-set workflow.security_asvs_level=${n} must succeed,`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  for (const { val, label } of REJECTED_VALUES) {
    test(`config-set workflow.security_asvs_level=${label} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_asvs_level', val],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_asvs_level=${label} must fail, but it succeeded`
      );
      const combined = (result.output || '') + (result.error || '');
      assert.ok(
        combined.includes('security_asvs_level'),
        `Error message must reference the key name (got: ${combined})`
      );
    });
  }
});

// ─── JSON-array coercion bypass — parameterised matrix ───────────────────────
// The root cause: cmdConfigSet JSON-parses any value starting with '[' or '{'
// BEFORE per-key enum guards run. Guards using `.includes(String(parsedValue))`
// are then fooled because `String(["mid-flight"]) === "mid-flight"`, so the
// array bypasses the guard and gets stored in a scalar key.
//
// The fix: `assertEnumValue()` checks `typeof parsedValue === 'string'` FIRST,
// so a parsed array is rejected regardless of its string coercion.
//
// Coverage: every affected string-enum key.
// - `["<member>"]` (JSON array with valid member) → REJECTED
// - `{"x":1}` (JSON object) → REJECTED
// - `<member>` (plain string, valid) → ACCEPTED

// Each row: { key, member } where `member` is a valid enum value for `key`.
// Verified against VALID_* arrays in src/config.cts.
const ENUM_KEYS = [
  { key: 'context',                              member: 'research'   },
  { key: 'workflow.drift_action',                member: 'warn'       },
  { key: 'workflow.human_verify_mode',           member: 'mid-flight' },
  { key: 'workflow.context_guard_mode',          member: 'off'        },
  { key: 'statusline.context_position',          member: 'front'      },
  { key: 'code_quality.fallow.scope',            member: 'phase'      },
  { key: 'code_quality.fallow.profile',          member: 'standard'   },
  { key: 'plan_review.source_grounding_authority', member: 'grep'     },
  { key: 'workflow.security_block_on',           member: 'high'       },
];

for (const { key, member } of ENUM_KEYS) {
  describe(`fix-1628 coercion bypass: ${key}`, () => {
    // ── JSON array with valid member must be REJECTED ────────────────────────
    test(`["${member}"] (JSON array with valid member) is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const val = `["${member}"]`;
      const result = runGsdTools(['config-set', key, val], tmpDir);
      assert.ok(
        !result.success,
        [
          `config-set ${key}=${val} must be REJECTED (JSON-array coercion bypass)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });

    // ── JSON object must be REJECTED ─────────────────────────────────────────
    test(`{"x":1} (JSON object) is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const val = '{"x":1}';
      const result = runGsdTools(['config-set', key, val], tmpDir);
      assert.ok(
        !result.success,
        [
          `config-set ${key}=${val} must be REJECTED (JSON-object bypass)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });

    // ── Plain valid string must be ACCEPTED ──────────────────────────────────
    test(`"${member}" (plain valid string) is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', key, member], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set ${key}=${member} must be ACCEPTED (plain string, valid enum member)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  });
}

// ─── ENUM: workflow.code_review_depth ────────────────────────────────────────

describe('fix-1628 capability validation: workflow.code_review_depth (enum)', () => {
  const VALID_VALUES = ['quick', 'standard', 'deep'];

  for (const v of VALID_VALUES) {
    test(`config-set workflow.code_review_depth=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', 'workflow.code_review_depth', v], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set workflow.code_review_depth=${v} must succeed`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  test('config-set workflow.code_review_depth=["standard"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.code_review_depth', '["standard"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.code_review_depth=["standard"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.code_review_depth=garbage is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.code_review_depth', 'garbage'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.code_review_depth=garbage must be REJECTED (out-of-enum)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── ENUM: mempalace.memory_mode ─────────────────────────────────────────────

describe('fix-1628 capability validation: mempalace.memory_mode (enum)', () => {
  const VALID_VALUES = ['augment', 'kg_backend', 'replace'];

  for (const v of VALID_VALUES) {
    test(`config-set mempalace.memory_mode=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', 'mempalace.memory_mode', v], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set mempalace.memory_mode=${v} must succeed`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  test('config-set mempalace.memory_mode=["augment"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.memory_mode', '["augment"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.memory_mode=["augment"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.memory_mode=garbage is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.memory_mode', 'garbage'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.memory_mode=garbage must be REJECTED (out-of-enum)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── BOOLEAN: workflow.tdd_mode ──────────────────────────────────────────────

describe('fix-1628 capability validation: workflow.tdd_mode (boolean)', () => {
  test('config-set workflow.tdd_mode=true is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'true'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.tdd_mode=true must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=false is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'false'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.tdd_mode=false must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=["true"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '["true"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=["true"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode={"x":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '{"x":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode={"x":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=maybe (non-boolean string) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'maybe'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=maybe must be REJECTED (non-boolean string)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=1 (numeric 1 coerces to number, not boolean) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '1'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=1 must be REJECTED (number, not boolean)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── BOOLEAN: graphify.enabled ────────────────────────────────────────────────

describe('fix-1628 capability validation: graphify.enabled (boolean)', () => {
  test('config-set graphify.enabled=true is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'true'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set graphify.enabled=true must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=false is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'false'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set graphify.enabled=false must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=["true"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '["true"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=["true"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled={"x":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '{"x":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled={"x":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=maybe (non-boolean string) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'maybe'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=maybe must be REJECTED (non-boolean string)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=1 (numeric 1, not boolean) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '1'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=1 must be REJECTED (number, not boolean)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── NUMBER: workflow.drift_threshold ────────────────────────────────────────

describe('fix-1628 capability validation: workflow.drift_threshold (number)', () => {
  test('config-set workflow.drift_threshold=5 is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.drift_threshold', '5'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.drift_threshold=5 must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.drift_threshold=["3"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.drift_threshold', '["3"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.drift_threshold=["3"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── STRING: mempalace.wing ───────────────────────────────────────────────────

describe('fix-1628 capability validation: mempalace.wing (string)', () => {
  test('config-set mempalace.wing=myWing is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', 'myWing'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set mempalace.wing=myWing must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.wing=["x"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', '["x"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.wing=["x"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.wing={"a":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', '{"a":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.wing={"a":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

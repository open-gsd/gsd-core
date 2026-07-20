/**
 * GSD Tools Tests — config-gated provider escalation on quota-exceeded (#2296)
 *
 * #2068 wired `resolveModelForTier` into `cmdResolveExecution`, so `--attempt`
 * already escalates the model up the TIER ladder (light -> standard -> heavy)
 * within one provider's `tier_models`. That does not help when the failure is a
 * provider quota/rate-limit: a heavier tier on the same throttled account is
 * still throttled.
 *
 * #2296 layers a PROVIDER escalation ladder onto the existing reactive
 * classification seam (`EXEC.CLASSIFY` / `agent classify-failure`, #3095):
 * when `resolve-execution` is told the failure class was `quota-exceeded` and
 * `dynamic_routing.provider_escalation` is configured, the model resolves from
 * that ordered list instead of the tier ladder, capped by `max_escalations`,
 * reporting `from -> to` so the switch is visible, and reporting `exhausted`
 * once the list is spent so the caller can fail loudly.
 *
 * Baselines confirmed by running the built CLI against a temp project before
 * writing these assertions (gsd-executor default routing tier is "standard"):
 *   attempt 0, no --failure-class -> sonnet
 *   attempt 1, no --failure-class -> opus   (tier ladder, unchanged by #2296)
 *   --failure-class <anything>            -> "Unknown flag" before this change
 *   config-set dynamic_routing.provider_escalation -> "Unknown config key"
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const TIER_MODELS = { light: 'haiku', standard: 'sonnet', heavy: 'opus' };

function writeConfig(tmpDir, config) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config));
}

function routingConfig(extra) {
  return { dynamic_routing: { enabled: true, tier_models: TIER_MODELS, ...extra } };
}

/** Run resolve-execution and parse the JSON contract. Asserts success. */
function resolve(tmpDir, args) {
  const result = runGsdTools(`resolve-execution ${args}`, tmpDir);
  assert.ok(result.success, `resolve-execution ${args} failed: ${result.error}`);
  return JSON.parse(result.output);
}

/** Run resolve-execution expecting a non-zero exit. Returns the raw result. */
function resolveExpectFailure(tmpDir, args) {
  const result = runGsdTools(`resolve-execution ${args}`, tmpDir);
  assert.ok(!result.success, `resolve-execution ${args} unexpectedly succeeded`);
  return result;
}

describe('resolve-execution: provider escalation on quota-exceeded (#2296)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── Back-compat: the default contract must not move ───────────────────────
  //
  // Hyrum's Law guard. Every existing consumer of `resolve-execution` reads this
  // JSON. Adding provider escalation must be invisible unless --failure-class is
  // explicitly passed, exactly as #2068 gated the model on an explicit --attempt.
  describe('back-compat — no --failure-class means no behavior change', () => {
    beforeEach(() => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5', 'llama-3.3'] }));
    });

    test('omitting --failure-class emits no `escalation` key at all', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1');
      assert.ok(
        !Object.hasOwn(parsed, 'escalation'),
        'the escalation block must be absent unless --failure-class is passed',
      );
    });

    test('omitting --failure-class keeps the TIER ladder (attempt 1 -> opus), ignoring provider_escalation', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1');
      assert.strictEqual(parsed.model, 'opus');
    });

    test('a configured provider_escalation does not leak into the no-attempt classic path', () => {
      const parsed = resolve(tmpDir, 'gsd-executor');
      assert.strictEqual(parsed.model, 'sonnet');
      assert.ok(!Object.hasOwn(parsed, 'escalation'));
    });
  });

  // ─── Core behavior: quota-exceeded walks the provider list ─────────────────
  //
  // provider_escalation has 2 entries and max_escalations is 2, so cap == 2 and
  // the limit-1 / limit / limit+1 boundaries are all observable.
  describe('quota-exceeded — walks provider_escalation (cap == 2)', () => {
    beforeEach(() => {
      writeConfig(tmpDir, routingConfig({
        provider_escalation: ['gpt-5', 'llama-3.3'],
        max_escalations: 2,
      }));
    });

    test('attempt 0 stays on the source model and does not escalate', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 0 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'sonnet');
      assert.strictEqual(parsed.escalation.escalated, false);
      assert.strictEqual(parsed.escalation.exhausted, false);
      assert.strictEqual(parsed.escalation.index, 0);
    });

    // Boundary: cap - 1
    test('attempt 1 (cap-1) escalates to the FIRST provider and reports from -> to', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'gpt-5');
      assert.strictEqual(parsed.escalation.escalated, true);
      assert.strictEqual(parsed.escalation.exhausted, false);
      assert.strictEqual(parsed.escalation.from, 'sonnet');
      assert.strictEqual(parsed.escalation.to, 'gpt-5');
      assert.strictEqual(parsed.escalation.index, 1);
      assert.deepStrictEqual(parsed.escalation.attempted, ['sonnet', 'gpt-5']);
    });

    // Boundary: exactly cap
    test('attempt 2 (== cap) escalates to the SECOND provider, still not exhausted', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 2 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'llama-3.3');
      assert.strictEqual(parsed.escalation.escalated, true);
      assert.strictEqual(parsed.escalation.exhausted, false);
      assert.strictEqual(parsed.escalation.index, 2);
      assert.deepStrictEqual(parsed.escalation.attempted, ['sonnet', 'gpt-5', 'llama-3.3']);
    });

    // Boundary: cap + 1 — the ladder is spent; the caller must be able to fail loudly.
    test('attempt 3 (cap+1) reports exhausted:true and names every model attempted', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 3 --failure-class quota-exceeded');
      assert.strictEqual(parsed.escalation.exhausted, true);
      assert.strictEqual(parsed.escalation.index, 2, 'index must pin at the cap, not run past it');
      assert.strictEqual(parsed.model, 'llama-3.3', 'model pins at the last provider once exhausted');
      assert.deepStrictEqual(
        parsed.escalation.attempted,
        ['sonnet', 'gpt-5', 'llama-3.3'],
        'attempted must name every model tried so the caller can report them',
      );
    });

    test('the echoed class is the class that was passed in', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.escalation.class, 'quota-exceeded');
    });
  });

  // ─── The cap is min(max_escalations, list length) ──────────────────────────
  describe('cap is the smaller of max_escalations and the list length', () => {
    test('a list SHORTER than max_escalations exhausts at the list length', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['only-one'], max_escalations: 5 }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 2 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'only-one');
      assert.strictEqual(parsed.escalation.exhausted, true);
      assert.strictEqual(parsed.escalation.index, 1);
    });

    test('max_escalations SMALLER than the list caps before the list ends', () => {
      writeConfig(tmpDir, routingConfig({
        provider_escalation: ['first', 'second', 'third'],
        max_escalations: 1,
      }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 2 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'first', 'must not reach "second" past the cap');
      assert.strictEqual(parsed.escalation.exhausted, true);
      assert.strictEqual(parsed.escalation.index, 1);
    });

    test('max_escalations: 0 disables escalation entirely', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5'], max_escalations: 0 }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'sonnet');
      assert.strictEqual(parsed.escalation.escalated, false);
      assert.strictEqual(parsed.escalation.exhausted, true, 'a zero cap is immediately spent');
    });

    test('escalate_on_failure:false is a kill switch for provider escalation too', () => {
      writeConfig(tmpDir, routingConfig({
        provider_escalation: ['gpt-5'],
        escalate_on_failure: false,
      }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'sonnet');
      assert.strictEqual(parsed.escalation.escalated, false);
    });
  });

  // ─── Opt-in gating: nothing happens unless configured ──────────────────────
  describe('opt-in gating', () => {
    test('quota-exceeded with NO provider_escalation configured falls back to the tier ladder', () => {
      writeConfig(tmpDir, routingConfig({}));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'opus', 'unconfigured means the existing tier ladder still applies');
      assert.strictEqual(parsed.escalation.escalated, false);
    });

    test('dynamic_routing disabled ignores provider_escalation', () => {
      writeConfig(tmpDir, {
        dynamic_routing: { enabled: false, tier_models: TIER_MODELS, provider_escalation: ['gpt-5'] },
      });
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'sonnet');
      assert.strictEqual(parsed.escalation.escalated, false);
    });

    test('a NON-quota failure class never touches the provider list', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5'] }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class unknown-failure');
      assert.strictEqual(parsed.model, 'opus', 'non-quota failures keep the tier ladder');
      assert.strictEqual(parsed.escalation.escalated, false);
      assert.strictEqual(parsed.escalation.class, 'unknown-failure');
    });

    test('classify-handoff-bug does not trigger provider escalation', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5'] }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class classify-handoff-bug');
      assert.strictEqual(parsed.escalation.escalated, false);
    });
  });

  // ─── Hostile / malformed config (QA matrix: malformed, hostile, wrong type) ─
  describe('malformed provider_escalation is rejected without crashing', () => {
    const cases = [
      ['a scalar where an array is expected', 'gpt-5'],
      ['an object where an array is expected', { 0: 'gpt-5' }],
      ['an empty array', []],
      ['null', null],
      ['an array of only invalid entries', [null, 42, '', '   ', {}]],
    ];

    for (const [label, value] of cases) {
      test(`${label} falls back to the tier ladder and never throws`, () => {
        writeConfig(tmpDir, routingConfig({ provider_escalation: value }));
        const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
        assert.strictEqual(parsed.model, 'opus');
        assert.strictEqual(parsed.escalation.escalated, false);
      });
    }

    test('invalid entries are dropped and the surviving entries keep their order', () => {
      writeConfig(tmpDir, routingConfig({
        provider_escalation: [null, 'good-one', '', 42, '  ', 'good-two'],
        max_escalations: 5,
      }));
      const first = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(first.model, 'good-one');
      const second = resolve(tmpDir, 'gsd-executor --attempt 2 --failure-class quota-exceeded');
      assert.strictEqual(second.model, 'good-two');
      assert.strictEqual(second.escalation.exhausted, false);
    });

    test('a prototype-polluting key in the list is not treated as an entry', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['__proto__', 'constructor'] }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      // These are ordinary strings, not lookups — they must be passed through as
      // opaque model ids and must not mutate any prototype.
      assert.strictEqual(parsed.model, '__proto__');
      assert.strictEqual({}.polluted, undefined);
    });

    test('a negative max_escalations does not invert the cap', () => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5'], max_escalations: -3 }));
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class quota-exceeded');
      assert.strictEqual(parsed.escalation.index, 0);
      assert.strictEqual(parsed.escalation.escalated, false);
    });
  });

  // ─── CLI contract: --failure-class negative matrix ─────────────────────────
  describe('--failure-class CLI negative matrix', () => {
    beforeEach(() => {
      writeConfig(tmpDir, routingConfig({ provider_escalation: ['gpt-5'] }));
    });

    test('an unknown class value is a usage error, not a silent no-op', () => {
      const result = resolveExpectFailure(tmpDir, 'gsd-executor --attempt 1 --failure-class bogus-class');
      assert.ok(!/\bat .*:\d+:\d+/.test(result.error || ''), 'must not leak a stack trace');
    });

    test('an empty --failure-class value is a usage error', () => {
      resolveExpectFailure(tmpDir, 'gsd-executor --attempt 1 --failure-class=');
    });

    test('a missing value for --failure-class is a usage error', () => {
      resolveExpectFailure(tmpDir, 'gsd-executor --failure-class');
    });

    test('a flag-shaped value for --failure-class is a usage error', () => {
      resolveExpectFailure(tmpDir, 'gsd-executor --failure-class --attempt');
    });

    test('the --failure-class=value form is accepted', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --attempt 1 --failure-class=quota-exceeded');
      assert.strictEqual(parsed.model, 'gpt-5');
    });

    test('shell metacharacters in the class value are rejected, never interpolated', () => {
      const result = resolveExpectFailure(
        tmpDir,
        'gsd-executor --attempt 1 --failure-class "quota-exceeded; touch pwned"',
      );
      assert.ok(!fs.existsSync(path.join(tmpDir, 'pwned')), 'no shell interpolation may occur');
      assert.ok(!/\bat .*:\d+:\d+/.test(result.error || ''), 'must not leak a stack trace');
    });

    test('--failure-class without --attempt does not escalate', () => {
      const parsed = resolve(tmpDir, 'gsd-executor --failure-class quota-exceeded');
      assert.strictEqual(parsed.model, 'sonnet', 'no attempt counter means no escalation step');
      assert.strictEqual(parsed.escalation.escalated, false);
    });
  });

  // ─── Config-key registration (behavioral, per CONTRIBUTING.md) ─────────────
  describe('dynamic_routing.provider_escalation is a registered config key', () => {
    // argv-array form: the string form of runGsdTools strips inner quotes,
    // which would mangle the JSON value into `[gpt-5,llama-3.3]`.
    test('config-set accepts the key and persists the value', () => {
      const result = runGsdTools(
        ['config-set', 'dynamic_routing.provider_escalation', '["gpt-5","llama-3.3"]'],
        tmpDir,
      );
      assert.ok(result.success, `config-set should accept the key: ${result.error}`);
      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
      assert.deepStrictEqual(config.dynamic_routing?.provider_escalation, ['gpt-5', 'llama-3.3']);
    });

    test('a sibling typo under dynamic_routing is still rejected', () => {
      const result = runGsdTools(
        ['config-set', 'dynamic_routing.provider_escalations', '["x"]'],
        tmpDir,
      );
      assert.ok(!result.success, 'the regex must not have been widened into a catch-all');
    });
  });

  // ─── Property: the resolved model is always drawn from the declared ladder ──
  //
  // This is the budget-limit invariant. Whatever the attempt counter and list,
  // the resolver may only ever return the source model or an entry from the
  // configured list, and may never walk past the cap. Deterministic seed, bounded
  // runs, replay data printed on failure.
  describe('property — the resolver never invents a model or walks past the cap', () => {
    test('resolved model is always source-or-listed, and index <= cap', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0), {
            minLength: 1,
            maxLength: 4,
          }),
          fc.integer({ min: 0, max: 6 }),
          fc.integer({ min: 0, max: 6 }),
          (list, maxEscalations, attempt) => {
            const dir = createTempProject();
            try {
              writeConfig(dir, routingConfig({
                provider_escalation: list,
                max_escalations: maxEscalations,
              }));
              const parsed = resolve(dir, `gsd-executor --attempt ${attempt} --failure-class quota-exceeded`);
              const cap = Math.min(maxEscalations, list.length);
              const allowed = new Set(['sonnet', ...list.slice(0, cap)]);
              assert.ok(
                allowed.has(parsed.model),
                `resolved "${parsed.model}" outside the declared ladder ${JSON.stringify([...allowed])}`,
              );
              assert.ok(
                parsed.escalation.index <= cap,
                `index ${parsed.escalation.index} walked past cap ${cap}`,
              );
            } finally {
              cleanup(dir);
            }
          },
        ),
        { numRuns: 25, seed: 2296, verbose: true },
      );
    });
  });
});

'use strict';

/**
 * Reviewer Instances feature (#1517) — custom reviewer instances for /gsd:review.
 *
 * Locks the instance-resolution contract:
 *   - normalizeReviewerInstances (config-set validation surface)
 *   - resolveReviewerSelection instance expansion (config_default branch only)
 *   - single-source instance→cli resolution parity (DEFECT.GENERATIVE-FIX)
 *
 * Regression-must-fail-first: these tests are written before the implementation
 * and must demonstrate the failure (missing export / missing behaviour) before
 * the resolver is extended.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_REVIEWER_SLUGS,
  normalizeReviewerInstances,
  resolveReviewerSelection,
} = require('../gsd-core/bin/lib/review-reviewer-selection.cjs');

describe('normalizeReviewerInstances (#1517)', () => {
  test('accepts a valid instance map and normalizes fields', () => {
    const r = normalizeReviewerInstances({
      'opencode-deepseek': { cli: 'opencode', model: 'deepseek/deepseek-v4-pro', agent: 'review' },
      'codex-fast': { cli: 'codex', model: 'gpt-5-mini' },
    });
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.instances['opencode-deepseek']);
    assert.strictEqual(r.instances['opencode-deepseek'].cli, 'opencode');
    assert.strictEqual(r.instances['opencode-deepseek'].model, 'deepseek/deepseek-v4-pro');
    assert.strictEqual(r.instances['opencode-deepseek'].agent, 'review');
    assert.strictEqual(r.instances['codex-fast'].agent, undefined);
  });

  test('absent (undefined/null) yields an empty instance set with no errors', () => {
    assert.deepStrictEqual(normalizeReviewerInstances(undefined), { instances: {}, errors: [] });
    assert.deepStrictEqual(normalizeReviewerInstances(null), { instances: {}, errors: [] });
  });

  test('rejects a non-object value', () => {
    const r = normalizeReviewerInstances('nope');
    assert.ok(r.errors.length > 0);
    assert.deepStrictEqual(r.instances, {});
  });

  test('rejects an instance name that does not match the slug pattern', () => {
    const r = normalizeReviewerInstances({
      'Opencode_Bad': { cli: 'opencode' },          // uppercase + underscore
      'opencode deepseek': { cli: 'opencode' },     // space
      '9lead': { cli: 'opencode' },                 // leading digit is allowed; sanity below
    });
    // ^[a-z0-9][a-z0-9-]*$  → '9lead' is valid; the other two are not.
    assert.ok(r.errors.some((e) => e.includes('Opencode_Bad')), `got: ${JSON.stringify(r.errors)}`);
    assert.ok(r.errors.some((e) => e.includes('opencode deepseek')), `got: ${JSON.stringify(r.errors)}`);
    assert.ok(r.instances['9lead'], 'leading-digit names are permitted by the pattern');
  });

  test('rejects an instance name that collides with a built-in reviewer slug', () => {
    const r = normalizeReviewerInstances({
      opencode: { cli: 'opencode' }, // shadows a built-in slug
    });
    assert.ok(
      r.errors.some((e) => /must not equal a built-in reviewer slug/i.test(e) && e.includes('opencode')),
      `got: ${JSON.stringify(r.errors)}`,
    );
    assert.ok(!r.instances['opencode']);
  });

  test('rejects an instance whose cli is not a known adapter', () => {
    const r = normalizeReviewerInstances({
      'evil-instance': { cli: 'rm -rf /' },          // not a known slug; must not become a shell command
      'weird-instance': { cli: 'totally-made-up' },
    });
    assert.ok(r.errors.some((e) => e.includes('evil-instance')), `got: ${JSON.stringify(r.errors)}`);
    assert.ok(r.errors.some((e) => e.includes('weird-instance')), `got: ${JSON.stringify(r.errors)}`);
  });

  test('rejects an instance with a missing cli', () => {
    const r = normalizeReviewerInstances({
      'no-cli': { model: 'some/model' },
    });
    assert.ok(r.errors.some((e) => e.includes('no-cli') && /cli/i.test(e)), `got: ${JSON.stringify(r.errors)}`);
  });

  test('rejects non-string model / agent values', () => {
    const r = normalizeReviewerInstances({
      'bad-model': { cli: 'opencode', model: 42 },
      'bad-agent': { cli: 'opencode', agent: { x: 1 } },
    });
    assert.ok(r.errors.some((e) => e.includes('bad-model')), `got: ${JSON.stringify(r.errors)}`);
    assert.ok(r.errors.some((e) => e.includes('bad-agent')), `got: ${JSON.stringify(r.errors)}`);
  });
});

describe('resolveReviewerSelection — instance expansion (#1517)', () => {
  const INSTANCES = {
    'opencode-deepseek': { cli: 'opencode', model: 'deepseek/deepseek-v4-pro', agent: 'review' },
    'opencode-mimo': { cli: 'opencode', model: 'xiaomi/mimo-v2.5-pro' },
  };

  test('two same-cli instances in default_reviewers resolve as independent identities and flag the shared adapter', () => {
    const r = resolveReviewerSelection({
      detected: ['opencode', 'codex'],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek', 'opencode-mimo', 'codex'],
      reviewerInstances: INSTANCES,
    });

    assert.strictEqual(r.source, 'config_default');
    // selected carries all three identities (codex is a builtin slug)
    assert.ok(r.selected.includes('opencode-deepseek'));
    assert.ok(r.selected.includes('opencode-mimo'));
    assert.ok(r.selected.includes('codex'));
    // resolvedInstances carries the instance→cli mapping (single-source parity anchor)
    const ds = r.resolvedInstances.find((x) => x.identity === 'opencode-deepseek');
    const mimo = r.resolvedInstances.find((x) => x.identity === 'opencode-mimo');
    assert.ok(ds, 'opencode-deepseek must be resolved');
    assert.ok(mimo, 'opencode-mimo must be resolved');
    assert.strictEqual(ds.kind, 'instance');
    assert.strictEqual(ds.cli, 'opencode');
    assert.strictEqual(ds.model, 'deepseek/deepseek-v4-pro');
    assert.strictEqual(ds.agent, 'review');
    assert.strictEqual(mimo.cli, 'opencode');
    // ≥2 selected instances share a cli → caveat flag set
    assert.ok(r.sharedAdapterCaveat, 'two opencode instances must set sharedAdapterCaveat');
    assert.deepStrictEqual(r.errors, []);
  });

  test('a single same-cli instance does not trip the shared-adapter caveat', () => {
    const r = resolveReviewerSelection({
      detected: ['opencode', 'codex'],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek', 'codex'],
      reviewerInstances: INSTANCES,
    });
    assert.ok(!r.sharedAdapterCaveat);
  });

  test('an instance referenced in default_reviewers with no definition is a HARD error when instances are configured', () => {
    const r = resolveReviewerSelection({
      detected: ['opencode'],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek', 'typo-instance'],
      reviewerInstances: INSTANCES,
    });
    assert.ok(
      r.errors.some((e) => e.includes('typo-instance')),
      `expected a hard error naming the undefined instance, got: ${JSON.stringify(r.errors)}`,
    );
    assert.ok(!r.selected.includes('typo-instance'));
  });

  test('backward compat: with no instances configured, an unknown slug still warns + drops (not a hard error)', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['unknown_slug', 'codex'],
    });
    assert.ok(
      r.warnings.some((w) => w.includes('unknown_slug')),
      `expected warn+drop for unknown slug when no instances configured, got: ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(
      !r.errors.some((e) => e.includes('unknown_slug')),
      'unknown slug must NOT be a hard error when no instances are configured',
    );
  });

  test('an instance whose base cli is not detected is excluded with an info note', () => {
    const r = resolveReviewerSelection({
      detected: ['codex'], // opencode not installed
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek', 'codex'],
      reviewerInstances: INSTANCES,
    });
    assert.ok(!r.selected.includes('opencode-deepseek'));
    assert.ok(
      r.infos.some((i) => i.includes('opencode-deepseek')),
      `expected an info note for the undetected instance, got: ${JSON.stringify(r.infos)}`,
    );
    assert.ok(r.selected.includes('codex'));
  });

  test('instances do NOT participate in the explicit_flags or all_flag branches', () => {
    const explicit = resolveReviewerSelection({
      detected: ['opencode'],
      explicitFlags: ['opencode'],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek'],
      reviewerInstances: INSTANCES,
    });
    assert.strictEqual(explicit.source, 'explicit_flags');
    assert.ok(!explicit.selected.includes('opencode-deepseek'), 'instances must not leak into explicit_flags');

    const all = resolveReviewerSelection({
      detected: ['opencode'],
      explicitFlags: [],
      allFlag: true,
      configuredDefaultReviewers: ['opencode-deepseek'],
      reviewerInstances: INSTANCES,
    });
    assert.strictEqual(all.source, 'all_flag');
    assert.ok(!all.selected.includes('opencode-deepseek'), 'instances must not leak into all_flag');
  });

  test('parity (DEFECT.GENERATIVE-FIX): every resolved instance cli equals its configured cli field', () => {
    const r = resolveReviewerSelection({
      detected: ['opencode', 'codex'],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: ['opencode-deepseek', 'opencode-mimo', 'codex'],
      reviewerInstances: INSTANCES,
    });
    for (const res of r.resolvedInstances) {
      if (res.kind === 'instance') {
        const configured = INSTANCES[res.identity];
        assert.ok(configured, `resolved instance ${res.identity} has no configured definition`);
        assert.strictEqual(res.cli, configured.cli, `cli mapping diverged for ${res.identity}`);
        assert.strictEqual(res.model, configured.model, `model diverged for ${res.identity}`);
        assert.strictEqual(res.agent, configured.agent, `agent diverged for ${res.identity}`);
      } else {
        assert.ok(KNOWN_REVIEWER_SLUGS.includes(res.identity), `builtin identity ${res.identity} is not a known slug`);
      }
    }
  });
});

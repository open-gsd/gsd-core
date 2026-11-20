/**
 * #6165 — the Codex installer accepts the current documented `[agents]` settings and leaves dotted keys under
 * `[features]` where they are.
 *
 * Two independent assumptions in bin/install.js aborted a Codex update (post-write schema validation failed and the
 * install rolled back): the bare `[agents]` allowlist lacked `enabled`, `max_concurrent_threads_per_session`,
 * `default_subagent_model` and `default_subagent_reasoning_effort`, and the trapped-key repair relocated every
 * non-boolean dotted assignment under `[features]` above the header.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const {
  validateCodexConfigSchema,
  extractCodexUserAgentsScalars,
  mergeCodexConfig,
  generateCodexConfigBlock,
  ensureCodexHooksFeature,
  repairTrappedFeaturesKeys,
  parseTomlToObject,
} = require('../bin/install.js');

const MARKER = '# GSD Agent Configuration — managed by gsd-core installer';
const FOUR_KEYS = [
  'enabled = true',
  'max_concurrent_threads_per_session = 4',
  'default_subagent_model = "gpt-5"',
  'default_subagent_reasoning_effort = "high"',
];

describe('#6165: bare [agents] accepts the documented AgentsToml scalars', () => {
  for (const line of FOUR_KEYS) {
    test(`${line.split(' ')[0]} validates beside max_depth`, () => {
      const config = ['[agents]', line, 'max_depth = 1', ''].join('\n');
      assert.equal(validateCodexConfigSchema(config).ok, true);
    });
  }

  test('all four keys plus max_threads validate together', () => {
    const config = ['[agents]', ...FOUR_KEYS, 'max_threads = 6', 'max_depth = 1', ''].join('\n');
    assert.equal(validateCodexConfigSchema(config).ok, true);
  });

  test('an unknown key, an [[agents]] array and a multiline-string value are still rejected', () => {
    assert.equal(validateCodexConfigSchema(['[agents]', 'enabled = true', 'bogus_key = 1', ''].join('\n')).ok, false);
    assert.equal(validateCodexConfigSchema(['[[agents]]', 'name = "x"', ''].join('\n')).ok, false);
    for (const quote of ["'''", '"""']) {
      const config = ['[agents]', `default_subagent_model = ${quote}`, 'gpt-5', quote, ''].join('\n');
      assert.equal(validateCodexConfigSchema(config).ok, false, `${quote} multiline value`);
    }
    assert.equal(
      validateCodexConfigSchema(['[agents]', 'default_subagent_model = """gpt-5"""', ''].join('\n')).ok,
      false,
      'a triple-quoted value that closes on its own line is still a multiline-string form',
    );
  });

  test('the extractor and the validator share one key set: every accepted key is preserved, in order', () => {
    const config = ['[agents]', ...FOUR_KEYS, 'max_threads = 6', 'max_depth = 3', ''].join('\n');
    assert.deepEqual(extractCodexUserAgentsScalars(config), [...FOUR_KEYS, 'max_threads = 6']);
    for (const kept of extractCodexUserAgentsScalars(config)) {
      assert.equal(validateCodexConfigSchema(['[agents]', kept, ''].join('\n')).ok, true, kept);
    }
  });

  test('the extractor does not keep the first line of a multiline-string value', () => {
    const config = ['[agents]', 'default_subagent_model = """', 'gpt-5', '"""', 'max_threads = 2', ''].join('\n');
    assert.deepEqual(extractCodexUserAgentsScalars(config), ['max_threads = 2']);
  });
});

describe('#6165: the four agent keys survive a merge unchanged', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6165-')); });
  afterEach(() => cleanup(tmp));

  test('install over the reported config keeps all four lines, validates, and a second merge is byte-identical', () => {
    const configPath = path.join(tmp, 'config.toml');
    const before = [
      'model = "gpt-5"',
      '',
      MARKER,
      '',
      '[agents]',
      ...FOUR_KEYS,
      'max_threads = 6',
      'max_depth = 2',
      '',
      '[features]',
      'multi_agent_v2.batch_size = 5',
      'multi_agent_v2.hide_spawn_agent_metadata = true',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, before);
    const block = generateCodexConfigBlock([{ name: 'gsd-executor', description: 'Executes plans' }]);

    mergeCodexConfig(configPath, block);
    const first = fs.readFileSync(configPath, 'utf8');

    for (const line of [...FOUR_KEYS, 'max_threads = 6']) assert.ok(first.includes(`${line}\n`), `${line} preserved`);
    assert.match(first, /^max_depth = 1$/m, 'GSD re-pins max_depth');
    assert.equal(validateCodexConfigSchema(first).ok, true);
    const after = parseTomlToObject(first);
    assert.equal(after.agents.enabled, true);
    assert.equal(after.agents.max_concurrent_threads_per_session, 4);
    assert.equal(after.agents.default_subagent_model, 'gpt-5');
    assert.equal(after.agents.default_subagent_reasoning_effort, 'high');

    mergeCodexConfig(configPath, block);
    assert.equal(fs.readFileSync(configPath, 'utf8'), first);
  });
});

describe('#6165: dotted assignments under [features] keep their table', () => {
  const featuresOf = (content) => parseTomlToObject(content).features;

  test('numeric, string and boolean dotted keys stay under [features] through the hooks-feature preparation', () => {
    const config = [
      '[projects."/work/app"]',
      'trust_level = "trusted"',
      '',
      '[features]',
      'multi_agent_v2.batch_size = 5',
      'multi_agent_v2.mode = "fast"',
      'multi_agent_v2.hide_spawn_agent_metadata = true',
      '',
    ].join('\n');
    const { content } = ensureCodexHooksFeature(config);
    const features = featuresOf(content);
    assert.equal(features.multi_agent_v2.batch_size, 5);
    assert.equal(features.multi_agent_v2.mode, 'fast');
    assert.equal(features.multi_agent_v2.hide_spawn_agent_metadata, true);
    assert.deepEqual(parseTomlToObject(content).projects['/work/app'], { trust_level: 'trusted' }, 'the preceding table gained nothing');
  });

  test('a plain non-boolean key trapped under [features] is still relocated to file scope', () => {
    const config = ['[features]', 'model = "x"', 'multi_agent = true', ''].join('\n');
    const repaired = repairTrappedFeaturesKeys(config);
    const parsed = parseTomlToObject(repaired);
    assert.equal(parsed.model, 'x');
    assert.equal(parsed.features.model, undefined);
    assert.equal(parsed.features.multi_agent, true);
  });

  for (const [segments, line] of [
    [1, 'level = "x"'],
    [2, 'a.level = 4'],
    [3, 'a.b.level = "x"'],
  ]) {
    test(`key-segment boundary: ${segments} segment(s) — ${segments === 1 ? 'relocated' : 'left in place'}`, () => {
      const config = ['[features]', line, ''].join('\n');
      const repaired = repairTrappedFeaturesKeys(config);
      if (segments === 1) assert.notEqual(repaired, config);
      else assert.equal(repaired, config);
    });
  }

  test('property: any dotted non-boolean assignment under [features] is left untouched', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
    const value = fc.oneof(
      fc.integer({ min: 0, max: 1000000 }).map(String),
      segment.map((s) => `"${s}"`),
    );
    fc.assert(
      fc.property(fc.array(segment, { minLength: 2, maxLength: 4 }), value, (segments, v) => {
        const config = ['[features]', `${segments.join('.')} = ${v}`, ''].join('\n');
        assert.equal(repairTrappedFeaturesKeys(config), config);
      }),
      { numRuns: 60 },
    );
  });
});

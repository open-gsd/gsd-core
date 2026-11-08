/**
 * #6029 (C2 of epic #4633, ADR-1411 Decisions 3-4): one argv parser and one
 * emission projection own the `config-get` CLI boundary.
 *
 * - `parseConfigArgValue` is the single argv value parser, shared by
 *   `config-set` and `config-get --default`.
 * - `encodeConfigValue` is the single emission projection for every
 *   `cmdConfigGet` arm (present, root-inherited, --default, schema default).
 * - JSON mode round-trips; raw mode is frozen (argv bytes for --default,
 *   `String(v)` for resolved values).
 *
 * Regressions: #4262 / #4382 (`--default '[]'` emitted the string "[]"), a
 * secret `--raw --default null` masking the four-character text "null" as
 * `****`, and `planner.stall_detection_enabled --default false` resolving true.
 *
 * In-process only; the CLI-subprocess acceptance lives in
 * config-get-encoder-6029.integration.test.cjs.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, captureFdSync, createTempProject } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const config = require(path.join(LIB, 'config.cjs'));
const { CONFIG_DEFAULTS } = require(path.join(LIB, 'config-loader.cjs'));
const { getCapabilityConfigSchema } = require(path.join(LIB, 'config-schema.cjs'));

/** Run cmdConfigGet in-process and return what it wrote to fd 1, minus one trailing newline. */
function runConfigGet(cwd, key, { raw = false, def } = {}) {
  return captureFdSync(1, () => config.cmdConfigGet(cwd, key, raw, def)).replace(/\n$/, '');
}

/** The strings the parser leaves as strings: a string default must be one of these to stay a string. */
const plainString = fc.string().filter((s) => config.parseConfigArgValue(s) === s);
const jsonScalar = fc.oneof(
  fc.boolean(),
  fc.constant(null),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
  plainString,
);
const jsonValue = fc.oneof(
  jsonScalar,
  fc.array(fc.oneof(fc.boolean(), fc.integer(), plainString, fc.constant(null)), { maxLength: 4 }),
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 6 }).filter((k) => k !== '__proto__'),
    fc.oneof(fc.boolean(), fc.integer(), plainString),
    { maxKeys: 4 },
  ),
);

/** [argv text, value the parser must produce] — the decimal-literal boundary (owner ruling 2026-11-08). */
const PARSER_BOUNDARY = [
  [' ', ' '],
  [' 5', ' 5'],
  ['5 ', '5 '],
  ['0x10', '0x10'],
  ['0b1', '0b1'],
  ['1e400', '1e400'],
  ['', ''],
  ['.5', 0.5],
  ['+5', 5],
  ['5.', 5],
  ['007', 7],
  ['5.0', 5],
  ['1e3', 1000],
  ['-1', -1],
];

function writeConfig(tmp, value) {
  fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function readStored(tmp, keyPath) {
  const parsed = JSON.parse(fs.readFileSync(path.join(tmp, '.planning', 'config.json'), 'utf8'));
  return keyPath.split('.').reduce((node, key) => node[key], parsed);
}

describe('#6029: config-get emits --default as the JSON value it spells', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject('gsd-6029-');
    writeConfig(tmp, '{}');
  });
  afterEach(() => cleanup(tmp));

  test("#4262/#4382: --default '[]' emits a JSON array, not a string", () => {
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'workflow.code_review_depth_overrides', { def: '[]' })), []);
  });

  test('--default scalars and objects emit their JSON value', () => {
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: '5' })), 5);
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'true' })), true);
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'false' })), false);
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'null' })), null);
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'missing.key', { def: '{"a":1}' })), { a: 1 });
  });

  test('--default strings stay strings', () => {
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'abc' })), 'abc');
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: '' })), '');
  });

  test('unparseable --default stays a string', () => {
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: '[bad' })), '[bad');
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'Infinity' })), 'Infinity');
    assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: 'NaN' })), 'NaN');
  });

  test('parser boundary table: parseConfigArgValue and JSON --default agree, raw --default keeps argv text', () => {
    for (const [text, expected] of PARSER_BOUNDARY) {
      const label = JSON.stringify(text);
      assert.deepEqual(config.parseConfigArgValue(text), expected, `parser ${label}`);
      assert.deepEqual(JSON.parse(runConfigGet(tmp, 'missing.key', { def: text })), expected, `json --default ${label}`);
      assert.equal(runConfigGet(tmp, 'missing.key', { raw: true, def: text }), text, `raw --default ${label}`);
    }
  });

  test('raw --default keeps argv bytes (ADR-1411 Decision 4 freeze)', () => {
    for (const text of ['007', '5.0', '1e3', '[]', '{"a":1}', 'null', 'abc', '']) {
      assert.equal(runConfigGet(tmp, 'missing.key', { raw: true, def: text }), text, `raw --default ${JSON.stringify(text)}`);
    }
  });

  test('raw present values render as String(value), as before', () => {
    writeConfig(tmp, {
      ship: { pr_body_sections: ['a', 'b'] },
      review: { max_prompt_tokens: 200000 },
      workflow: { code_review_depth_overrides: [{ paths: ['src/'], depth: 'deep' }] },
    });
    assert.equal(runConfigGet(tmp, 'ship.pr_body_sections', { raw: true }), 'a,b');
    assert.equal(runConfigGet(tmp, 'review.max_prompt_tokens', { raw: true }), '200000');
    assert.equal(runConfigGet(tmp, 'workflow.code_review_depth_overrides', { raw: true }), '[object Object]');
  });

  test('every absent arm parses --default: no config.json, and a non-object mid-path', () => {
    fs.unlinkSync(path.join(tmp, '.planning', 'config.json'));
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'any.key', { def: '[]' })), []);
    writeConfig(tmp, { workflow: 'flat' });
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'workflow.deep.key', { def: '[1]' })), [1]);
  });

  test('present key ignores --default (#1893)', () => {
    writeConfig(tmp, { ship: { pr_body_sections: ['x'] } });
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'ship.pr_body_sections', { def: '[]' })), ['x']);
  });

  test('secret --raw --default null masks the value null as (unset)', () => {
    for (const key of ['brave_search', 'firecrawl', 'exa_search']) {
      assert.equal(runConfigGet(tmp, key, { raw: true, def: 'null' }), '(unset)', key);
      assert.equal(JSON.parse(runConfigGet(tmp, key, { def: 'null' })), '(unset)', key);
    }
  });

  test('secret --default never leaks plaintext, on either output mode', () => {
    const secret = 'sk-plaintext-should-not-leak';
    for (const raw of [true, false]) {
      const out = runConfigGet(tmp, 'brave_search', { raw, def: secret });
      assert.equal(raw ? out : JSON.parse(out), '****leak', `raw=${raw}`);
    }
  });

  test('secret present key is masked on both output modes', () => {
    writeConfig(tmp, { brave_search: 'sk-abcdefgh1234' });
    assert.equal(JSON.parse(runConfigGet(tmp, 'brave_search')), '****1234');
    assert.equal(runConfigGet(tmp, 'brave_search', { raw: true }), '****1234');
  });

  test('secret key with an object --default never contains the plaintext, on either output mode', () => {
    for (const raw of [true, false]) {
      const out = runConfigGet(tmp, 'brave_search', { raw, def: '{"a":"secretvalue"}' });
      assert.ok(!out.includes('secretvalue'), `raw=${raw}: ${out}`);
    }
  });

  test('planner.stall_detection_enabled --default false resolves like a present false', () => {
    assert.equal(JSON.parse(runConfigGet(tmp, 'planner.stall_detection_enabled', { def: 'false' })), false);
    assert.equal(runConfigGet(tmp, 'planner.stall_detection_enabled', { raw: true, def: 'false' }), 'false');
  });

  test('planner.stall_detection_enabled non-boolean --default fails safe to true (#4570)', () => {
    for (const def of ['1', 'abc', 'null']) {
      assert.equal(JSON.parse(runConfigGet(tmp, 'planner.stall_detection_enabled', { def })), true, def);
      assert.equal(runConfigGet(tmp, 'planner.stall_detection_enabled', { raw: true, def }), 'true', def);
    }
  });

  test('config-set stores exactly parseConfigArgValue(text) for a key that accepts the value class', () => {
    const cases = [
      ['hooks.secret_read_exempt', ['[]', '[".env.production"]']],
      ['context_window', ['5']],
      ['workflow.post_planning_gaps', ['true', 'false']],
      ['workflow.code_review_command', ['abc', '5', ' 5', '0x10']],
    ];
    for (const [key, texts] of cases) {
      for (const text of texts) {
        writeConfig(tmp, '{}');
        captureFdSync(1, () => config.cmdConfigSet(tmp, key, text, false));
        const stored = readStored(tmp, key);
        assert.deepEqual(stored, config.parseConfigArgValue(text), `${key} ${JSON.stringify(text)}`);
        assert.deepEqual(JSON.parse(runConfigGet(tmp, 'missing.key', { def: text })), stored, `--default ${JSON.stringify(text)}`);
      }
    }
  });

  test("config-set and --default keep ' 5' and '0x10' strings on a free-text key", () => {
    for (const text of [' 5', '0x10']) {
      writeConfig(tmp, '{}');
      captureFdSync(1, () => config.cmdConfigSet(tmp, 'workflow.code_review_command', text, false));
      assert.equal(readStored(tmp, 'workflow.code_review_command'), text);
      assert.equal(JSON.parse(runConfigGet(tmp, 'missing.key', { def: text })), text);
    }
  });

  test('config-set refuses an overflowing literal that the parser keeps as a string (#1581)', () => {
    assert.equal(config.parseConfigArgValue('1e400'), '1e400');
    writeConfig(tmp, '{}');
    assert.throws(() => captureFdSync(1, () => config.cmdConfigSet(tmp, 'context_window', '1e400', false)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, '.planning', 'config.json'), 'utf8')), {});
  });

  test('JSON-mode round trip (fast-check): --default and present key both decode to the value', () => {
    fc.assert(fc.property(jsonValue, (v) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      assert.deepEqual(JSON.parse(runConfigGet(tmp, 'missing.key', { def: text })), v);
      writeConfig(tmp, { ship: { pr_body_sections: v } });
      assert.deepEqual(JSON.parse(runConfigGet(tmp, 'ship.pr_body_sections')), v);
      writeConfig(tmp, '{}');
    }), { numRuns: 60 });
  });

  test('parser inverts JSON text for every non-string JSON value (fast-check)', () => {
    fc.assert(fc.property(jsonValue.filter((v) => typeof v !== 'string'), (v) => {
      assert.deepEqual(config.parseConfigArgValue(JSON.stringify(v)), v);
    }));
  });

  test('encodeConfigValue: raw text is the source text only when the value was not transformed', () => {
    assert.deepEqual(config.encodeConfigValue('missing.key', [], '[]'), { json: [], text: '[]' });
    assert.deepEqual(config.encodeConfigValue('missing.key', [], undefined), { json: [], text: '' });
    assert.deepEqual(config.encodeConfigValue('planner.stall_detection_enabled', 'x', 'x'), { json: true, text: 'true' });
    assert.deepEqual(config.encodeConfigValue('brave_search', null, 'null'), { json: '(unset)', text: '(unset)' });
  });
});

describe('#6029: schema-default arm (#2256) emits the declared default on both output modes', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject('gsd-6029-sd-');
    writeConfig(tmp, '{}');
  });
  afterEach(() => cleanup(tmp));

  test('workflow.smart_zone_tokens (number, derived from the defaults manifest)', () => {
    const declared = CONFIG_DEFAULTS.smart_zone_tokens;
    assert.equal(typeof declared, 'number');
    assert.equal(JSON.parse(runConfigGet(tmp, 'workflow.smart_zone_tokens')), declared);
    assert.equal(runConfigGet(tmp, 'workflow.smart_zone_tokens', { raw: true }), String(declared));
  });

  test('a capability-registry key with a number default', () => {
    const entry = Object.entries(getCapabilityConfigSchema(tmp))
      .find(([, def]) => def && typeof def === 'object' && typeof def.default === 'number');
    assert.ok(entry, 'the capability registry declares at least one number default');
    const [key, def] = entry;
    assert.equal(JSON.parse(runConfigGet(tmp, key)), def.default);
    assert.equal(runConfigGet(tmp, key, { raw: true }), String(def.default));
  });

  test('an explicit --default outranks the schema default', () => {
    assert.equal(JSON.parse(runConfigGet(tmp, 'workflow.smart_zone_tokens', { def: '7' })), 7);
  });
});

describe('#6029: root-inherited arm (#2702) with a workstream active and no workstream config.json', () => {
  let tmp;
  let priorWorkstream;
  beforeEach(() => {
    tmp = createTempProject('gsd-6029-ws-');
    writeConfig(tmp, '{}');
    priorWorkstream = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'ws-6029';
  });
  afterEach(() => {
    if (priorWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = priorWorkstream;
    cleanup(tmp);
  });

  test('a root array, object and number are emitted: JSON decodes to the value, raw is String(value)', () => {
    const rootValues = { array: ['a', 'b'], object: { a: 1 }, number: 7 };
    writeConfig(tmp, { inherited: rootValues });
    for (const [name, value] of Object.entries(rootValues)) {
      const key = `inherited.${name}`;
      assert.deepEqual(JSON.parse(runConfigGet(tmp, key)), value, `json ${key}`);
      assert.equal(runConfigGet(tmp, key, { raw: true }), String(value), `raw ${key}`);
    }
  });

  test('a present root key wins over --default (#1893)', () => {
    writeConfig(tmp, { inherited: { array: ['a'] } });
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'inherited.array', { def: '[]' })), ['a']);
  });

  test('a key absent from root as well falls through to --default', () => {
    assert.deepEqual(JSON.parse(runConfigGet(tmp, 'inherited.array', { def: '[1]' })), [1]);
  });

  test('a root value round-trips through JSON mode (fast-check)', () => {
    fc.assert(fc.property(jsonValue, (v) => {
      writeConfig(tmp, { x: { y: v } });
      assert.deepEqual(JSON.parse(runConfigGet(tmp, 'x.y')), v);
    }), { numRuns: 40 });
  });
});

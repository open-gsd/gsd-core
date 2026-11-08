/**
 * #6029 (C2 of epic #4633, ADR-1411 Decisions 3-4): one argv parser and one
 * emission projection own the `config-get` CLI boundary.
 *
 * - `parseConfigArgValue` is the single argv value parser, shared by
 *   `config-set` and `config-get --default`.
 * - `projectConfigGetOutput` is the single emission projection for every
 *   `cmdConfigGet` arm (present, root-inherited, --default, schema default).
 * - JSON mode round-trips; raw mode is frozen (argv bytes for --default,
 *   `String(v)` for resolved values).
 *
 * Regressions: #4262 / #4382 (`--default '[]'` emitted the string "[]"), a
 * secret `--raw --default null` masking the four-character text "null" as
 * `****`, and `planner.stall_detection_enabled --default false` resolving true.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, captureFdSync, runGsdTools } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const config = require(path.join(LIB, 'config.cjs'));
const { resolveCodeReviewDepth } = require(path.join(LIB, 'code-review-depth.cjs'));

/** Run cmdConfigGet in-process and return what it wrote to fd 1. */
function get(cwd, key, { raw = false, def } = {}) {
  return captureFdSync(1, () => config.cmdConfigGet(cwd, key, raw, def)).trim();
}

/** Strings the type-directed parser would retype; a string default must avoid them to stay a string. */
const retypedString = (s) => s === 'true' || s === 'false' || s === 'null'
  || (s !== '' && Number.isFinite(Number(s))) || s.startsWith('[') || s.startsWith('{');
const plainString = fc.string().filter((s) => !retypedString(s));
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

describe('#6029: config-get emits --default as the JSON value it spells', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6029-'));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
  });
  afterEach(() => cleanup(tmp));

  test("#4262/#4382: --default '[]' emits a JSON array, not a string", () => {
    assert.deepEqual(JSON.parse(get(tmp, 'workflow.code_review_depth_overrides', { def: '[]' })), []);
  });

  test('--default scalars and objects emit their JSON value', () => {
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: '5' })), 5);
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'true' })), true);
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'false' })), false);
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'null' })), null);
    assert.deepEqual(JSON.parse(get(tmp, 'missing.key', { def: '{"a":1}' })), { a: 1 });
  });

  test('--default strings stay strings', () => {
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'abc' })), 'abc');
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: '' })), '');
  });

  test('unparseable --default stays a string', () => {
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: '[bad' })), '[bad');
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'Infinity' })), 'Infinity');
    assert.equal(JSON.parse(get(tmp, 'missing.key', { def: 'NaN' })), 'NaN');
  });

  test('raw --default keeps argv bytes (ADR-1411 Decision 4 freeze)', () => {
    for (const text of ['007', '5.0', '1e3', '[]', '{"a":1}', 'null', 'abc', '']) {
      assert.equal(get(tmp, 'missing.key', { raw: true, def: text }), text, `raw --default ${JSON.stringify(text)}`);
    }
  });

  test('raw present values render as String(value), as before', () => {
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({
      ship: { pr_body_sections: ['a', 'b'] },
      review: { max_prompt_tokens: 200000 },
      workflow: { code_review_depth_overrides: [{ paths: ['src/'], depth: 'deep' }] },
    }));
    assert.equal(get(tmp, 'ship.pr_body_sections', { raw: true }), 'a,b');
    assert.equal(get(tmp, 'review.max_prompt_tokens', { raw: true }), '200000');
    assert.equal(get(tmp, 'workflow.code_review_depth_overrides', { raw: true }), '[object Object]');
  });

  test('every absent arm parses --default: no config.json, and a non-object mid-path', () => {
    fs.unlinkSync(path.join(tmp, '.planning', 'config.json'));
    assert.deepEqual(JSON.parse(get(tmp, 'any.key', { def: '[]' })), []);
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ workflow: 'flat' }));
    assert.deepEqual(JSON.parse(get(tmp, 'workflow.deep.key', { def: '[1]' })), [1]);
  });

  test('present key ignores --default (#1893)', () => {
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ ship: { pr_body_sections: ['x'] } }));
    assert.deepEqual(JSON.parse(get(tmp, 'ship.pr_body_sections', { def: '[]' })), ['x']);
  });

  test('secret --raw --default null masks the value null as (unset)', () => {
    for (const key of ['brave_search', 'firecrawl', 'exa_search']) {
      assert.equal(get(tmp, key, { raw: true, def: 'null' }), '(unset)', key);
      assert.equal(JSON.parse(get(tmp, key, { def: 'null' })), '(unset)', key);
    }
  });

  test('secret --default never leaks plaintext, on either output mode', () => {
    const secret = 'sk-plaintext-should-not-leak';
    for (const raw of [true, false]) {
      const out = get(tmp, 'brave_search', { raw, def: secret });
      assert.equal(raw ? out : JSON.parse(out), '****leak', `raw=${raw}`);
    }
  });

  test('planner.stall_detection_enabled --default false resolves like a present false', () => {
    assert.equal(JSON.parse(get(tmp, 'planner.stall_detection_enabled', { def: 'false' })), false);
    assert.equal(get(tmp, 'planner.stall_detection_enabled', { raw: true, def: 'false' }), 'false');
  });

  test('planner.stall_detection_enabled non-boolean --default fails safe to true (#4570)', () => {
    for (const def of ['1', 'abc', 'null']) {
      assert.equal(JSON.parse(get(tmp, 'planner.stall_detection_enabled', { def })), true, def);
      assert.equal(get(tmp, 'planner.stall_detection_enabled', { raw: true, def }), 'true', def);
    }
  });

  test('config-set and --default share one parser: the stored value equals the --default value', () => {
    for (const text of ['[]', '["a","b"]', '{"a":1}', '5', 'true', 'abc']) {
      captureFdSync(1, () => config.cmdConfigSet(tmp, 'ship.pr_body_sections', text, false));
      const stored = JSON.parse(fs.readFileSync(path.join(tmp, '.planning', 'config.json'), 'utf8')).ship.pr_body_sections;
      assert.deepEqual(stored, config.parseConfigArgValue(text), text);
      assert.deepEqual(JSON.parse(get(tmp, 'missing.key', { def: text })), stored, text);
    }
  });

  test('JSON-mode round trip (fast-check): --default and present key both decode to the value', () => {
    fc.assert(fc.property(jsonValue, (v) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      assert.deepEqual(JSON.parse(get(tmp, 'missing.key', { def: text })), v);
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ ship: { pr_body_sections: v } }));
      assert.deepEqual(JSON.parse(get(tmp, 'ship.pr_body_sections')), v);
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
    }), { numRuns: 60 });
  });

  test('parser inverts JSON text for every non-string JSON value (fast-check)', () => {
    fc.assert(fc.property(jsonValue.filter((v) => typeof v !== 'string'), (v) => {
      assert.deepEqual(config.parseConfigArgValue(JSON.stringify(v)), v);
    }));
  });

  test('projectConfigGetOutput: raw text is the source text only when the value was not transformed', () => {
    assert.deepEqual(config.projectConfigGetOutput('missing.key', [], '[]'), { json: [], text: '[]' });
    assert.deepEqual(config.projectConfigGetOutput('missing.key', [], undefined), { json: [], text: '' });
    assert.deepEqual(config.projectConfigGetOutput('planner.stall_detection_enabled', 'x', 'x'), { json: true, text: 'true' });
    assert.deepEqual(config.projectConfigGetOutput('brave_search', null, 'null'), { json: '(unset)', text: '(unset)' });
  });
});

describe('#6029 acceptance: /gsd-code-review resolve_depth in a project with no config keys', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6029-cr-'));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
  });
  afterEach(() => cleanup(tmp));

  test("real CLI: query config-get workflow.code_review_depth_overrides --default '[]' feeds the resolver an array", () => {
    const r = runGsdTools(['query', 'config-get', 'workflow.code_review_depth_overrides', '--default', '[]'], tmp, { HOME: tmp });
    assert.equal(r.success, true, r.error);
    const overrides = JSON.parse(r.output);
    assert.ok(Array.isArray(overrides), `expected an array, got ${JSON.stringify(overrides)}`);
    const depth = resolveCodeReviewDepth({ flagDepth: '', configDepth: '', overrides, files: ['src/a.ts'], repoRoot: tmp });
    assert.equal(depth.ok, true, JSON.stringify(depth));
  });
});

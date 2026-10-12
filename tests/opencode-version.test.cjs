'use strict';

/**
 * opencode-version.test.cjs — OpenCode generation detection (ADR-5331 D2/D5, epic #5331, Phase 1 #5337).
 * Exercises the compiled module through its exports with an injected spawn; no OpenCode binary needed.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../gsd-core/bin/lib/opencode-version.cjs');

beforeEach(() => mod.resetOpencodeGenerationMemo());

const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('parseOpencodeVersion accepts bare, prefixed and prerelease forms', () => {
  assert.deepEqual(mod.parseOpencodeVersion('1.19.0\n'), { version: '1.19.0', major: 1 });
  assert.deepEqual(mod.parseOpencodeVersion('2.0.27'), { version: '2.0.27', major: 2 });
  assert.equal(mod.parseOpencodeVersion('opencode v2.1.0-beta.3').major, 2);
  assert.equal(mod.parseOpencodeVersion('\n\n1.2.3\nextra').version, '1.2.3');
});

test('parseOpencodeVersion rejects non-versions', () => {
  for (const bad of ['', 'garbage', 'Error: boom 1.2.3', null, undefined, 7, '1.2']) {
    assert.equal(mod.parseOpencodeVersion(bad), null, String(bad));
  }
});

test('generationForMajor maps majors', () => {
  assert.equal(mod.generationForMajor(0), null);
  assert.equal(mod.generationForMajor(1), 1);
  assert.equal(mod.generationForMajor(2), 2);
  assert.equal(mod.generationForMajor(3), 2);
});

test('probe returns version and runs argv-only without a shell', () => {
  let seen;
  const p = mod.probeOpencodeVersion({
    spawn: (cmd, args, o) => { seen = { cmd, args, o }; return { status: 0, stdout: '2.0.27\n' }; },
  });
  assert.deepEqual([p.ok, p.version, p.major], [true, '2.0.27', 2]);
  assert.equal(seen.cmd, 'opencode');
  assert.deepEqual(seen.args, ['--version']);
  assert.equal(seen.o.shell, false);
  assert.ok(seen.o.timeout > 0);
});

test('probe classifies failures and never throws', () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  const etimedout = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
  assert.equal(mod.probeOpencodeVersion({ spawn: () => ({ status: null, error: enoent }) }).reason, 'missing');
  assert.equal(mod.probeOpencodeVersion({ spawn: () => ({ status: null, error: etimedout }) }).reason, 'timeout');
  assert.equal(mod.probeOpencodeVersion({ spawn: () => ({ status: 3, stdout: '' }) }).reason, 'nonzero');
  assert.equal(mod.probeOpencodeVersion({ spawn: ok('hello') }).reason, 'unparseable');
  const thrown = mod.probeOpencodeVersion({ spawn: () => { throw new Error('boom'); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'error');
});

test('detectGenerationSignals reports only 2.x-only evidence', () => {
  const none = mod.detectGenerationSignals({ configDir: '/c', fs: { exists: () => false }, config: { mcp: { x: {} }, agent: {}, permission: {} } });
  assert.deepEqual(none, { generation: null, evidence: [] });
  const some = mod.detectGenerationSignals({
    configDir: '/c',
    fs: { exists: (p) => p.endsWith('cli.json') },
    config: { plugins: [], agents: {}, permissions: [], mcp: { servers: {} } },
  });
  assert.equal(some.generation, 2);
  assert.deepEqual(some.evidence, ['cli.json', 'plugins[]', 'agents{}', 'permissions[]', 'mcp.servers{}']);
});

test('parseGenerationOverride', () => {
  for (const [raw, want] of [[1, 1], ['2', 2], ['V2', 2], ['v1', 1], ['opencode2', 2], ['3', null], ['', null], [undefined, null]]) {
    assert.equal(mod.parseGenerationOverride(raw), want, String(raw));
  }
});

test('resolveOpencodeGeneration precedence: override > probe > signals > unknown', () => {
  const probe = { ok: true, version: '1.19.0', major: 1, raw: '1.19.0' };
  const signals = { generation: 2, evidence: ['cli.json'] };
  assert.equal(mod.resolveOpencodeGeneration({ override: 2, probe, signals }).source, 'override');
  assert.equal(mod.resolveOpencodeGeneration({ override: 2, probe, signals }).generation, 2);
  const viaProbe = mod.resolveOpencodeGeneration({ probe, signals });
  assert.deepEqual([viaProbe.generation, viaProbe.source, viaProbe.version], [1, 'probe', '1.19.0']);
  const viaSignals = mod.resolveOpencodeGeneration({ probe: { ok: false, reason: 'missing', detail: 'x' }, signals });
  assert.deepEqual([viaSignals.generation, viaSignals.source], [2, 'signals']);
  const unknown = mod.resolveOpencodeGeneration({ probe: { ok: false, reason: 'missing', detail: 'x' }, signals: { generation: null, evidence: [] } });
  assert.deepEqual([unknown.generation, unknown.source], [null, 'unknown']);
});

test('detectOpencodeGeneration honours the env override and memoizes', () => {
  let calls = 0;
  const spawn = () => { calls++; return { status: 0, stdout: '1.19.0' }; };
  const a = mod.detectOpencodeGeneration({ overrideEnv: {}, spawn });
  const b = mod.detectOpencodeGeneration({ overrideEnv: {}, spawn });
  assert.equal(a.generation, 1);
  assert.equal(a, b);
  assert.equal(calls, 1);
  mod.resetOpencodeGenerationMemo();
  const c = mod.detectOpencodeGeneration({ overrideEnv: { [mod.OPENCODE_GENERATION_ENV]: 'v2' }, spawn });
  assert.deepEqual([c.generation, c.source], [2, 'override']);
});

test('adaptOrchestratorExecForGeneration drops --dir only for generation 2', () => {
  const oe = { cwdFlag: '--dir', other: 1 };
  assert.deepEqual(mod.adaptOrchestratorExecForGeneration(oe, 2), { cwdFlag: null, other: 1 });
  assert.equal(mod.adaptOrchestratorExecForGeneration(oe, 1), oe);
  assert.equal(mod.adaptOrchestratorExecForGeneration(oe, null), oe);
  const kimi = { cwdFlag: null };
  assert.equal(mod.adaptOrchestratorExecForGeneration(kimi, 2), kimi);
  assert.equal(mod.adaptOrchestratorExecForGeneration(undefined, 2), undefined);
});

test('adaptLaneInputForGeneration moves effort onto the model for opencode on 2.x', () => {
  const mk = (cfg, effortValue = 'high') => ({
    lane: { slug: 'opencode', modelConfigKey: 'k.model' },
    configGet: (key) => cfg[key],
    effortArgs: ['--variant', effortValue],
    effortValue,
  });
  const r = mod.adaptLaneInputForGeneration(mk({ 'k.model': 'p/m' }), 2);
  assert.equal(r.input.configGet('k.model'), 'p/m#high');
  assert.deepEqual(r.input.effortArgs, []);
  assert.deepEqual(r.warnings, []);

  const keep = mod.adaptLaneInputForGeneration(mk({ 'k.model': 'p/m#max' }), 2);
  assert.equal(keep.input.configGet('k.model'), 'p/m#max');

  const warn = mod.adaptLaneInputForGeneration(mk({}), 2);
  assert.deepEqual(warn.input.effortArgs, []);
  assert.equal(warn.warnings.length, 1);

  const v1 = mk({ 'k.model': 'p/m' });
  assert.equal(mod.adaptLaneInputForGeneration(v1, 1).input, v1);
  const other = { ...v1, lane: { slug: 'codex', modelConfigKey: 'k.model' } };
  assert.equal(mod.adaptLaneInputForGeneration(other, 2).input, other);
});

test('adaptLanePlanForGeneration drops the trailing stdin marker only for a stdin-fed opencode plan on 2.x', () => {
  const mk = (over = {}) => ({ ok: true, plan: { slug: 'opencode', stdin: 'prompt', argv: ['run', '--format', 'json', '-'], ...over } });
  assert.deepEqual(mod.adaptLanePlanForGeneration(mk(), 2).plan.argv, ['run', '--standalone', '--format', 'json']);
  const already = mk({ argv: ['run', '--standalone', '-'] });
  assert.deepEqual(mod.adaptLanePlanForGeneration(already, 2).plan.argv, ['run', '--standalone']);
  const v1 = mk();
  assert.equal(mod.adaptLanePlanForGeneration(v1, 1), v1);
  const noStdin = mk({ stdin: null });
  assert.equal(mod.adaptLanePlanForGeneration(noStdin, 2), noStdin);
  const other = mk({ slug: 'codex' });
  assert.equal(mod.adaptLanePlanForGeneration(other, 2), other);
  const fail = { ok: false };
  assert.equal(mod.adaptLanePlanForGeneration(fail, 2), fail);
  const noRun = mk({ argv: ['x'] });
  assert.equal(mod.adaptLanePlanForGeneration(noRun, 2), noRun);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

let recorder;
try {
  recorder = require('../scripts/run-focused-test-evidence.cjs');
} catch {
  recorder = null;
}

function api() {
  assert.ok(recorder, 'focused evidence wrapper is missing');
  return recorder;
}

test('RFG-01', () => {
  assert.deepEqual(api().mandatoryLiterals('const test = require("node:test"); function nested() { test("A", () => {}); }', ['A']).map(({ name }) => name), ['A']);
});

test('RFG-02', () => {
  const result = api().requiredSubset([{ name: 'A', status: 'pass' }], ['A']);
  assert.equal(result.ok, true);
});

test('RFG-03', () => {
  const result = api().aggregateResults([{ name: 'A', status: 'pass' }, { name: 'extra', status: 'pass' }]);
  assert.deepEqual(result, { executed: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 });
});

test('RFG-04', () => {
  assert.deepEqual(api().nodeTestArgv(['a.test.cjs', 'b.test.cjs']), [process.execPath, '--unhandled-rejections=strict', '--test', '--test-reporter=tap', 'a.test.cjs', 'b.test.cjs']);
});

test('RFG-05', () => {
  const env = api().offlineEnvironment({ PATH: process.env.PATH, NODE_OPTIONS: '--trace-warnings', OPENAI_API_KEY: 'remove-me', NODE_TEST_CONTEXT: 'remove-me' });
  assert.doesNotMatch(env.NODE_OPTIONS, /trace-warnings/);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('NODE_TEST_CONTEXT' in env, false);
  const denied = spawnSync(process.execPath, ['-e', 'require("node:http").get("http://example.invalid")'], { encoding: 'utf8', env, timeout: PROBE_TIMEOUT_MS });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /deny-network/);
});

test('RFG-06', () => {
  assert.throws(() => api().requiredSubset([], ['A']), /zero|required/i);
});

test('RFG-07', () => {
  assert.throws(() => api().aggregateResults([{ name: 'A', status: 'skip' }]), /skip/i);
});

test('RFG-08', () => {
  assert.throws(() => api().assertPrivateSafe({ diagnostic: 'secret' }), /private|forbidden/i);
});

test('C5-08', () => {
  const impl = api();
  assert.deepEqual(impl.nodeTestArgv(['one.test.cjs', 'two.test.cjs']), [process.execPath, '--unhandled-rejections=strict', '--test', '--test-reporter=tap', 'one.test.cjs', 'two.test.cjs']);
  assert.throws(() => impl.nodeTestArgv(['--test-name-pattern=A']), /whole-file|invalid/);
  assert.deepEqual(impl.mandatoryLiterals('function outer(){ test("A",()=>{}); function inner(){ test("B",()=>{}); }}', ['A', 'B']).map(({ name }) => name), ['A', 'B']);
  assert.throws(() => impl.mandatoryLiterals('test("A",()=>{}); test("A",()=>{});', ['A']), /duplicate/);
  assert.throws(() => impl.mandatoryLiterals('test(name,()=>{});', ['A']), /missing/);
  assert.throws(() => impl.requiredSubset([{ name: 'A', status: 'pass' }, { name: 'A', status: 'pass' }], ['A']), /exactly once/);
  assert.throws(() => impl.requiredSubset([{ name: 'A', status: 'pass' }, { name: 'a', status: 'pass' }], ['A']), /case-colliding/);
  assert.throws(() => impl.requiredSubset([{ name: 'extra', status: 'pass' }], ['A']), /exactly once/);
  assert.throws(() => impl.requiredSubset([{ name: 'A', status: 'todo' }], ['A']), /status/);
  assert.throws(() => impl.aggregateResults([{ name: 'A', status: 'fail' }]), /forbidden/);
  for (const status of ['skip', 'todo', 'cancelled']) assert.throws(() => impl.aggregateResults([{ name: 'A', status }]), new RegExp(status));
  assert.deepEqual(impl.aggregateResults([{ name: 'A', status: 'pass' }, { name: 'extra', status: 'pass' }]), { executed: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 });
  assert.throws(() => impl.jcs(Number.MAX_SAFE_INTEGER + 1), /noncanonical/);
  assert.equal(impl.jcs(-0), '0');
  assert.equal(impl.digest('domain', { b: 1, a: 'é' }), 'db8fc5d88c86213d7e09152c5fa632cdb358620fdd5630430ebc365cf7e9ad4f');
  assert.throws(() => impl.parseTap('TAP version 13\n1..0\n'), /malformed|zero|count/);
  assert.throws(() => impl.parseTap('TAP version 13\nok 1 - A\n1..2\n'), /count/);
  assert.deepEqual(impl.parseTap('TAP version 13\nnot ok 1 - A\n  ---\n  failureType: cancelledByParent\n  ...\n1..1\n'), [{ name: 'A', status: 'cancelled' }]);
  const source = 'test("A",()=>{});\n';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-source-'));
  fs.writeFileSync(path.join(temp, 'one.cjs'), source);
  const evidence = impl.sourceEvidence(['one.cjs'], ['A'], temp);
  assert.equal(evidence.source_file_count, 1);
  assert.equal(evidence.source_required_literal_count, 1);
  assert.notEqual(evidence.source_file_set_digest, evidence.source_manifest_digest);
  assert.doesNotMatch(impl.offlineEnvironment({ NODE_OPTIONS: '--require=x\n--inspect' }).NODE_OPTIONS, /inspect|require=x/);
  assert.doesNotMatch(impl.offlineEnvironment({ NODE_OPTIONS: '--require=x' }).NODE_OPTIONS, /require=x/);
  const env = impl.offlineEnvironment({ NODE_OPTIONS: '--trace-warnings' });
  assert.match(env.NODE_OPTIONS, /--require=/);
  assert.equal(impl.digest('command', impl.nodeTestArgv(['one.cjs'])), impl.digest('command', [process.execPath, '--unhandled-rejections=strict', '--test', '--test-reporter=tap', 'one.cjs']));
  const destination = path.join(temp, 'atomic.json'); let linked = false;
  const io = { ...fs, fsyncSync() { throw new Error('injected fsync failure'); }, linkSync() { linked = true; } };
  assert.throws(() => impl.writeAtomicRecord(destination, { safe: true }, io), /injected/);
  assert.equal(linked, false);
  assert.equal(fs.existsSync(destination), false);
});

test('structural TAP parser exposes only executed leaves and rejects corrupt streams', () => {
  const impl = api();
  const nested = [
    'TAP version 13',
    '# Subtest: parent',
    '    # Subtest: child one',
    '    ok 1 - child one',
    '    # Subtest: child two',
    '    ok 2 - child two',
    '    1..2',
    'ok 1 - parent',
    '1..1',
    '# tests 1',
    '',
  ].join('\n');
  assert.deepEqual(impl.parseTap(nested), [{ name: 'child one', status: 'pass' }, { name: 'child two', status: 'pass' }]);
  for (const source of [
    nested.replace('ok 2', 'not ok 2'),
    nested.replace('ok 2 - child two', 'ok 2 - child two # SKIP reason'),
    nested.replace('ok 2 - child two', 'ok 2 - child two # TODO reason'),
  ]) assert.throws(() => impl.aggregateResults(impl.parseTap(source)), /forbidden/);
  const cancelled = nested.replace('ok 2 - child two', "not ok 2 - child two\n      ---\n      failureType: 'cancelledByParent'\n      ...");
  assert.throws(() => impl.aggregateResults(impl.parseTap(cancelled)), /cancelled/);
  for (const source of [nested.replace('    1..2\n', ''), nested.replace('    1..2', '    1..3'), nested.replace('ok 2', 'ok 3'), `${nested}not ok`]) assert.throws(() => impl.parseTap(source), /TAP|trailing|malformed|truncated/);
  assert.throws(() => impl.parseTap('TAP version 13\n# Subtest: dangling\n\n'), /dangling|truncated/);
  for (const directive of ['not ok 1 - parent','ok 1 - parent # SKIP parent','ok 1 - parent # TODO parent']) assert.throws(() => impl.parseTap(nested.replace('ok 1 - parent',directive)), /nested TAP parent/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-spawn-'));
  const fixture = path.join(directory, 'nested.test.cjs');
  fs.writeFileSync(fixture, "const test=require('node:test');test('parent',async t=>{await t.test('spawned leaf',()=>{});});\n");
  const childArgv=impl.nodeTestArgv([fixture]),child=spawnSync(childArgv[0],childArgv.slice(1),{ encoding: 'utf8', env: impl.offlineEnvironment(process.env), timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0);
  const tap = child.stdout || child.stderr;
  assert.equal(tap.startsWith('TAP version 13'), true, JSON.stringify(tap.slice(0, 120)));
  assert.deepEqual(impl.parseTap(tap), [{ name: 'spawned leaf', status: 'pass' }]);

  const outcomes = path.join(directory, 'outcomes.test.cjs');
  fs.writeFileSync(outcomes, [
    "const test=require('node:test');",
    "test('spawn pass',()=>{});",
    "test('spawn fail',()=>{throw new Error('expected');});",
    "test('spawn skip',{skip:true},()=>{});",
    "test('spawn todo',{todo:true},()=>{});",
    '',
  ].join('\n'));
  const outcomeArgv=impl.nodeTestArgv([outcomes]),outcomeChild=spawnSync(outcomeArgv[0],outcomeArgv.slice(1),{ encoding: 'utf8', env: impl.offlineEnvironment(process.env), timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  assert.equal(outcomeChild.status, 1);
  assert.deepEqual(impl.parseTap(outcomeChild.stdout), [
    { name: 'spawn pass', status: 'pass' },
    { name: 'spawn fail', status: 'fail' },
    { name: 'spawn skip', status: 'skip' },
    { name: 'spawn todo', status: 'todo' },
  ]);

  for (const mode of ['fail','skip','todo']) {
    const parentFixture=path.join(directory,`parent-${mode}.test.cjs`);
    fs.writeFileSync(parentFixture,`const test=require('node:test');test('parent',async t=>{await t.test('leaf',()=>{});${mode==='fail'?"throw new Error('after child');":`t.${mode}('after child');`}});\n`);
    const parentArgv=impl.nodeTestArgv([parentFixture]),parentChild=spawnSync(parentArgv[0],parentArgv.slice(1),{encoding:'utf8',env:impl.offlineEnvironment(process.env),timeout:PROBE_TIMEOUT_MS,killSignal:'SIGKILL'});
    assert.throws(()=>impl.parseTap(parentChild.stdout),/nested TAP parent/);
  }
});

test('atomic publication is no-clobber and keeps a published record after directory fsync failure', () => {
  const impl = api(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-publish-')), target = path.join(directory, 'record.json');
  fs.writeFileSync(target, 'old');
  assert.throws(() => impl.writeAtomicRecord(target, { safe: true }), /already exists/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  fs.unlinkSync(target);
  let calls = 0;
  const io = Object.create(fs);
  io.fsyncSync = (fd) => { calls += 1; if (calls === 2) throw new Error('directory fsync failure'); return fs.fsyncSync(fd); };
  assert.throws(() => impl.writeAtomicRecord(target, { safe: true }, io), /directory fsync failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"safe":true}\n');
  const alias = path.join(directory, 'alias.json');
  fs.symlinkSync(target, alias);
  assert.throws(() => impl.writeAtomicRecord(alias, { safe: true }), /already exists/);
});

test('in-repository destination is rejected before directory creation', () => {
  const impl=api(), directory=path.join(__dirname,'..','.focused-evidence-must-not-exist'),target=path.join(directory,'record.json');
  assert.equal(fs.existsSync(directory),false);
  assert.throws(()=>impl.writeAtomicRecord(target,{safe:true}),/outside project/);
  assert.equal(fs.existsSync(directory),false);
});

test('focused forbid-live flag is child-only and evidence remains ambient-private', () => {
  const impl = api();
  const base = { PATH: process.env.PATH, NODE_OPTIONS: '--trace-warnings', GSD_FOCUSED_FORBID_LIVE: 'ambient', OPENAI_API_KEY: 'ambient-private-value', NODE_TEST_NAME_PATTERN: 'ambient' };
  const forbidden = impl.focusedEnvironment(base, true);
  const ordinary = impl.focusedEnvironment(base, false);
  assert.equal(forbidden.GSD_FOCUSED_FORBID_LIVE, '1');
  assert.equal('GSD_FOCUSED_FORBID_LIVE' in ordinary, false);
  assert.match(forbidden.NODE_OPTIONS, /deny-network/);
  assert.match(ordinary.NODE_OPTIONS, /deny-network/);
  assert.equal('OPENAI_API_KEY' in forbidden, false);
  assert.equal('NODE_TEST_NAME_PATTERN' in forbidden, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-forbid-live-'));
  fs.writeFileSync(path.join(root, 'one.cjs'), 'test("A", () => {});\n');
  let childEnvironment;
  let evidence;
  impl.run({ files: ['one.cjs'], required: ['A'], record: path.join(root, 'outside-name.json'), expect: 'pass', forbidLive: true }, {
    root,
    environment: base,
    spawnSync(command, args, options) {
      childEnvironment = options.env;
      assert.deepEqual([command,...args],[process.execPath,'--unhandled-rejections=strict','--test','--test-reporter=tap','one.cjs']);
      assert.equal(options.timeout, impl.CHILD_TIMEOUT_MS);
      assert.equal(options.killSignal, impl.CHILD_KILL_SIGNAL);
      return { status: 0, stdout: 'TAP version 13\nok 1 - A\n1..1\n' };
    },
    writeAtomicRecord(_destination, record) { evidence = record; },
  });
  assert.equal(childEnvironment.GSD_FOCUSED_FORBID_LIVE, '1');
  assert.equal(JSON.stringify(evidence).includes('ambient-private-value'), false);
  assert.equal(Object.hasOwn(evidence, 'environment'), false);
  assert.equal(evidence.command_digest, impl.digest('command', impl.focusedProducerArgv({ files:['one.cjs'], required:['A'], record:path.join(root,'outside-name.json'), expect:'pass', forbidLive:true })));
});

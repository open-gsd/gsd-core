'use strict';
/**
 * Tests for the companion MCP server (ADR-1239 Phase C-2, #1681 slice 3a).
 * Pins: initialize handshake, tools/list, tools/call dispatch to the hub +
 * stateIO seam, method-not-found, notification = no response, parse error in
 * runServer, and a full injectable-stream round-trip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const fc = require('./helpers/fast-check-setup.cjs');
const {
  handleMessage,
  runServer,
  PROTOCOL_VERSION,
  SERVER_NAME,
} = require('../gsd-core/bin/lib/mcp-server.cjs');
const { createTempDir, cleanup, runGsdTools, sandboxHome, scrubConfigLocationEnv } = require('./helpers.cjs');

test('initialize: returns protocolVersion + capabilities + serverInfo', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 1);
  assert.strictEqual(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(res.result.capabilities && res.result.capabilities.tools, 'must advertise tools capability');
  assert.strictEqual(res.result.serverInfo.name, SERVER_NAME);
});

test('tools/list: advertises the 3 interface-point tools', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names.sort(), ['gsd_invoke_command', 'gsd_read_state', 'gsd_write_state']);
});

test('tools/list: gsd_invoke_command requires only family (#5325)', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const invoke = res.result.tools.find((tool) => tool.name === 'gsd_invoke_command');
  assert.deepEqual(invoke.inputSchema.required, ['family']);
  assert.equal(invoke.inputSchema.properties.family.type, 'string');
  assert.equal(invoke.inputSchema.properties.subcommand.type, 'string');
});

for (const subcommand of [undefined, '']) {
  test(`tools/call: config-path matches the CLI with ${subcommand === undefined ? 'omitted' : 'empty'} subcommand (#5325)`, (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    t.after(scrubConfigLocationEnv());
    sandboxHome(t, dir);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });

    const cli = runGsdTools(['config-path', '--raw', '--json-errors'], dir);
    assert.equal(cli.success, true, cli.error);
    assert.equal(cli.output, path.join(dir, '.planning', 'config.json'));

    const args = { family: 'config-path' };
    if (subcommand !== undefined) args.subcommand = subcommand;
    const res = handleMessage(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: args } },
      { cwd: dir },
    );
    assert.notEqual(res.result.isError, true, 'the family-only command must reach the CLI through MCP');
    assert.equal(res.result.content[0].text.trim(), cli.output);
  });
}

test('tools/call: required family is validated before dispatch (#5325)', (t) => {
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: '', stderr: '' }));
  for (const family of [undefined, '', null, false, 0, [], {}]) {
    const res = handleMessage({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'gsd_invoke_command', arguments: { family } },
    });
    assert.equal(res.result.isError, true);
  }
  assert.equal(spawn.mock.callCount(), 0, 'invalid family must never spawn a command');
});

test('tools/call: explicit null subcommand is a type error without dispatch (#5325)', (t) => {
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: '', stderr: '' }));
  const res = handleMessage({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'gsd_invoke_command', arguments: { family: 'config-path', subcommand: null } },
  });
  assert.equal(res.result.isError, true);
  assert.equal(spawn.mock.callCount(), 0);
});

test('tools/call: a supplied non-string subcommand never dispatches (#5325 property)', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: '', stderr: '' }));
  await fc.assert(fc.property(fc.jsonValue().filter((value) => typeof value !== 'string'), (subcommand) => {
    const res = handleMessage({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'gsd_invoke_command', arguments: { family: 'config-path', subcommand } },
    });
    assert.equal(res.result.isError, true);
    assert.equal(spawn.mock.callCount(), 0, 'an optional field must not silently discard a wrong-typed value');
  }));
});

test('tools/call: explicit subcommand and positional args still reach the CLI (#5325)', (t) => {
  const dir = createTempDir();
  t.after(() => cleanup(dir));
  t.after(scrubConfigLocationEnv());
  sandboxHome(t, dir);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { research: false } }));
  const res = handleMessage(
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: { family: 'query', subcommand: 'config-get', args: ['workflow.research'] } } },
    { cwd: dir },
  );
  assert.notEqual(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text), false);
});

test('tools/call gsd_read_state + gsd_write_state: round-trip through the stateIO seam (point 5)', () => {
  const dir = createTempDir();
  try {
    const file = path.join(dir, 'STATE.md');
    const writeRes = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gsd_write_state', arguments: { path: file, content: '# State\n' } } });
    assert.strictEqual(writeRes.result.isError, undefined, 'write must succeed');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# State\n', 'write went through to fs');
    const readRes = handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gsd_read_state', arguments: { path: file } } });
    assert.strictEqual(readRes.result.content[0].text, '# State\n', 'read returns the written content');
  } finally {
    cleanup(dir);
  }
});

test('tools/call gsd_invoke_command: dispatches to the command hub (point 1); unknown family returns a hub error, not a crash', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: { family: 'no-such-family', subcommand: 'x' } } }, { cwd: createTempDirClean() });
  // The hub returns a structured result (ok:false unknown-command) surfaced as text content, not a JSON-RPC error.
  assert.strictEqual(res.jsonrpc, '2.0');
  const payload = JSON.parse(res.result.content[0].text);
  assert.strictEqual(payload.ok, false, 'an unknown command dispatches to the hub and returns ok:false');
  assert.strictEqual(res.result.isError, true, 'unknown family surfaces as isError:true (#2102)');
});

// REGRESSION #2102: gsd_invoke_command previously called
// `commandRoutingHub.createHub()` with NO arguments, which always hits
// `if (!_cjsRegistry) return makeUnknownCommand()` — every dispatch, valid
// family or not, returned UnknownCommand. The test above (family:
// 'no-such-family') could not catch this: an UnknownCommand result is
// EXACTLY what an unknown family is supposed to return, whether or not
// dispatch actually worked — it is vacuous by construction. This test proves
// the fix: a VALID read-only family/subcommand must reach gsd-tools.cjs for
// real and come back with actual data (not a crash, not UnknownCommand).
test('tools/call gsd_invoke_command: REGRESSION #2102 — a valid read-only family dispatches for real (not the createHub()-with-no-args UnknownCommand bug)', () => {
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version
    // token) is COMPLETE scope for windowing (§7.1) — without this, a
    // bare temp dir has no ROADMAP.md at all (UNREADABLE) and `percent`
    // is withheld (null), breaking this reachability proxy.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const res = handleMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: { family: 'progress', subcommand: 'json' } } },
      { cwd: dir },
    );
    assert.strictEqual(res.jsonrpc, '2.0');
    assert.notStrictEqual(res.result.isError, true, 'a valid family must not surface as an error');
    const text = res.result.content[0].text;
    const parsed = JSON.parse(text);
    // Fail-first proof: under the bug, this would be
    // { ok: false, kind: 'UnknownCommand', command: 'progress json' } instead
    // of the real progress payload — `percent` would not exist.
    assert.strictEqual(typeof parsed.percent, 'number', 'the real "progress json" command ran (the engine was reached)');
  } finally {
    cleanup(dir);
  }
});

test('tools/call: unknown tool name surfaces a tool error (isError), not a JSON-RPC protocol error', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gsd_bogus' } });
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown tool/);
});

test('tools/call: missing tool name is a JSON-RPC invalid-params error', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} });
  assert.strictEqual(res.error.code, -32602);
  assert.match(res.error.message, /requires string "name"/);
});

// Previously used 'resources/read' as the example unknown method, but that
// stopped being unknown once the served catalog shipped in #3072.
// 'resources/subscribe' is DELIBERATELY not implemented and deliberately NOT
// advertised in initialize's capabilities, because the server never sends the
// corresponding notification. So this assertion now pins a real contract --
// the advertised capability surface and the implemented method surface agree
// -- rather than an arbitrary method name that a future feature could
// invalidate the same way.
test('unknown method: JSON-RPC method-not-found (-32601)', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/subscribe' });
  assert.strictEqual(res.error.code, -32601);
  assert.match(res.error.message, /Method not found/);
});

test('notification (no id): returns null (no response per JSON-RPC)', () => {
  assert.strictEqual(handleMessage({ jsonrpc: '2.0', method: 'initialize' }), null);
  assert.strictEqual(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('runServer: line-delimited JSON-RPC round-trip over injectable streams', async () => {
  const input = Readable.from([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n',
    'not json\n',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
  ]);
  const out = [];
  const output = { write: (s) => { out.push(s); return true; } };
  await runServer({ input, output });
  const joined = out.join('');
  const responses = joined.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(responses.length, 3);
  assert.strictEqual(responses[0].result.protocolVersion, PROTOCOL_VERSION, 'initialize handled');
  assert.strictEqual(responses[1].error.code, -32700, 'parse error surfaced');
  assert.ok(Array.isArray(responses[2].result.tools), 'tools/list handled');
});

// tiny helper to get a throwaway cwd without polluting the assertion helpers import above
function createTempDirClean() {
  const os = require('node:os');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cwd-'));
}

test('--no-prompts (ctx.prompts === false) withholds the prompt catalog but keeps tools and resources (#5338)', () => {
  const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { prompts: false });
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ['resources', 'tools']);
  for (const method of ['prompts/list', 'prompts/get']) {
    const res = handleMessage({ jsonrpc: '2.0', id: 2, method, params: { name: 'x' } }, { prompts: false });
    assert.equal(res.error.code, -32601, method);
  }
  assert.ok(Array.isArray(handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { prompts: false }).result.tools));
  // The default is unchanged: prompts advertised and listed.
  const dflt = handleMessage({ jsonrpc: '2.0', id: 4, method: 'initialize' });
  assert.ok('prompts' in dflt.result.capabilities);
  assert.ok(handleMessage({ jsonrpc: '2.0', id: 5, method: 'prompts/list' }).result.prompts.length > 0);
});

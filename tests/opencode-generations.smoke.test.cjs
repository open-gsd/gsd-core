'use strict';

/**
 * opencode-generations.smoke.test.cjs — opt-in real-binary smoke for the GSD OpenCode plugin on 1.x and 2.x
 * (ADR-5331, epic #5331, Phase 1 #5337).
 *
 * Skipped unless GSD_TEST_OPENCODE_V1_BIN / GSD_TEST_OPENCODE_V2_BIN point at real `opencode` executables.
 * A local OpenAI-compatible server stands in for the model, so the tool call really executes inside OpenCode
 * and the plugin's secret-read guard really runs; nothing leaves the machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js');

function fakeModel(toolCall) {
  const seenToolResults = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }));
        return;
      }
      const j = JSON.parse(body || '{}');
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const last = msgs[msgs.length - 1] || {};
      const names = (j.tools || []).map((x) => (x.function && x.function.name) || x.name);
      if (last.role === 'tool') seenToolResults.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      const call = last.role !== 'tool' && names.includes(toolCall.tool);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm' };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (call) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolCall.tool, arguments: JSON.stringify(toolCall.args) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seenToolResults, port: server.address().port })));
}

async function runOpencode(t, { bin, v2, toolCall }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-smoke-')));
  t.after(() => cleanup(home));
  const cfg = path.join(home, '.config', 'opencode');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'gsd-core'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(cfg, 'hooks'), { recursive: true });
  fs.copyFileSync(PLUGIN, path.join(cfg, 'plugins', 'gsd-core.js'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=supersecret\n');
  const { server, seenToolResults, port } = await fakeModel(toolCall);
  t.after(() => server.close());
  fs.writeFileSync(path.join(cfg, 'opencode.json'), JSON.stringify({
    provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 100000, output: 4000 } } } } },
    model: 'fake/m',
  }));
  const args = ['run', ...(v2 ? ['--standalone'] : []), '--auto', '--model', 'fake/m', '--format', 'json', 'do it'];
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true' };
  const child = spawn(bin, args, { cwd: proj, env, stdio: ['ignore', 'ignore', 'ignore'], timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
  await new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
  return seenToolResults.join('\n');
}

const V1 = process.env.GSD_TEST_OPENCODE_V1_BIN;
const V2 = process.env.GSD_TEST_OPENCODE_V2_BIN;

test('OpenCode 1.x: the plugin blocks a secret Read', { skip: !V1 && 'GSD_TEST_OPENCODE_V1_BIN not set' }, async (t) => {
  const out = await runOpencode(t, { bin: V1, v2: false, toolCall: { tool: 'read', args: { filePath: '.env' } } });
  assert.match(out, /Secret read guard/);
  assert.doesNotMatch(out, /supersecret/);
});

test('OpenCode 2.x: the plugin blocks a secret Read', { skip: !V2 && 'GSD_TEST_OPENCODE_V2_BIN not set' }, async (t) => {
  const out = await runOpencode(t, { bin: V2, v2: true, toolCall: { tool: 'read', args: { path: '.env' } } });
  assert.match(out, /Secret read guard/);
  assert.doesNotMatch(out, /supersecret/);
});

test('OpenCode 2.x: the plugin blocks a secret read through the 2.x `shell` tool id', { skip: !V2 && 'GSD_TEST_OPENCODE_V2_BIN not set' }, async (t) => {
  const out = await runOpencode(t, { bin: V2, v2: true, toolCall: { tool: 'shell', args: { command: 'cat .env' } } });
  assert.match(out, /Secret read guard/);
  assert.doesNotMatch(out, /supersecret/);
});

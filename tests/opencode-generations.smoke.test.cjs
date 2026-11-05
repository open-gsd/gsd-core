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
  const seenUserMessages = [];
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
      if (last.role === 'user') seenUserMessages.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      if (last.role === 'tool') seenToolResults.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      const call = last.role !== 'tool' && names.includes(toolCall.tool);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm' };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (call) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolCall.tool, arguments: JSON.stringify(toolCall.args) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: toolCall.reply || 'done' }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seenToolResults, seenUserMessages, port: server.address().port })));
}

async function runOpencode(t, { bin, v2, toolCall, lane = false }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-smoke-')));
  t.after(() => cleanup(home));
  const cfg = path.join(home, '.config', 'opencode');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'gsd-core', 'references'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'gsd-core', 'references', 'hello.md'), 'GSD-REFERENCE-CONTENT\n');
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(cfg, 'hooks'), { recursive: true });
  fs.copyFileSync(PLUGIN, path.join(cfg, 'plugins', 'gsd-core.js'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=supersecret\n');
  const { server, seenToolResults, seenUserMessages, port } = await fakeModel(toolCall);
  t.after(() => server.close());
  fs.writeFileSync(path.join(cfg, 'opencode.json'), JSON.stringify({
    provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 100000, output: 4000 } } } } },
    model: 'fake/m',
  }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    // A shell that `cd`s into the worktree updates PWD; 2.x resolves its directory from it (E13).
    PWD: proj };
  if (lane) {
    // The real reviewer lane: gsd-tools resolves the plan for the opencode on PATH and runs it.
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(fs.realpathSync(bin), path.join(binDir, 'opencode'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'run'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ review: { models: { opencode: 'fake/m' }, effort: { opencode: 'high' } } }));
    fs.writeFileSync(path.join(proj, 'prompt.md'), 'Review this plan please\n');
    const child = spawn(process.execPath, [path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'review-lane', 'invoke', '--slug', 'opencode', '--run-dir', path.join(proj, 'run'), '--repo-root', proj, '--prompt-file', path.join(proj, 'prompt.md')], { cwd: proj, env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` }, stdio: ['ignore', 'ignore', 'ignore'], timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
    await new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
    const reviewPath = path.join(proj, 'run', 'gsd-review-opencode.md');
    return { review: fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '', prompts: seenUserMessages };
  }
  const args = ['run', ...(v2 ? ['--standalone'] : []), '--auto', '--model', 'fake/m', '--format', 'json', 'do it'];
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

for (const [label, bin, v2] of [['1.x', V1, false], ['2.x', V2, true]]) {
  test(`OpenCode ${label}: the real reviewer lane runs end to end and the prompt carries no stdin marker`, { skip: !bin && 'binary env var not set' }, async (t) => {
    const out = await runOpencode(t, { bin, v2, lane: true, toolCall: { tool: 'none', args: {}, reply: 'REVIEW: src/a.js:1 fine' } });
    assert.match(out.review, /REVIEW: src\/a\.js:1 fine/);
    if (v2) assert.ok(out.prompts.every((p) => !p.startsWith('-')), `prompt was polluted: ${JSON.stringify(out.prompts)}`);
  });
}

test('OpenCode 2.x: the spawn working directory is the worktree (no --dir needed, ADR-5331 D5)', { skip: !V2 && 'GSD_TEST_OPENCODE_V2_BIN not set' }, async (t) => {
  const out = await runOpencode(t, { bin: V2, v2: true, toolCall: { tool: 'shell', args: { command: 'pwd' } } });
  assert.match(out, /gsd-oc-smoke-[^/\\\n]+[/\\]proj/, out);
});

for (const [label, bin, v2, argKey] of [['1.x', V1, false, 'filePath'], ['2.x', V2, true, 'path']]) {
  test(`OpenCode ${label}: a Read of ~/.claude/gsd-core/... is redirected to the installed payload (the 364 .claude references)`, { skip: !bin && 'binary env var not set' }, async (t) => {
    const out = await runOpencode(t, { bin, v2, toolCall: { tool: 'read', args: { [argKey]: '~/.claude/gsd-core/references/hello.md' } } });
    assert.match(out, /GSD-REFERENCE-CONTENT/);
  });
}

test('data dir: 2.x beside 1.x tables keeps 1.x working, but a data dir 2.x creates from scratch cannot be opened by 1.x (ADR-5331 E8, E18)', { skip: !(V1 && V2) && 'both GSD_TEST_OPENCODE_V1_BIN and _V2_BIN are required' }, async (t) => {
  const { classifyOpencodeDatabase, resolveOpencodeDataDir, describeDataDirNotice } = require('../gsd-core/bin/lib/opencode-version.cjs');
  const mkHome = () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-data-')));
    t.after(() => cleanup(home));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true' };
    return { home, env, dataDir: path.join(home, 'data', 'opencode') };
  };
  const runBin = (bin, args, { home, env }) => new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', () => resolve({ code: -1, out }));
  });

  // 1.x first, then 2.x: 2.x adds its tables beside 1.x's and 1.x keeps working.
  const a = mkHome();
  assert.equal(resolveOpencodeDataDir({ binary: V2, env: a.env }), a.dataDir);
  assert.equal((await runBin(V1, ['session', 'list'], a)).code, 0);
  const dbA = path.join(a.dataDir, 'opencode.db');
  assert.equal(classifyOpencodeDatabase(dbA), 'v1');
  assert.equal((await runBin(V2, ['session', 'list', '--standalone'], a)).code, 0);
  assert.equal(classifyOpencodeDatabase(dbA), 'both');
  assert.equal((await runBin(V1, ['session', 'list'], a)).code, 0, '1.x still opens a data dir 2.x added tables to');
  assert.equal(describeDataDirNotice(1, 'both', a.dataDir).level, 'info');

  // 2.x first: no 1.x tables exist, and 1.x cannot open the database.
  const b = mkHome();
  assert.equal((await runBin(V2, ['session', 'list', '--standalone'], b)).code, 0);
  assert.equal(classifyOpencodeDatabase(path.join(b.dataDir, 'opencode.db')), 'v2');
  const back = await runBin(V1, ['run', '--format', 'json', 'hi'], b);
  assert.notEqual(back.code, 0, '1.x cannot open a data dir 2.x created');
  assert.match(back.out, /no session table/);
  assert.equal(describeDataDirNotice(1, 'v2', b.dataDir).level, 'warn');
});

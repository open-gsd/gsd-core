'use strict';

/**
 * opencode-real.cjs — harness for tests that drive a REAL `opencode` binary (1.x or 2.x) against an install made
 * by GSD's own installer and a scripted OpenAI-compatible model. Nothing leaves the machine.
 *
 *   const env = await realSetup(t, { bin, v2 });       // installer → config dir, provider, project
 *   const out = await realRun(env, { script: [...] }); // one `opencode run`, hook trace + model requests
 *
 * `script` is the model's behaviour, one entry per model request: `{ tool, args }` to call a tool, or
 * `{ reply }` to answer. A request past the end of the script answers 'done'. `GSD_HOOK_RUNTIME` and
 * `GSD_HOOK_SHELL` point at wrappers that log every hook script the plugin starts.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');
const { runNode } = require('./process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./install-shared.cjs');
const { INSTALL_TIMEOUT_MS, GIT_TIMEOUT_MS } = require('./timeouts.cjs');

// One matrix row installs GSD and runs a real OpenCode binary: a distinct class of subprocess from the installer alone,
// and a bit longer than the 1.x binary's cold start (about 30 s on a loaded machine).
const REAL_ROW_TIMEOUT_MS = 240000;
// A short real run (a model turn that must not wait for a user).
const REAL_SHORT_RUN_TIMEOUT_MS = 90000;
const REAL_MEDIUM_RUN_TIMEOUT_MS = 120000;

function fakeModel(script) {
  const requests = [];
  let turn = 0;
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
      const tools = (j.tools || []).map((x) => (x.function && x.function.name) || x.name);
      requests.push({ tools, toolSchemas: j.tools || [], messages: msgs, system: msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))) });
      // Requests without tools (session titles, summaries) are not the agent's turns: answer them without
      // consuming the script.
      const step = tools.length === 0 ? { reply: 'title' } : (script[turn] || { reply: 'done' });
      if (tools.length > 0) turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm' };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (step.tool && tools.includes(step.tool)) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const text = step.tool ? `[tool ${step.tool} is not offered]` : (step.reply || 'done');
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, requests, listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))) };
}

/** The process env for the binary under test: ours, minus the host agent's own variables (a hook that detects Claude Code from them would change behaviour). */
function cleanEnv(base) {
  const out = { ...base };
  for (const k of Object.keys(out)) if (/^CLAUDE/i.test(k)) delete out[k];
  return out;
}

function wrapper(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** Install GSD for OpenCode into a sandbox with the real installer and wire a fake provider. */
function realSetup(t, { bin, v2, keepMcp = false, projectFiles = {} }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-real-')));
  // Things started inside the sandbox (a server) must be gone before the sandbox is removed: run them first, last-in first-out.
  const deferred = [];
  t.after(async () => {
    for (const fn of deferred.reverse()) await fn();
    // A package manager the host started (provider package install) can still be writing its cache: retry.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const cfg = path.join(home, '.config', 'opencode');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // The installer asks the installed `opencode` for its generation: put the binary under test on PATH.
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(fs.realpathSync(bin), path.join(binDir, 'opencode'));
  const sandboxEnv = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
  const install = runNode([INSTALL_SCRIPT, '--opencode', '--global', '--config-dir', cfg], { env: installerEnv(sandboxEnv), timeoutMs: INSTALL_TIMEOUT_MS });
  if (install.exitCode !== 0) throw new Error(`installer failed\n${install.stdout}\n${install.stderr}`);
  for (const [rel, content] of Object.entries(projectFiles)) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), content);
  }
  return { home, cfg, proj, bin, v2: !!v2, sandboxEnv, installOutput: install.stdout, keepMcp, defer: (fn) => deferred.push(fn) };
}

async function realRun(env, { script = [], args = null, extraEnv = {}, timeoutMs = INSTALL_TIMEOUT_MS, message = 'do it', before = null } = {}) {
  const model = fakeModel(script);
  const port = await model.listen();
  const cfgFile = path.join(env.cfg, 'opencode.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.provider = { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 100000, output: 4000 } } } } };
  cfg.model = 'fake/m';
  if (!env.keepMcp) delete cfg.mcp;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const trace = path.join(env.home, 'hook-trace.log');
  fs.writeFileSync(trace, '');
  const rt = path.join(env.home, 'hook-runtime');
  wrapper(rt, `echo "$1" >> '${trace}'\nexec node "$@"`);
  const sh = path.join(env.home, 'hook-shell');
  wrapper(sh, `echo "$1" >> '${trace}'\nexec bash "$@"`);
  if (before) await before(env);
  const runEnv = { ...cleanEnv(process.env), ...env.sandboxEnv, PWD: env.proj, GSD_HOOK_RUNTIME: rt, GSD_HOOK_SHELL: sh, ...extraEnv };
  const runArgs = args || ['run', ...(env.v2 ? ['--standalone'] : []), '--auto', '--model', 'fake/m', '--format', 'json', message];
  const child = spawn(env.bin, runArgs, { cwd: env.proj, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const rc = await new Promise((resolve) => { child.on('exit', (c) => resolve(c)); child.on('error', () => resolve(-1)); });
  model.server.close();
  const hooks = splitLines(fs.readFileSync(trace, 'utf8')).filter(Boolean).map((p) => path.basename(p));
  return { rc, stdout, stderr, requests: model.requests, hooks, toolResults: model.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))) };
}

/**
 * Start a 2.x server (`opencode serve`) in the sandbox, with the scripted model wired in, and return an `api(op, opts)`
 * caller for `opencode api --server …`. 2.x's `run` has no `--command`, so commands are executed through the server.
 */
async function realServe(env, { script = [] } = {}) {
  const model = fakeModel(script);
  const port = await model.listen();
  const cfgFile = path.join(env.cfg, 'opencode.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.provider = { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 100000, output: 4000 } } } } };
  cfg.model = 'fake/m';
  delete cfg.mcp;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const runEnv = { ...cleanEnv(process.env), ...env.sandboxEnv, PWD: env.proj };
  const servePort = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(env.bin, ['serve', '--port', String(servePort), '--print-logs', '--log-level', env.v2 ? 'info' : 'INFO'], { cwd: env.proj, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  let password = '';
  for (let i = 0; i < 100 && !password; i++) {
    await delay(100);
    const m = /password (\S+)/.exec(log);
    if (m) password = m[1];
  }
  const server = `http://127.0.0.1:${servePort}`;
  const api = (op, { params = [], data = null } = {}) => new Promise((resolve) => {
    const a = ['api', '--server', server, op, ...params.flatMap((p) => ['--param', p]), ...(data ? ['-d', JSON.stringify(data)] : [])];
    const c = spawn(env.bin, a, { cwd: env.proj, env: { ...runEnv, OPENCODE_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, out, err }));
  });
  const exited = new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
  const close = async () => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    model.server.close();
    await exited;
  };
  // The sandbox is removed only after the server has exited.
  env.defer(close);
  return { api, base: server, requests: model.requests, close, log: () => log };
}

/** Poll `cond` until it is true or `timeoutMs` passes; resolves to whether it became true. */
async function waitFor(cond, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await delay(intervalMs);
  }
  return !!(await cond());
}

/** `git init` in a sandbox project, bounded. */
function gitInit(dir, args = []) {
  const r = spawnSync('git', ['init', '-q', ...args], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

module.exports = { realSetup, realRun, realServe, fakeModel, waitFor, gitInit, delay, REAL_ROW_TIMEOUT_MS, REAL_SHORT_RUN_TIMEOUT_MS, REAL_MEDIUM_RUN_TIMEOUT_MS };

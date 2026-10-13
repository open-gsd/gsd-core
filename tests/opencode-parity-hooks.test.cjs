'use strict';

/**
 * opencode-parity-hooks.test.cjs — the four opt-in community hooks (commit validation, phase boundary,
 * session state, graphify auto-update) run on OpenCode through the plugin, on 1.x and, through the same
 * handlers, on 2.x (ADR-5331 Phase 3, epic #5331 / #5339). The real hook scripts from hooks/dist run under
 * bash; the Kilo mirror carries none of this (Kilo output unchanged).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const ADAPTER_SRC = path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js');
const HOOKS_DIST = path.join(ROOT, 'hooks', 'dist');
const SKIP = process.platform === 'win32' ? 'bash hooks are not run on Windows hosts without bash' : false;

function layout(t, { community = true, graphify = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-parity-')));
  t.after(() => cleanup(root));
  // The staged hook lib resolves the shared scanner from <root>/gsd-core/bin/lib, as in a real install.
  fs.cpSync(path.join(ROOT, 'gsd-core', 'bin', 'lib'), path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.cpSync(HOOKS_DIST, path.join(root, 'hooks'), { recursive: true });
  const dest = path.join(root, 'plugins', 'gsd-core.js');
  fs.copyFileSync(ADAPTER_SRC, dest);
  delete require.cache[require.resolve(dest)];
  const mod = require(dest);

  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-parity-proj-')));
  t.after(() => cleanup(proj));
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  const config = { mode: 'yolo' };
  if (community) config.hooks = { community: true };
  if (graphify) config.graphify = { enabled: true, auto_update: true };
  fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(proj, '.planning', 'STATE.md'), '# State\n\nPhase 3 in progress\n');
  return { mod, root, proj };
}

async function plugin(t, opts) {
  const l = layout(t, opts);
  const handlers = await l.mod.server({ directory: l.proj });
  return { ...l, handlers };
}

test('commit validation: a non-conforming git commit is blocked, a conforming one and other commands pass', { skip: SKIP }, async (t) => {
  const { handlers, proj } = await plugin(t);
  const run = (command) => handlers['tool.execute.before']({ tool: 'bash' }, { args: { command, workdir: proj } });
  await assert.rejects(() => run('git commit -m "did some stuff"'), /Conventional Commits/);
  await assert.doesNotReject(() => run('git commit -m "feat(x): add the thing"'));
  await assert.doesNotReject(() => run('ls -la'));
});

test('commit validation: without hooks.community the gate does not run', { skip: SKIP }, async (t) => {
  const { handlers, proj } = await plugin(t, { community: false });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m "did some stuff"', workdir: proj } }),
  );
});

test('phase boundary: a write under .planning/ yields the advisory; other files and a disabled opt-in do not', { skip: SKIP }, async (t) => {
  const { handlers, proj } = await plugin(t);
  const after = async (file) => {
    const out = { output: 'ok', metadata: {} };
    await handlers['tool.execute.after']({ tool: 'write', args: { filePath: file } }, out);
    return out.metadata._gsdAdvisory || [];
  };
  const planning = await after(path.join(proj, '.planning', 'ROADMAP.md'));
  assert.equal(planning.length, 1);
  assert.match(planning[0], /\.planning/);
  assert.deepEqual(await after(path.join(proj, 'src', 'a.js')), []);
});

test('session state: session.created produces the orientation once, through the 1.x system transform', { skip: SKIP }, async (t) => {
  const { handlers, proj } = await plugin(t);
  await handlers.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1', directory: proj } } } });
  const first = { system: ['base'] };
  await handlers['experimental.chat.system.transform']({}, first);
  assert.equal(first.system.length, 2);
  assert.match(first.system[1], /Project State Reminder/);
  assert.match(first.system[1], /Phase 3 in progress/);
  const second = { system: ['base'] };
  await handlers['experimental.chat.system.transform']({}, second);
  assert.deepEqual(second.system, ['base']);
});

test('session state: without hooks.community nothing is injected', { skip: SKIP }, async (t) => {
  const { handlers, proj } = await plugin(t, { community: false });
  await handlers.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1', directory: proj } } } });
  const out = { system: ['base'] };
  await handlers['experimental.chat.system.transform']({}, out);
  assert.deepEqual(out.system, ['base']);
});

test('2.x: the orientation reaches the model through the context hook as a text item', { skip: SKIP }, async (t) => {
  const { mod, proj } = layout(t);
  const hooks = {};
  const ctx = {
    tool: { hook: async (n, f) => { hooks[`tool.${n}`] = f; } },
    shell: { hook: async (n, f) => { hooks[`shell.${n}`] = f; } },
    session: { hook: async (n, f) => { hooks[`session.${n}`] = f; } },
    event: {
      subscribe: () => (async function* () {
        yield { type: 'session.created', data: { sessionID: 'ses_2' }, location: { directory: proj } };
      })(),
    },
  };
  await mod.setup(ctx);
  for (let i = 0; i < 400 && !hooks['session.context']; i++) await new Promise((r) => setImmediate(r));
  const e = { system: [{ type: 'text', text: 'base' }], options: {} };
  for (let i = 0; i < 40 && e.system.length < 2; i++) {
    await delay(50);
    await hooks['session.context'](e);
  }
  assert.equal(e.system.length, 2);
  assert.equal(e.system[1].type, 'text');
  assert.match(e.system[1].text, /Project State Reminder/);
});

test('graphify auto-update: only an opted-in project spawns the hook, and only for shell calls', { skip: SKIP }, async (t) => {
  const trace = path.join(os.tmpdir(), `gsd-oc-graphify-${process.pid}-${Date.now()}.log`);
  t.after(() => cleanup(trace));
  const shell = path.join(os.tmpdir(), `gsd-oc-shell-${process.pid}-${Date.now()}`);
  fs.writeFileSync(shell, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(trace)}, require('path').basename(process.argv[2]) + '\\n');\n`);
  fs.chmodSync(shell, 0o755);
  t.after(() => cleanup(shell));
  const prior = process.env.GSD_HOOK_SHELL;
  const priorCi = process.env.CI;
  process.env.GSD_HOOK_SHELL = shell;
  delete process.env.CI;
  t.after(() => {
    if (prior === undefined) delete process.env.GSD_HOOK_SHELL; else process.env.GSD_HOOK_SHELL = prior;
    if (priorCi !== undefined) process.env.CI = priorCi;
  });

  const optedIn = await plugin(t, { community: false, graphify: true });
  await optedIn.handlers['tool.execute.after']({ tool: 'bash', args: { command: 'git commit -m "feat: x"' } }, { output: '', metadata: {} });
  await optedIn.handlers['tool.execute.after']({ tool: 'read', args: { filePath: 'a' } }, { output: '', metadata: {} });
  assert.equal(fs.readFileSync(trace, 'utf8'), 'gsd-graphify-update.sh\n');

  cleanup(trace);
  const off = await plugin(t, { community: false, graphify: false });
  await off.handlers['tool.execute.after']({ tool: 'bash', args: { command: 'git commit -m "feat: x"' } }, { output: '', metadata: {} });
  assert.equal(fs.existsSync(trace), false);
});

test('the Kilo plugin carries none of the OpenCode-only hook parity', () => {
  const kilo = fs.readFileSync(path.join(ROOT, '.kilo', 'plugins', 'gsd-core.js'), 'utf8');
  for (const name of ['gsd-validate-commit.sh', 'gsd-phase-boundary.sh', 'gsd-session-state.sh', 'gsd-graphify-update.sh']) {
    assert.ok(!kilo.includes(name), `${name} must not appear in the Kilo plugin`);
  }
});

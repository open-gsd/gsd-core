const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'opencode-v2-plugin', 'index.cjs');
const BUNDLE = path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js');
const BUILDER = path.join(ROOT, 'scripts', 'build-opencode-v2-bundles.cjs');

function eventStream() {
  return {
    async *subscribe({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      if (!signal.aborted) yield undefined;
    },
  };
}

function context(log, options = {}) {
  const disposer = (name, failure = false) => ({ async dispose() {
    log.push(name);
    if (failure) throw new Error(`${name} failed`);
  } });
  return {
    app: { version: '2.0.3' },
    location: { project: { directory: ROOT, canonical: ROOT } },
    shell: { async hook() { return disposer('core-shell'); } },
    tool: {
      async hook(name) { return disposer(`core-${name}`); },
      async transform(callback) {
        if (options.failWorktreeSetup) throw new Error('worktree setup failed');
        callback({ add() {} });
        return disposer('worktree-tool');
      },
    },
    session: {
      async hook(name) { return disposer(`core-${name}`, options.failCoreCleanup); },
      async get() { return { id: 'ses_parent', permissions: [] }; },
    },
    rpc: { async register() { return disposer('worktree-rpc', options.failWorktreeCleanup); } },
    event: eventStream(),
    storage: { async scan() { return { entries: [] }; } },
    worktree: { async list() { return []; } },
  };
}

test('source descriptor is immediately the exact flat host shape', () => {
  delete require.cache[SOURCE];
  const descriptor = require(SOURCE);
  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'setup']);
  assert.equal(descriptor.id, 'gsd-core');
  assert.equal(typeof descriptor.setup, 'function');
});

test('setup rolls core back when the worktree registration fails', async () => {
  const log = [];
  const descriptor = require(SOURCE);
  await assert.rejects(descriptor.setup(context(log, { failWorktreeSetup: true })), /worktree setup failed/);
  assert.deepEqual(log, [
    'core-compaction',
    'core-execute.after',
    'core-execute.before',
    'core-shell',
  ]);
});

test('cleanup runs worktree then core, settles both failures, and is idempotent', async () => {
  const log = [];
  const descriptor = require(SOURCE);
  const cleanup = await descriptor.setup(context(log, { failWorktreeCleanup: true, failCoreCleanup: true }));
  await assert.rejects(cleanup(), AggregateError);
  assert.deepEqual(log, [
    'worktree-rpc',
    'worktree-tool',
    'core-compaction',
    'core-execute.after',
    'core-execute.before',
    'core-shell',
  ]);
  await assert.rejects(cleanup(), AggregateError);
  assert.equal(log.length, 6);
});

test('bundle is deterministic, checkable, and has no external @opencode import', () => {
  for (const args of [[], ['--check']]) {
    const result = runNode([BUILDER, ...args], { cwd: ROOT });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(bundle, /Third-Party Notices for the generated OpenCode V2 runtime bundle/);
  assert.doesNotMatch(bundle, /\brequire\(\s*["']@opencode\//);
  assert.doesNotMatch(bundle, /\bimport\(\s*["']@opencode\//);
  const descriptor = require(BUNDLE);
  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'setup']);
  assert.equal(descriptor.id, 'gsd-core');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'opencode-v2-plugin', 'index.cjs');
const BUNDLE = path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js');
const BUILDER = path.join(ROOT, 'scripts', 'build-opencode-v2-bundles.cjs');
const { bundleBuildOptions } = require('../scripts/build-opencode-v2-bundles.cjs');

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

test('producer keeps symlinked node_modules paths inside the checkout', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-v2-bundle-'));
  try {
    const dependencyRoot = path.join(fixture, 'dependency-target');
    const projectRoot = path.join(fixture, 'project');
    fs.mkdirSync(path.join(dependencyRoot, 'linked-package'), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, 'linked-package', 'package.json'), JSON.stringify({ name: 'linked-package', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dependencyRoot, 'linked-package', 'index.js'), 'module.exports = "linked";\n');
    fs.writeFileSync(path.join(projectRoot, 'entry.cjs'), 'module.exports = require("linked-package");\n');
    fs.symlinkSync(dependencyRoot, path.join(projectRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await esbuild.build(bundleBuildOptions({ entry: 'entry.cjs', outfile: 'bundle.cjs', format: 'cjs', sourcemap: false }, projectRoot));
    const output = Buffer.from(result.outputFiles[0].contents).toString('utf8');
    assert.equal(output.includes(dependencyRoot), false, 'bundle must not disclose the node_modules symlink target');
    assert.match(output, /node_modules\/linked-package\/index\.js/);
  } finally {
    cleanup(fixture);
  }
});

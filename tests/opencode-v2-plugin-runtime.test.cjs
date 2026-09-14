const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js');
const BUILDER = path.join(ROOT, 'scripts', 'build-opencode-v2-bundles.cjs');
const {
  bundleBuildOptions,
  renderNotice,
  reviewedPackageMetadata,
} = require('../scripts/build-opencode-v2-bundles.cjs');

const EFFECT_LICENSE_SHA256 = '774c3bc5924ad8ae6c5a75f1c53db13feb238ade15989625c513d07b60dedf30';

function effectMetadata() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'effect', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  return { manifest, lockEntry: lock.packages['node_modules/effect'] };
}

function changed(object, pathSegments, value) {
  const copy = structuredClone(object);
  let target = copy;
  for (const segment of pathSegments.slice(0, -1)) target = target[segment];
  target[pathSegments.at(-1)] = value;
  return copy;
}

test('bundle notice policy accepts reviewed effect exact metadata', () => {
  const { manifest, lockEntry } = effectMetadata();
  const metadata = reviewedPackageMetadata('effect', manifest, lockEntry);
  assert.equal(metadata.name, 'effect');
  assert.equal(metadata.version, '4.0.0-rc.112');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.repository, 'https://github.com/Effect-TS/effect.git');
  assert.equal(metadata.directory, 'packages/effect');
  assert.equal(metadata.resolved, 'https://registry.npmjs.org/effect/-/effect-4.0.0-rc.112.tgz');
  assert.equal(metadata.integrity, 'sha512-wXxwuh1Ywnv4cPRM3Wfa0vDwuOHnZ1TsTgHJkG9XgzND6inhBH9n1vBxhg3iIXOia/OrpmvVmd3lrD4vq6bF3A==');
  assert.equal(metadata.provenance, true);
  assert.equal(metadata.licensePath, 'LICENSE');
  assert.equal(metadata.licenseSha256, EFFECT_LICENSE_SHA256);
});

test('bundle notice policy rejects unknown dependencies including the OpenCode namespace', () => {
  assert.throws(() => reviewedPackageMetadata('unknown', {}, {}), /unexpected bundled dependency unknown/);
  assert.throws(() => reviewedPackageMetadata('@opencode/unreviewed', { license: 'MIT' }, {}), /unexpected bundled dependency @opencode\/unreviewed/);
});

test('bundle notice policy rejects wrong effect version and SPDX license', () => {
  const { manifest, lockEntry } = effectMetadata();
  assert.throws(() => reviewedPackageMetadata('effect', changed(manifest, ['version'], '4.0.0'), lockEntry), /effect manifest version/);
  assert.throws(() => reviewedPackageMetadata('effect', changed(manifest, ['license'], 'Apache-2.0'), lockEntry), /effect manifest license/);
});

test('bundle notice policy rejects wrong effect repository and directory', () => {
  const { manifest, lockEntry } = effectMetadata();
  assert.throws(() => reviewedPackageMetadata('effect', changed(manifest, ['repository', 'url'], 'https://example.invalid/effect.git'), lockEntry), /effect manifest repository/);
  assert.throws(() => reviewedPackageMetadata('effect', changed(manifest, ['repository', 'directory'], 'packages/other'), lockEntry), /effect manifest repository directory/);
});

test('bundle notice policy rejects wrong effect lock SRI', () => {
  const { manifest, lockEntry } = effectMetadata();
  assert.throws(() => reviewedPackageMetadata('effect', manifest, changed(lockEntry, ['integrity'], 'sha512-wrong')), /effect lock integrity/);
});

test('bundle notice policy rejects wrong embedded effect license digest', () => {
  const { manifest, lockEntry } = effectMetadata();
  assert.throws(() => reviewedPackageMetadata('effect', manifest, lockEntry, { effectLicenseText: 'MIT License\nwrong\n' }), /effect reviewed license digest/);
});

test('bundle notice policy renders deterministic lexical package ordering under shuffled input', () => {
  const expected = ['@opencode/client', '@opencode/protocol', '@opencode/schema', 'effect'];
  const first = renderNotice(new Set(['effect', '@opencode/schema', '@opencode/client', '@opencode/protocol']));
  const second = renderNotice(new Set(['@opencode/protocol', 'effect', '@opencode/schema', '@opencode/client']));
  assert.equal(first, second);
  const positions = expected.map((name) => first.indexOf(`${name}@`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('bundle notice policy retains distinct OpenCode and Effect MIT blocks', () => {
  const notice = renderNotice(new Set(['effect', '@opencode/client']));
  assert.match(notice, /Copyright \(c\) 2025 opencode/);
  assert.match(notice, /Copyright \(c\) 2023 Effectful Technologies Inc/);
  assert.equal((notice.match(/MIT License/g) || []).length, 2);
  assert.equal((notice.match(/Copyright \(c\) 2025 opencode/g) || []).length, 1);
  assert.equal((notice.match(/Copyright \(c\) 2023 Effectful Technologies Inc/g) || []).length, 1);
});

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
        callback({ add(definition) { options.toolDefinitions?.push(definition); } });
        return disposer('worktree-tool');
      },
    },
    session: {
      async hook(name) { return disposer(`core-${name}`, options.failCoreCleanup); },
      async get() { return { id: 'ses_parent', permissions: [] }; },
    },
    rpc: { async register(id, definition) { options.rpcDefinitions?.push({ id, definition }); if (options.failRpcSetup) throw new Error('rpc setup failed'); return disposer('worktree-rpc', options.failWorktreeCleanup); } },
    event: eventStream(),
    storage: { async scan() { return { entries: [] }; } },
    worktree: { async list() { return []; } },
  };
}

test('C5-01', () => {
  delete require.cache[BUNDLE];
  const descriptor = require(BUNDLE);
  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'setup']);
  assert.equal(descriptor.id, 'gsd-core');
  assert.equal(typeof descriptor.setup, 'function');
});

test('C5-02', async () => {
  const log = [];
  const toolDefinitions = [];
  const descriptor = require(BUNDLE);
  await assert.rejects(descriptor.setup(context(log, { toolDefinitions, failRpcSetup: true })), /rpc setup failed/);
  assert.equal(toolDefinitions.length, 1);
  assert.equal(toolDefinitions[0].name, 'gsd_worktree_task');
  assert.equal(typeof toolDefinitions[0].execute, 'function');
  assert.equal(toolDefinitions[0].options.codemode, true);
  assert.deepEqual(Object.keys(toolDefinitions[0].input).sort(), ['oneOf']);
});

test('C5-03', async () => {
  const log = [], rpcDefinitions = [];
  const descriptor = require(BUNDLE);
  const cleanup = await descriptor.setup(context(log, { rpcDefinitions }));
  assert.equal(rpcDefinitions.length, 1);
  assert.equal(rpcDefinitions[0].id.id, 'gsd-worktree-task.attestation.v1');
  assert.equal(typeof rpcDefinitions[0].definition.status, 'function');
  await cleanup();
  assert.equal(log[0], 'worktree-rpc');
});

test('C5-04', async () => {
  const result = runNode([BUILDER, '--check'], { cwd: ROOT });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(bundle, /Third-Party Notices for the generated OpenCode V2 runtime bundle/);
  assert.doesNotMatch(bundle, /\brequire\(\s*["']@opencode\//);
  assert.doesNotMatch(bundle, /\bimport\(\s*["']@opencode\//);
  const descriptor = require(BUNDLE);
  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'setup']);
  assert.equal(descriptor.id, 'gsd-core');
  const firstLog = [], secondLog = [];
  const firstCleanup = await descriptor.setup(context(firstLog));
  await firstCleanup();
  await firstCleanup();
  const secondCleanup = await descriptor.setup(context(secondLog));
  await secondCleanup();
  assert.deepEqual(firstLog, secondLog);
  assert.equal(firstLog.filter((entry) => entry === 'worktree-rpc').length, 1);
  assert.equal(firstLog.filter((entry) => entry === 'worktree-tool').length, 1);
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

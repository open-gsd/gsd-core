/**
 * #5683: `effort sync --apply` rewrites installed agent files, so it must keep
 * the install manifest (`gsd-file-manifest.json`) in step. Otherwise the next
 * install hashes the rewritten agent against the stale manifest entry and
 * reports it as a user-modified file (backed up to gsd-local-patches/).
 *
 * Two layers:
 *   - hermetic unit cases: a hand-built manifest + agents dir, `cmdEffortSync`
 *     in a child process (same harness shape as effort-sync-installed-runtime),
 *   - end-to-end cases: real installer -> real sync -> real installer re-run.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');

const { runNode } = require('./helpers/process-seam.cjs');
const { runMinimalInstall, INSTALL_SCRIPT, MANIFEST_NAME } = require('./helpers/install-shared.cjs');
const { cleanup, installSpawnEnv } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const COMMANDS_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'commands.cjs');
const E2E_TIMEOUT_MS = INSTALL_TIMEOUT_MS * 3;
const ZERO_HASH = '0'.repeat(64);
const STALE_HASH = 'a'.repeat(64);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-effort-sync-manifest-'));
  const cwd = path.join(root, 'project');
  const configDir = path.join(root, 'runtime-home');
  const agentsDir = path.join(configDir, 'agents');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, cwd, configDir, agentsDir, home };
}

function writeProjectConfig(cwd, overrides) {
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.planning', 'config.json'),
    JSON.stringify({ effort: { agent_overrides: overrides } }),
  );
}

function claudeAgent(name, effort, body = 'Body.') {
  return [
    '---', `name: ${name}`, 'description: x', `effort: ${effort}`, '---', '', body,
  ].join('\n');
}

function manifestPathOf(configDir) {
  return path.join(configDir, MANIFEST_NAME);
}

/** Compact (unindented) JSON so a re-serialising writer changes the bytes. */
function writeManifestFile(configDir, files) {
  const manifest = {
    manifestVersion: 2,
    version: '0.0.0-test',
    timestamp: '2020-01-01T00:00:00.000Z',
    mode: 'full',
    runtime: 'claude',
    scope: 'global',
    files,
  };
  fs.writeFileSync(manifestPathOf(configDir), JSON.stringify(manifest));
  return manifest;
}

function readManifest(configDir) {
  return JSON.parse(fs.readFileSync(manifestPathOf(configDir), 'utf8'));
}

function hashOnDisk(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/**
 * Runs `cmdEffortSync(cwd, false, opts)` in a child process and returns the
 * parsed JSON result. `preload` is JS source evaluated in the child before the
 * module is required (fault injection).
 */
function runEffortSync({ cwd, home, configDir, runtime, dryRun, preload = '' }) {
  const opts = { dryRun, configDir, runtime };
  const script = [
    preload,
    `const { cmdEffortSync } = require(${JSON.stringify(COMMANDS_CJS)});`,
    `cmdEffortSync(${JSON.stringify(cwd)}, false, ${JSON.stringify(opts)});`,
  ].join('\n');
  const spawned = runNode(['-e', script], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home },
  });
  assert.strictEqual(
    spawned.exitCode, 0,
    `cmdEffortSync child process failed (outcome=${spawned.outcome}):\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
  );
  const jsonStart = spawned.stdout.indexOf('{');
  assert.notStrictEqual(jsonStart, -1, `expected JSON output on stdout, got:\n${spawned.stdout}`);
  return JSON.parse(spawned.stdout.slice(jsonStart));
}

/** Re-runs the real installer over an existing config dir; returns its combined output. */
function reinstall({ runtime, configDir, root }) {
  const env = installSpawnEnv({ HOME: root, USERPROFILE: root });
  delete env.GSD_TEST_MODE;
  const result = runNode(
    [INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', configDir],
    { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  assert.strictEqual(
    result.exitCode, 0,
    `re-install failed (outcome=${result.outcome}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return `${result.stdout}\n${result.stderr}`;
}

function patchBackups(configDir) {
  const dir = path.join(configDir, 'gsd-local-patches', 'agents');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function assertNoFalsePatches(configDir, output) {
  assert.doesNotMatch(output, /locally modified/i, 'install must not report synced agents as locally modified');
  assert.deepStrictEqual(patchBackups(configDir), [], 'install must not back up synced agents as local patches');
  assert.strictEqual(
    fs.existsSync(path.join(configDir, 'gsd-local-patches')), false,
    'no gsd-local-patches/ directory may be created',
  );
}

/** Three claude agents; sync changes the ones whose on-disk effort differs from the override. */
function claudeFixture({ onDisk, overrides }) {
  const sb = makeSandbox();
  const names = Object.keys(onDisk);
  const files = { 'gsd-core/VERSION': ZERO_HASH, 'hooks/gsd-hook.js': STALE_HASH };
  for (const name of names) {
    const filePath = path.join(sb.agentsDir, `${name}.md`);
    fs.writeFileSync(filePath, claudeAgent(name, onDisk[name]));
    files[`agents/${name}.md`] = hashOnDisk(filePath);
  }
  writeProjectConfig(sb.cwd, overrides);
  const manifest = writeManifestFile(sb.configDir, files);
  return { ...sb, names, manifest, agentPath: (n) => path.join(sb.agentsDir, `${n}.md`) };
}

describe('#5683: effort sync keeps the install manifest in step with rewritten agents', () => {
  describe('regression: sync then install reports no local patches', () => {
    test('#5683: sync then install reports no local patches (claude)', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
      try {
        writeProjectConfig(root, { 'gsd-ai-researcher': 'low', 'gsd-advisor-researcher': 'medium' });
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 2, 'precondition: the sync rewrote exactly the two overridden agents');
        const output = reinstall({ runtime: 'claude', configDir, root });
        assertNoFalsePatches(configDir, output);
      } finally {
        cleanup(root);
      }
    });

    test('#5683: sync inherit-strip then install reports no local patches', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
      try {
        writeProjectConfig(root, { 'gsd-ai-researcher': 'inherit', 'gsd-advisor-researcher': 'inherit' });
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 2, 'precondition: two agents had their effort key stripped');
        for (const name of ['gsd-ai-researcher', 'gsd-advisor-researcher']) {
          const content = fs.readFileSync(path.join(configDir, 'agents', `${name}.md`), 'utf8');
          assert.doesNotMatch(content, /^effort:/m, `precondition: ${name} lost its effort key`);
        }
        const output = reinstall({ runtime: 'claude', configDir, root });
        assertNoFalsePatches(configDir, output);
      } finally {
        cleanup(root);
      }
    });

    test('#5683: sync then install reports no local patches (codex)', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'codex', scope: 'global' });
      try {
        // Reproduce an agent set installed by an older GSD that baked a stale
        // Anthropic model pin + effort: tamper the .toml and re-record its
        // hash, so manifest and disk agree before the sync runs.
        const manifest = readManifest(configDir);
        for (const name of ['gsd-ai-researcher', 'gsd-advisor-researcher']) {
          const filePath = path.join(configDir, 'agents', `${name}.toml`);
          const stale = fs.readFileSync(filePath, 'utf8').replace(
            /^description = .*$/m,
            (line) => [line, 'model = "claude-sonnet-4-5"', 'model_reasoning_effort = "high"'].join('\n'),
          );
          fs.writeFileSync(filePath, stale);
          manifest.files[`agents/${name}.toml`] = hashOnDisk(filePath);
        }
        fs.writeFileSync(manifestPathOf(configDir), JSON.stringify(manifest, null, 2));
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'codex', dryRun: false });
        assert.strictEqual(result.synced, 2, 'precondition: the sync stripped both stale pins');
        const output = reinstall({ runtime: 'codex', configDir, root });
        assertNoFalsePatches(configDir, output);
      } finally {
        cleanup(root);
      }
    });

    test('#5683: sync then install reports no local patches (opencode)', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
      try {
        writeProjectConfig(root, { 'gsd-ai-researcher': 'low', 'gsd-advisor-researcher': 'xhigh' });
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'opencode', dryRun: false });
        assert.ok(result.synced >= 2, 'precondition: variant written on at least the two overridden agents');
        const output = reinstall({ runtime: 'opencode', configDir, root });
        assertNoFalsePatches(configDir, output);
      } finally {
        cleanup(root);
      }
    });
  });

  describe('manifest entry bookkeeping (claude)', () => {
    test('#5683: manifest updates exactly one entry', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high', 'gsd-c': 'low' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'high', 'gsd-c': 'low' },
      });
      try {
        const before = readManifest(fx.configDir);
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 1);
        const after = readManifest(fx.configDir);
        assert.strictEqual(after.files['agents/gsd-a.md'], hashOnDisk(fx.agentPath('gsd-a')));
        assert.notStrictEqual(after.files['agents/gsd-a.md'], before.files['agents/gsd-a.md']);
        const { 'agents/gsd-a.md': _a, ...afterRest } = after.files;
        const { 'agents/gsd-a.md': _b, ...beforeRest } = before.files;
        assert.deepStrictEqual(afterRest, beforeRest, 'every other file entry is byte-identical');
        const { files: _f1, ...afterMeta } = after;
        const { files: _f2, ...beforeMeta } = before;
        assert.deepStrictEqual(afterMeta, beforeMeta, 'version, timestamp, manifestVersion, runtime, scope are untouched');
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: manifest untouched when nothing synced', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'xhigh', 'gsd-b': 'high', 'gsd-c': 'low' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'high', 'gsd-c': 'low' },
      });
      try {
        const before = fs.readFileSync(manifestPathOf(fx.configDir));
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 0);
        assert.deepStrictEqual(fs.readFileSync(manifestPathOf(fx.configDir)), before);
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: manifest updates all agents', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high', 'gsd-c': 'high' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'xhigh', 'gsd-c': 'low' },
      });
      try {
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 3);
        const after = readManifest(fx.configDir);
        for (const name of fx.names) {
          assert.strictEqual(after.files[`agents/${name}.md`], hashOnDisk(fx.agentPath(name)), name);
        }
        assert.strictEqual(after.files['gsd-core/VERSION'], ZERO_HASH);
        assert.strictEqual(after.files['hooks/gsd-hook.js'], STALE_HASH);
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: dry-run leaves manifest untouched', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high', 'gsd-c': 'low' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'low', 'gsd-c': 'low' },
      });
      try {
        const manifestBefore = fs.readFileSync(manifestPathOf(fx.configDir));
        const agentsBefore = fx.names.map((n) => fs.readFileSync(fx.agentPath(n)));
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: true });
        assert.strictEqual(result.synced, 2, 'precondition: drift is present');
        assert.strictEqual(result.dry_run, true);
        assert.deepStrictEqual(fs.readFileSync(manifestPathOf(fx.configDir)), manifestBefore);
        fx.names.forEach((n, i) => assert.deepStrictEqual(fs.readFileSync(fx.agentPath(n)), agentsBefore[i], n));
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: non-rewritten entries keep hashes', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'low' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'low' },
      });
      try {
        // gsd-b is already in sync with config but hand-edited on disk: its
        // recorded hash is deliberately stale, and the sync must not launder it.
        const manifest = readManifest(fx.configDir);
        manifest.files['agents/gsd-b.md'] = STALE_HASH;
        fs.writeFileSync(manifestPathOf(fx.configDir), JSON.stringify(manifest));
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 1);
        const after = readManifest(fx.configDir);
        assert.strictEqual(after.files['agents/gsd-b.md'], STALE_HASH);
        assert.strictEqual(after.files['agents/gsd-a.md'], hashOnDisk(fx.agentPath('gsd-a')));
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: pre-sync user edit stays unowned by the manifest', () => {
      // Contract: only a file that was GSD-owned (on-disk hash == manifest
      // entry) before the sync gets its new hash recorded. A hand-edit made
      // before the sync keeps its stale manifest entry so the next install
      // still detects it; the untouched agent is recorded as before.
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'xhigh' },
      });
      try {
        fs.appendFileSync(fx.agentPath('gsd-a'), '\nHand-edited line.\n');
        const before = readManifest(fx.configDir);
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 2);
        const content = fs.readFileSync(fx.agentPath('gsd-a'), 'utf8');
        assert.match(content, /^effort: xhigh$/m);
        assert.match(content, /Hand-edited line\./);
        const after = readManifest(fx.configDir);
        assert.strictEqual(after.files['agents/gsd-a.md'], before.files['agents/gsd-a.md'], 'edited agent entry unchanged');
        assert.notStrictEqual(after.files['agents/gsd-a.md'], hashOnDisk(fx.agentPath('gsd-a')));
        assert.strictEqual(after.files['agents/gsd-b.md'], hashOnDisk(fx.agentPath('gsd-b')), 'untouched agent is recorded');
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: sync then install still reports a pre-sync user edit as locally modified', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
      try {
        writeProjectConfig(root, { 'gsd-ai-researcher': 'low', 'gsd-advisor-researcher': 'medium' });
        const edited = path.join(configDir, 'agents', 'gsd-ai-researcher.md');
        const clean = path.join(configDir, 'agents', 'gsd-advisor-researcher.md');
        fs.appendFileSync(edited, '\nHand-edited line.\n');
        const before = readManifest(configDir);
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 2, 'precondition: both agents rewritten');
        const after = readManifest(configDir);
        assert.strictEqual(after.files['agents/gsd-ai-researcher.md'], before.files['agents/gsd-ai-researcher.md']);
        assert.strictEqual(after.files['agents/gsd-advisor-researcher.md'], hashOnDisk(clean));
        const output = reinstall({ runtime: 'claude', configDir, root });
        assert.match(output, /locally modified/i, 'the pre-sync edit is still detected');
        assert.deepStrictEqual(patchBackups(configDir), ['gsd-ai-researcher.md'], 'only the edited agent is backed up');
        assert.ok(fs.existsSync(edited));
      } finally {
        cleanup(root);
      }
    });

    test('#5683: sync tolerates missing or corrupt manifest', () => {
      const missing = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'low' },
      });
      const corrupt = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'low' },
      });
      try {
        cleanup(manifestPathOf(missing.configDir));
        const resultMissing = runEffortSync({ ...missing, runtime: 'claude', dryRun: false });
        assert.strictEqual(resultMissing.synced, 2);
        assert.strictEqual(fs.existsSync(manifestPathOf(missing.configDir)), false, 'no manifest is created');
        assert.match(fs.readFileSync(path.join(missing.agentsDir, 'gsd-a.md'), 'utf8'), /^effort: xhigh$/m);

        fs.writeFileSync(manifestPathOf(corrupt.configDir), '{not json');
        const resultCorrupt = runEffortSync({ ...corrupt, runtime: 'claude', dryRun: false });
        assert.strictEqual(resultCorrupt.synced, 2);
        assert.strictEqual(fs.readFileSync(manifestPathOf(corrupt.configDir), 'utf8'), '{not json');
      } finally {
        cleanup(missing.root);
        cleanup(corrupt.root);
      }
    });

    test('#5683: failed write leaves entry unchanged', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high', 'gsd-b': 'high' },
        overrides: { 'gsd-a': 'xhigh', 'gsd-b': 'xhigh' },
      });
      try {
        const before = readManifest(fx.configDir);
        const bBefore = fs.readFileSync(fx.agentPath('gsd-b'));
        // Fault injection: the tmp-file write for gsd-b fails; gsd-a succeeds.
        const preload = [
          "const fs = require('fs');",
          'const realWrite = fs.writeFileSync;',
          'fs.writeFileSync = function (p, ...rest) {',
          "  if (String(p).includes('gsd-b.md.tmp')) throw new Error('injected EIO');",
          '  return realWrite.call(this, p, ...rest);',
          '};',
        ].join('\n');
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false, preload });
        assert.strictEqual(result.skipped, 1, 'precondition: the failed write is folded into skipped');
        const after = readManifest(fx.configDir);
        assert.strictEqual(after.files['agents/gsd-b.md'], before.files['agents/gsd-b.md']);
        assert.deepStrictEqual(fs.readFileSync(fx.agentPath('gsd-b')), bBefore);
        assert.strictEqual(after.files['agents/gsd-a.md'], hashOnDisk(fx.agentPath('gsd-a')));
      } finally {
        cleanup(fx.root);
      }
    });

    test('#5683: result shape unchanged', () => {
      const fx = claudeFixture({
        onDisk: { 'gsd-a': 'high' },
        overrides: { 'gsd-a': 'xhigh' },
      });
      try {
        const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
        assert.deepStrictEqual(
          Object.keys(result).sort(),
          ['agents_dir', 'changes', 'dry_run', 'skipped', 'synced'],
        );
      } finally {
        cleanup(fx.root);
      }
    });
  });

  describe('detection of genuine edits is preserved', () => {
    test('#5683: post-sync user edit still detected', { timeout: E2E_TIMEOUT_MS }, () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
      try {
        writeProjectConfig(root, { 'gsd-ai-researcher': 'low', 'gsd-advisor-researcher': 'medium' });
        const result = runEffortSync({ cwd: root, home: root, configDir, runtime: 'claude', dryRun: false });
        assert.strictEqual(result.synced, 2, 'precondition');
        fs.appendFileSync(path.join(configDir, 'agents', 'gsd-ai-researcher.md'), '\n<!-- user edit -->\n');
        const output = reinstall({ runtime: 'claude', configDir, root });
        assert.match(output, /locally modified/i);
        assert.deepStrictEqual(patchBackups(configDir), ['gsd-ai-researcher.md']);
      } finally {
        cleanup(root);
      }
    });
  });

  describe('hash parity with the installer', () => {
    test('#5683: hash parity with installer fileHash', () => {
      // The installer records `sha256(file bytes)` as lowercase hex
      // (bin/install.js fileHash); the sync-side hash must be the same function
      // of the bytes the sync publishes, for any content.
      fc.assert(
        fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (body) => {
          const fx = claudeFixture({ onDisk: { 'gsd-a': 'high' }, overrides: { 'gsd-a': 'xhigh' } });
          try {
            fs.writeFileSync(fx.agentPath('gsd-a'), claudeAgent('gsd-a', 'high', body));
            const owned = readManifest(fx.configDir);
            owned.files['agents/gsd-a.md'] = hashOnDisk(fx.agentPath('gsd-a'));
            fs.writeFileSync(manifestPathOf(fx.configDir), JSON.stringify(owned));
            const result = runEffortSync({ ...fx, runtime: 'claude', dryRun: false });
            assert.strictEqual(result.synced, 1);
            const recorded = readManifest(fx.configDir).files['agents/gsd-a.md'];
            assert.match(recorded, /^[0-9a-f]{64}$/);
            assert.strictEqual(recorded, sha256(fs.readFileSync(fx.agentPath('gsd-a'))));
          } finally {
            cleanup(fx.root);
          }
        }),
        { numRuns: 12 },
      );
    });
  });
});

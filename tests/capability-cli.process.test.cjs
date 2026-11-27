'use strict';

/**
 * #6331 criterion 5: "A missing or unparseable manifest does not make `capability set` fail."
 *
 * A process-contract test: each row runs the INSTALLED `<config>/gsd-core/bin/gsd-tools.cjs` in
 * a child, as a user does. That process is the subject: its executing package is the installed
 * gsd-core corpus, which only the install manifest can vouch for, so the in-process helpers
 * (which execute the checkout) cannot reproduce it. Each row starts from a private copy of the
 * shared claude install (`copyRuntimeFixture`) and breaks it before the run.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { copyRuntimeFixture, runMinimalInstall } = require('./helpers/install-shared.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE } = require('../gsd-core/bin/lib/capability-writer.cjs');

const MANIFEST = 'gsd-file-manifest.json';
const SURFACE = '.gsd-surface.json';
const AI_ARTIFACT = 'gsd-ai-integration-phase';

/** Every file under `dir`, as relative path → sha256; a missing directory is `{}`. */
function treeDigest(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.lstatSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const readOrNull = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);

/** A private copy of a claude install, driven by its own installed gsd-tools. */
function installed(t, scope = 'global') {
  const { root, configDir } = copyRuntimeFixture({ runtime: 'claude', scope });
  t.after(() => cleanup(root));
  let cwd = root;
  if (scope === 'global') {
    cwd = createTempDir('cap-cli-6331-cwd-');
    t.after(() => cleanup(cwd));
  }
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
  const tools = path.join(configDir, 'gsd-core', 'bin', 'gsd-tools.cjs');
  const run = (args) => {
    const r = runNode([tools, ...args], { cwd, env: isolatedEnv({ home: root }), timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, `gsd-tools ${args.join(' ')}: ${r.stderr}`);
    return { exitCode: r.exitCode, out: JSON.parse(r.stdout) };
  };
  const set = (id, flag) => run(['capability', 'set', id, flag, '--runtime', 'claude', '--scope', scope, '--config-dir', configDir, '--raw']);
  // claude global stages commands as skills/; claude local keeps commands/.
  const snapshot = () => Object.fromEntries(['skills', 'agents', 'commands'].map((d) => [d, treeDigest(path.join(configDir, d))]));
  const hasAiArtifact = (snap) => [...Object.keys(snap.skills), ...Object.keys(snap.commands)].some((k) => k.startsWith(AI_ARTIFACT));
  return {
    root, configDir, run, set, snapshot, hasAiArtifact,
    manifestPath: path.join(configDir, MANIFEST),
    surfacePath: path.join(configDir, SURFACE),
  };
}

/** The CLI-boundary contract of a refused materialize: exit 1, an error, no skip, nothing changed. */
function assertStillFails(fx, { exitCode, out }, before) {
  assert.equal(exitCode, 1, 'capability set fails');
  assert.ok(out.errors.length > 0, 'the failure is reported');
  assert.equal(out.warnings.includes(MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE), false, 'and is not turned into a skip');
  assert.deepEqual(readOrNull(fx.manifestPath), before.manifest, 'the manifest is left as it was');
  assert.equal(fs.existsSync(fx.surfacePath), false, 'no surface state is written');
  assert.deepEqual(fx.snapshot(), before.tree, 'no runtime artifact changed');
}

describe('#6331 (real process: the installed gsd-tools is the subject): a missing or unparseable manifest does not make capability set fail', () => {
  test('the skip warning is exported as a string', () => {
    assert.equal(typeof MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE, 'string');
  });

  for (const [name, breakManifest] of [
    ['a manifest truncated to its first 200 bytes', (p) => fs.writeFileSync(p, fs.readFileSync(p).subarray(0, 200))],
    ['a missing manifest', (p) => fs.unlinkSync(p)],
  ]) {
    test(`${name}: capability set exits 0, says nothing was re-staged, and changes no runtime artifact`, (t) => {
      const fx = installed(t);
      breakManifest(fx.manifestPath);
      const manifestBefore = readOrNull(fx.manifestPath);
      const before = fx.snapshot();
      const { exitCode, out } = fx.set('assumption-delta', '--on');
      assert.deepEqual(out.errors, [], 'no error');
      assert.equal(exitCode, 0, 'capability set does not fail (#6331 criterion 5)');
      assert.ok(out.warnings.includes(MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE), 'it warns that nothing was re-staged');
      assert.deepEqual(readOrNull(fx.manifestPath), manifestBefore, 'the manifest is left as it was');
      assert.deepEqual(fx.snapshot(), before, 'nothing is staged from a corpus no manifest vouches for');
    });
  }

  test('a capability with skills switched off without a manifest: the state persists, and the next install applies it', (t) => {
    const fx = installed(t);
    fs.unlinkSync(fx.manifestPath);
    const before = fx.snapshot();
    assert.ok(fx.hasAiArtifact(before), 'sanity: the full profile installed the capability skill');
    const { exitCode, out } = fx.set('ai-integration', '--off');
    assert.deepEqual(out.errors, [], 'no error');
    assert.equal(exitCode, 0, 'capability set does not fail');
    assert.ok(out.warnings.includes(MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE), 'it warns that nothing was re-staged');
    assert.deepEqual(fx.snapshot(), before, 'no runtime artifact changed');
    const fresh = fx.run(['capability', 'state', '--config-dir', fx.configDir, '--raw']);
    assert.equal(fresh.exitCode, 0);
    assert.equal(fresh.out.capabilities.find((c) => c.id === 'ai-integration').enabled, false, 'a fresh read sees it disabled');
    // The installer's own run is under test here, so this is a real install over the copy.
    runMinimalInstall({ runtime: 'claude', scope: 'global', root: fx.root });
    assert.equal(fx.hasAiArtifact(fx.snapshot()), false, 'the next install removes the skill, as the warning says');
  });

  test('a surface state that cannot be written is an error, not a skip', (t) => {
    const fx = installed(t);
    fs.unlinkSync(fx.manifestPath);
    fs.mkdirSync(path.join(fx.surfacePath, 'blocker'), { recursive: true });
    const before = fx.snapshot();
    const { exitCode, out } = fx.set('ai-integration', '--off');
    assert.equal(exitCode, 1, 'capability set fails');
    assert.ok(out.errors.length > 0, 'the failed write is reported');
    assert.equal(out.warnings.includes(MATERIALIZE_SKIPPED_UNVERIFIED_SOURCE), false, 'no skip is claimed');
    assert.equal(fs.statSync(fx.surfacePath).isDirectory(), true, 'the blocking directory is left as it was');
    assert.deepEqual(fx.snapshot(), before, 'no runtime artifact changed');
  });

  // The real source-missing detection is not weakened: each of these fails exactly as before.
  for (const [name, breakInstall, opts] of [
    ['a missing manifest and a missing agents corpus', (fx) => {
      fs.unlinkSync(fx.manifestPath);
      cleanup(path.join(fx.configDir, 'gsd-core', 'agents'));
    }, {}],
    ['a valid manifest and a modified agents corpus file', (fx) => {
      const agents = path.join(fx.configDir, 'gsd-core', 'agents');
      const first = fs.readdirSync(agents).filter((n) => n.endsWith('.md')).sort()[0];
      fs.appendFileSync(path.join(agents, first), '\nlocal edit\n');
    }, {}],
    ['a manifest that is a symlink out of the config dir to an unparseable file', (fx) => {
      const outside = path.join(fx.root, 'outside-manifest.json');
      fs.writeFileSync(outside, '{ not json');
      fs.unlinkSync(fx.manifestPath);
      fs.symlinkSync(outside, fx.manifestPath);
    }, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }],
  ]) {
    test(`${name}: capability set still fails and changes nothing`, opts, (t) => {
      const fx = installed(t);
      breakInstall(fx);
      const before = { manifest: readOrNull(fx.manifestPath), tree: fx.snapshot() };
      assertStillFails(fx, fx.set('ai-integration', '--off'), before);
    });
  }

  test('local scope: a missing manifest never turns a source failure into a skip', (t) => {
    // A local install ships no command or agent corpus for its own gsd-tools to stage from, so a
    // local materialize through it fails with or without a manifest. Only a global layout may skip.
    const fx = installed(t, 'local');
    fs.unlinkSync(fx.manifestPath);
    const before = { manifest: null, tree: fx.snapshot() };
    assertStillFails(fx, fx.set('ai-integration', '--off'), before);
  });
});

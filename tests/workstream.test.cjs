/**
 * Workstream Tests — CRUD, env-var routing, collision detection
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, cleanup, captureFdSync } = require('./helpers.cjs');
const { createFixture, seedWorkstream } = require('./fixtures/index.cjs');
const {
  migrateToWorkstreams,
  getOtherActiveWorkstreams,
  cmdWorkstreamCreate,
  cmdWorkstreamComplete,
} = require('../gsd-core/bin/lib/workstream.cjs');

// ─── Helper ──────────────────────────────────────────────────────────────────

function createFailingTtyEnv(tmpDir) {
  const binDir = path.join(tmpDir, 'fake-bin');
  const markerFile = path.join(tmpDir, 'tty-invoked.log');
  const inheritedPath = process.env.PATH || process.env.Path || '';

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'tty'),
    '#!/bin/sh\nif [ -n "$GSD_TTY_MARKER" ]; then printf "tty\\n" >> "$GSD_TTY_MARKER"; fi\nexit 99\n',
    'utf-8'
  );
  fs.chmodSync(path.join(binDir, 'tty'), 0o755);
  fs.writeFileSync(
    path.join(binDir, 'tty.cmd'),
    '@echo off\r\nif not "%GSD_TTY_MARKER%"=="" echo tty>>"%GSD_TTY_MARKER%"\r\nexit /b 99\r\n',
    'utf-8'
  );

  return {
    markerFile,
    env: {
      PATH: `${binDir}${path.delimiter}${inheritedPath}`,
      GSD_TTY_MARKER: markerFile,
    },
  };
}

function getSessionPointerDir(tmpDir) {
  const planningPath = fs.realpathSync.native(path.join(tmpDir, '.planning'));
  const projectId = crypto
    .createHash('sha1')
    .update(planningPath)
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), 'gsd-workstream-sessions', projectId);
}

function sanitizeSessionToken(value) {
  const token = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return token ? token.slice(0, 160) : null;
}

function getSessionPointerFileName(envKey, value) {
  const token = sanitizeSessionToken(value);
  return `${envKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token}`;
}

// ─── planningDir / planningPaths env-var awareness ──────────────────────────

describe('planningDir workstream awareness via env var', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '# State\n**Status:** In progress\n**Current Phase:** 1\n',
      roadmap: '## Roadmap v1.0: Alpha\n### Phase 1: Setup\n',
      active: true,
    });
  });

  after(() => cleanup(tmpDir));

  test('state json returns workstream-scoped state when GSD_WORKSTREAM is set', () => {
    const result = runGsdTools(['state', 'json', '--raw'], tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `state json failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.ok(data.status || data.current_phase !== undefined, 'should return state data');
  });

  test('state json reads from flat .planning when no workstream set', () => {
    // Clear active-workstream so no auto-detection
    try { fs.unlinkSync(path.join(tmpDir, '.planning', 'active-workstream')); } catch {}
    const result = runGsdTools(['state', 'json', '--raw'], tmpDir, { GSD_WORKSTREAM: '' });
    // Should fail or return empty state since flat .planning/ has no STATE.md
    assert.ok(!result.success || result.output.includes('not found') || result.output === '{}',
      'should read from flat .planning/');
    // Restore
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'alpha\n');
  });

  test('--ws flag overrides GSD_WORKSTREAM env var', () => {
    // Create a second workstream
    const betaDir = path.join(tmpDir, '.planning', 'workstreams', 'beta');
    fs.mkdirSync(path.join(betaDir, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(betaDir, 'STATE.md'), '# State\n**Status:** Beta active\n');

    const result = runGsdTools(['state', 'json', '--raw', '--ws', 'beta'], tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `state json --ws beta failed: ${result.error}`);
  });
});

describe('session-scoped active workstream routing', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();

    for (const [ws, status] of [['alpha', 'Alpha active'], ['beta', 'Beta active']]) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), `# State\n**Status:** ${status}\n`);
    }
  });

  after(() => cleanup(tmpDir));

  test('stores active workstream per session instead of mutating shared pointer', () => {
    const alphaSet = runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const betaSet = runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(alphaSet.success, `alpha set failed: ${alphaSet.error}`);
    assert.ok(betaSet.success, `beta set failed: ${betaSet.error}`);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'active-workstream')),
      'shared active-workstream file should not be used when session keys are available');
  });

  test('different sessions resolve different active workstreams without --ws', () => {
    const alpha = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const beta = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(alpha.success, `alpha get failed: ${alpha.error}`);
    assert.ok(beta.success, `beta get failed: ${beta.error}`);
    assert.strictEqual(alpha.output, 'alpha');
    assert.strictEqual(beta.output, 'beta');
  });

  test('session-scoped pointer ignores legacy shared active-workstream file', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'beta\n');

    const alpha = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const shared = runGsdTools(['workstream', 'get', '--raw'], tmpDir);

    assert.ok(alpha.success, `session-scoped get failed: ${alpha.error}`);
    assert.ok(shared.success, `legacy get failed: ${shared.error}`);
    assert.strictEqual(alpha.output, 'alpha');
    assert.strictEqual(shared.output, 'beta');
  });

  test('state commands route to the session-scoped workstream automatically', () => {
    const alpha = runGsdTools(['state', 'json', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const beta = runGsdTools(['state', 'json', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(alpha.success, `alpha state failed: ${alpha.error}`);
    assert.ok(beta.success, `beta state failed: ${beta.error}`);
    const alphaState = JSON.parse(alpha.output);
    const betaState = JSON.parse(beta.output);
    assert.strictEqual(alphaState.status, 'Alpha active');
    assert.strictEqual(betaState.status, 'Beta active');
  });

  test('clearing one session does not clear another session pointer', () => {
    // A prior test in this shared-tmpDir block ('session-scoped pointer ignores
    // legacy shared active-workstream file') writes 'beta' into the shared
    // .planning/active-workstream marker. Under #3579 semantics, a cleared
    // session INHERITS that marker instead of resolving flat — so leaving the
    // marker in place here would make this test assert marker-inheritance
    // behavior it never intended to cover (that is pinned separately below).
    // This test's real intent is sibling-pointer isolation, not inheritance,
    // so remove the marker to make alpha's post-clear resolution independent
    // of whatever an earlier test in this block left on disk.
    try { fs.unlinkSync(path.join(tmpDir, '.planning', 'active-workstream')); } catch {}

    const clearAlpha = runGsdTools(['workstream', 'set', '--clear', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const alpha = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const beta = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(clearAlpha.success, `clear alpha failed: ${clearAlpha.error}`);
    assert.ok(alpha.success, `alpha get after clear failed: ${alpha.error}`);
    assert.ok(beta.success, `beta get after alpha clear failed: ${beta.error}`);

    const cleared = JSON.parse(alpha.output);
    assert.strictEqual(cleared.active, null);
    assert.strictEqual(beta.output, 'beta');
  });
});

describe('session resolution hardening', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();

    for (const [ws, status] of [['alpha', 'Alpha active'], ['beta', 'Beta active']]) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), `# State\n**Status:** ${status}\n`);
    }
  });

  afterEach(() => cleanup(tmpDir));

  test('headless runs skip tty probing and use the shared active-workstream fallback', () => {
    const { markerFile, env } = createFailingTtyEnv(tmpDir);
    const set = runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, env);
    const get = runGsdTools(['workstream', 'get', '--raw'], tmpDir, env);

    assert.ok(set.success, `headless set failed: ${set.error}`);
    assert.ok(get.success, `headless get failed: ${get.error}`);
    assert.ok(!fs.existsSync(markerFile), 'headless fallback should not invoke the tty subprocess');
    assert.strictEqual(get.output, 'alpha');
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'utf-8').trim(),
      'alpha'
    );
    assert.ok(!fs.existsSync(getSessionPointerDir(tmpDir)), 'headless fallback should not create session tmp pointers');
  });

  test('explicit runtime session ids outrank tty-derived identities', () => {
    const set = runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, {
      GSD_SESSION_KEY: 'shared-session',
      TTY: '/dev/pts/42',
    });
    const get = runGsdTools(['workstream', 'get', '--raw'], tmpDir, {
      GSD_SESSION_KEY: 'shared-session',
      TTY: '/dev/pts/99',
    });

    assert.ok(set.success, `session-key set failed: ${set.error}`);
    assert.ok(get.success, `session-key get failed: ${get.error}`);
    assert.strictEqual(get.output, 'alpha');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'active-workstream')));
  });

  test('TTY environment variables provide a session-scoped pointer without spawning tty', () => {
    const { markerFile, env } = createFailingTtyEnv(tmpDir);
    const ttyEnv = { ...env, TTY: '/dev/pts/42' };
    const set = runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, ttyEnv);
    const get = runGsdTools(['workstream', 'get', '--raw'], tmpDir, ttyEnv);

    assert.ok(set.success, `TTY set failed: ${set.error}`);
    assert.ok(get.success, `TTY get failed: ${get.error}`);
    assert.ok(!fs.existsSync(markerFile), 'TTY env should be used directly without invoking the tty subprocess');
    assert.strictEqual(get.output, 'beta');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'active-workstream')));
  });
});

// #3579: a session that has an identity (session key) but has never run
// `workstream use` must inherit the repo-wide `.planning/active-workstream`
// marker instead of resolving to nothing. peekActiveWorkstream has no CLI
// surface (only the statusline hook calls it), so these tests require the
// built module directly — same pattern as the planning-workspace.cjs require
// used elsewhere in this file.
describe('session inherits shared marker when pointer-less (#3579)', () => {
  let tmpDir;
  const {
    getActiveWorkstream,
    peekActiveWorkstream,
  } = require('../gsd-core/bin/lib/active-workstream-store.cjs');

  beforeEach(() => {
    tmpDir = createFixture();

    for (const [ws, status] of [['alpha', 'Alpha active'], ['beta', 'Beta active']]) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), `# State\n**Status:** ${status}\n`);
    }
  });

  afterEach(() => cleanup(tmpDir));

  test('session key present, no session pointer, marker names an existing workstream -> inherits the marker', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'alpha\n');

    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'no-pointer-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(result.output, 'alpha');
  });

  test('peekActiveWorkstream inherits the marker and mutates nothing', (t) => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'alpha\n');
    const sessionDir = getSessionPointerDir(tmpDir);
    const savedSessionKey = process.env.GSD_SESSION_KEY;
    process.env.GSD_SESSION_KEY = 'peek-no-pointer';
    t.after(() => {
      if (savedSessionKey !== undefined) process.env.GSD_SESSION_KEY = savedSessionKey;
      else delete process.env.GSD_SESSION_KEY;
    });

    const resolved = peekActiveWorkstream(tmpDir);
    assert.strictEqual(resolved, 'alpha');
    assert.strictEqual(fs.readFileSync(markerPath, 'utf-8'), 'alpha\n', 'peek must not mutate the shared marker');
    assert.ok(!fs.existsSync(sessionDir), 'peek must not create a session pointer file');
  });

  test('session pointer names beta while marker names alpha -> resolves beta, marker untouched (isolation)', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'alpha\n');
    runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, { GSD_SESSION_KEY: 'has-own-pointer' });

    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'has-own-pointer' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(result.output, 'beta');
    assert.strictEqual(fs.readFileSync(markerPath, 'utf-8'), 'alpha\n', 'session with its own pointer must never repoint the shared marker');
  });

  test('workstream set --clear with a valid repo marker present -> session returns to inheriting the marker, not flat', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'alpha\n');
    runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, { GSD_SESSION_KEY: 'clear-then-inherit-session' });

    const clear = runGsdTools(['workstream', 'set', '--clear', '--raw'], tmpDir, { GSD_SESSION_KEY: 'clear-then-inherit-session' });
    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'clear-then-inherit-session' });

    assert.ok(clear.success, `clear failed: ${clear.error}`);
    assert.ok(result.success, `get after clear failed: ${result.error}`);
    assert.strictEqual(
      result.output,
      'alpha',
      'clearing a session pointer must fall back to inheriting the shared marker (step 4), not resolve to null/flat',
    );
  });

  test('no session key, marker present -> resolves the marker (pre-existing path stays green)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'alpha\n');

    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir, {});

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(result.output, 'alpha');
  });

  test('no workstreams/ dir -> flat/null, unchanged', (t) => {
    // createFixture() only creates .planning/phases, not .planning/workstreams.
    const flatDir = createFixture();
    t.after(() => cleanup(flatDir));

    const savedSessionKey = process.env.GSD_SESSION_KEY;
    process.env.GSD_SESSION_KEY = 'flat-no-workstreams-dir';
    t.after(() => {
      if (savedSessionKey !== undefined) process.env.GSD_SESSION_KEY = savedSessionKey;
      else delete process.env.GSD_SESSION_KEY;
    });

    assert.strictEqual(getActiveWorkstream(flatDir), null);
    assert.strictEqual(peekActiveWorkstream(flatDir), null);
  });

  test('marker names a non-existent workstream, session has no pointer -> resolves null and the marker file is NOT deleted', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'ghost-workstream\n');

    const result = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'stale-marker-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).active, null);
    assert.ok(fs.existsSync(markerPath), 'a pointer-less session read must never delete the shared marker');
    assert.strictEqual(fs.readFileSync(markerPath, 'utf-8'), 'ghost-workstream\n');
  });

  test('session pointer file exists but is whitespace-only -> treated as absent, inherits the marker', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'beta\n');

    runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'whitespace-pointer-session' });
    const sessionDir = getSessionPointerDir(tmpDir);
    const sessionFile = getSessionPointerFileName('GSD_SESSION_KEY', 'whitespace-pointer-session');
    fs.writeFileSync(path.join(sessionDir, sessionFile), '   \n');

    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'whitespace-pointer-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(result.output, 'beta');
  });

  test('shared marker is whitespace-only, session pointer-less -> resolves null', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, '   \n');

    const result = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'whitespace-marker-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).active, null);
  });

  test('shared marker file is empty, session pointer-less -> resolves null', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, '');

    const result = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'empty-marker-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).active, null);
  });

  test('session pointer is stale (its workstream is deleted) while marker names a different, still-valid workstream -> resolves null, never falls through to inherit the marker', () => {
    const markerPath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(markerPath, 'beta\n');
    runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'stale-own-pointer-session' });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test fault injection: simulates a deleted workstream to exercise stale-pointer self-cleanup
    fs.rmSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true, force: true });

    const result = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'stale-own-pointer-session' });

    assert.ok(result.success, `get failed: ${result.error}`);
    assert.strictEqual(
      JSON.parse(result.output).active,
      null,
      'a stale OWNED pointer must self-heal to null — it must not fall through to the shared marker just because it failed to resolve',
    );
    assert.strictEqual(fs.readFileSync(markerPath, 'utf-8'), 'beta\n', 'the shared marker must remain untouched');
  });

  // #3579 item 1: the #1912/#2028 workstream-mode fail-safe guards must
  // distinguish "no marker/pointer anywhere" from "a marker exists but did
  // not resolve" — asserted structurally (via --json-errors) per CONTRIBUTING,
  // not by regexing the human-readable message.
  test('init.progress fail-safe guard: no marker at all -> reason workstream_mode_none_active', () => {
    const result = runGsdTools(['--json-errors', 'init', 'progress'], tmpDir);

    assert.equal(result.success, false, 'must still refuse');
    const payload = JSON.parse(result.error);
    assert.equal(payload.reason, 'workstream_mode_none_active');
  });

  test('init.progress fail-safe guard: marker present but names a missing workstream dir -> reason workstream_mode_marker_unresolved, distinct message', () => {
    const noneResult = runGsdTools(['--json-errors', 'init', 'progress'], tmpDir);
    const nonePayload = JSON.parse(noneResult.error);

    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'ghost-workstream\n');
    const unresolvedResult = runGsdTools(['--json-errors', 'init', 'progress'], tmpDir);

    assert.equal(unresolvedResult.success, false, 'must still refuse');
    const unresolvedPayload = JSON.parse(unresolvedResult.error);
    assert.equal(unresolvedPayload.reason, 'workstream_mode_marker_unresolved');
    assert.equal(unresolvedPayload.marker_value, 'ghost-workstream');
    assert.equal(unresolvedPayload.marker_reason, 'missing_workstream_dir');
    assert.notEqual(
      unresolvedPayload.message,
      nonePayload.message,
      'the marker-present-but-unresolved diagnostic must differ from the no-marker-at-all diagnostic',
    );
  });

  test('init.progress fail-safe guard: marker present but names an invalid workstream name -> reason workstream_mode_marker_unresolved, invalid_name', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'bad/name\n');

    const result = runGsdTools(['--json-errors', 'init', 'progress'], tmpDir);

    assert.equal(result.success, false, 'must still refuse');
    const payload = JSON.parse(result.error);
    assert.equal(payload.reason, 'workstream_mode_marker_unresolved');
    assert.equal(payload.marker_value, 'bad/name');
    assert.equal(payload.marker_reason, 'invalid_name');
  });
});

describe('pointer lifecycle hardening', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();

    for (const [ws, status] of [['alpha', 'Alpha active'], ['beta', 'Beta active']]) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), `# State\n**Status:** ${status}\n`);
    }
  });

  afterEach(() => cleanup(tmpDir));

  test('clearing one session pointer leaves sibling session pointers intact', () => {
    const sessionDir = getSessionPointerDir(tmpDir);
    const alphaFile = getSessionPointerFileName('GSD_SESSION_KEY', 'session-alpha');
    const betaFile = getSessionPointerFileName('GSD_SESSION_KEY', 'session-beta');

    runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    const clearAlpha = runGsdTools(['workstream', 'set', '--clear', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const beta = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(clearAlpha.success, `clear alpha failed: ${clearAlpha.error}`);
    assert.ok(beta.success, `beta get failed: ${beta.error}`);
    assert.strictEqual(beta.output, 'beta');
    assert.ok(fs.existsSync(sessionDir), 'session tmp directory should remain while a sibling pointer exists');
    assert.deepStrictEqual(fs.readdirSync(sessionDir).sort(), [betaFile]);
    assert.ok(!fs.existsSync(path.join(sessionDir, alphaFile)));
  });

  test('stale pointers self-clean without deleting sibling session pointers', () => {
    const sessionDir = getSessionPointerDir(tmpDir);
    const betaFile = getSessionPointerFileName('GSD_SESSION_KEY', 'session-beta');

    runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    runGsdTools(['workstream', 'set', 'beta', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test fault injection: simulates a deleted workstream to exercise stale-pointer self-cleanup
    fs.rmSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true, force: true });

    const alpha = runGsdTools(['workstream', 'get'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });
    const beta = runGsdTools(['workstream', 'get', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-beta' });

    assert.ok(alpha.success, `stale alpha get failed: ${alpha.error}`);
    assert.ok(beta.success, `beta get after stale cleanup failed: ${beta.error}`);
    assert.strictEqual(JSON.parse(alpha.output).active, null);
    assert.strictEqual(beta.output, 'beta');
    assert.ok(fs.existsSync(sessionDir), 'sibling pointer should keep the session tmp directory alive');
    assert.deepStrictEqual(fs.readdirSync(sessionDir).sort(), [betaFile]);
  });

  test('clearing the last session pointer removes the empty session tmp directory', () => {
    const sessionDir = getSessionPointerDir(tmpDir);
    const set = runGsdTools(['workstream', 'set', 'alpha', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });

    assert.ok(set.success, `set alpha failed: ${set.error}`);
    assert.ok(fs.existsSync(sessionDir), 'session tmp directory should exist after storing a session-scoped pointer');

    const clear = runGsdTools(['workstream', 'set', '--clear', '--raw'], tmpDir, { GSD_SESSION_KEY: 'session-alpha' });

    assert.ok(clear.success, `clear alpha failed: ${clear.error}`);
    assert.ok(!fs.existsSync(sessionDir), 'last-pointer cleanup should remove the empty session tmp directory');
  });
});

// ─── Workstream CRUD ────────────────────────────────────────────────────────

describe('workstream create', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
  });

  after(() => cleanup(tmpDir));

  test('creates a new workstream in clean project', () => {
    const result = runGsdTools(['workstream', 'create', 'feature-x', '--raw'], tmpDir);
    assert.ok(result.success, `create failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.created, true);
    assert.strictEqual(data.workstream, 'feature-x');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'feature-x', 'STATE.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'feature-x', 'phases')));
  });

  test('sets created workstream as active', () => {
    const active = fs.readFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'utf-8').trim();
    assert.strictEqual(active, 'feature-x');
  });

  test('rejects duplicate workstream', () => {
    const result = runGsdTools(['workstream', 'create', 'feature-x', '--raw'], tmpDir);
    assert.ok(result.success); // returns success with error field
    const data = JSON.parse(result.output);
    assert.strictEqual(data.created, false);
    assert.strictEqual(data.error, 'already_exists');
  });

  test('creates second workstream', () => {
    const result = runGsdTools(['workstream', 'create', 'feature-y', '--raw'], tmpDir);
    assert.ok(result.success);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.created, true);
    assert.strictEqual(data.workstream, 'feature-y');
  });
});

describe('workstream create with migration', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    // Existing flat-mode work
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '## Roadmap v1.0: Existing\n### Phase 1: A\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n**Status:** In progress\n');
  });

  after(() => cleanup(tmpDir));

  test('migrates existing flat work to named workstream', () => {
    const result = runGsdTools(['workstream', 'create', 'new-feature', '--migrate-name', 'existing-work', '--raw'], tmpDir);
    assert.ok(result.success, `create with migration failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.created, true);
    assert.ok(data.migration, 'should include migration info');
    assert.strictEqual(data.migration.workstream, 'existing-work');
    // Old flat files moved to workstream dir
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'existing-work', 'ROADMAP.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'existing-work', 'STATE.md')));
    // Shared files stay
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'PROJECT.md')));
  });

  test('normalizes --migrate-name to a valid workstream slug', () => {
    const isolatedDir = createFixture();
    try {
      fs.writeFileSync(path.join(isolatedDir, '.planning', 'PROJECT.md'), '# Project\n');
      fs.writeFileSync(path.join(isolatedDir, '.planning', 'ROADMAP.md'), '## Roadmap v1.0: Existing\n### Phase 1: A\n');
      fs.writeFileSync(path.join(isolatedDir, '.planning', 'STATE.md'), '# State\n**Status:** In progress\n');

      const result = runGsdTools(
        ['workstream', 'create', 'new-feature', '--migrate-name', 'Bad Name', '--raw'],
        isolatedDir
      );
      assert.ok(result.success, `create with migrate-name normalization failed: ${result.error}`);

      const data = JSON.parse(result.output);
      assert.strictEqual(data.created, true);
      assert.strictEqual(data.migration.workstream, 'bad-name');
      assert.ok(fs.existsSync(path.join(isolatedDir, '.planning', 'workstreams', 'bad-name', 'ROADMAP.md')));
      assert.ok(!fs.existsSync(path.join(isolatedDir, '.planning', 'workstreams', 'Bad Name')));
    } finally {
      cleanup(isolatedDir);
    }
  });
});

describe('migrateToWorkstreams', () => {
  test('rejects invalid workstream names for migration', () => {
    const tmpDir = createFixture();
    try {
      assert.throws(
        () => migrateToWorkstreams(tmpDir, 'bad/name'),
        /Invalid workstream name for migration/
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('fails when already in workstream mode', () => {
    const tmpDir = createFixture();
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'existing'), { recursive: true });
      assert.throws(
        () => migrateToWorkstreams(tmpDir, 'new-stream'),
        /Already in workstream mode/
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// #5120 pre-push review: STATE.md relocations and writes in workstream.cts run under the STATE.md lock.
describe('workstream STATE.md moves and writes hold the STATE.md lock (#5120)', () => {
  const STATE_LOCK_SUFFIX = 'STATE.md.lock';

  function eio(message) {
    return Object.assign(new Error(message), { code: 'EIO' });
  }

  // Mocks fs.renameSync and fs.openSync. Every rename whose source or destination basename is
  // STATE.md is logged with whether `${from}.lock` and `${to}.lock` both existed at that moment,
  // and every open of a STATE.md lock path is logged in order. `failWhen(from, to)` makes a rename
  // throw EIO instead of running. All calls otherwise go to the real functions.
  function instrument(t, { failWhen } = {}) {
    const realRename = fs.renameSync;
    const realOpen = fs.openSync;
    const events = [];
    t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
      if (failWhen && failWhen(String(from), String(to))) throw eio('injected EIO');
      if (path.basename(String(from)) !== 'STATE.md' && path.basename(String(to)) !== 'STATE.md') {
        events.push({ type: 'any-rename', from: String(from), to: String(to) });
      } else {
        events.push({
          type: 'rename',
          from: String(from),
          to: String(to),
          bothLocked: fs.existsSync(`${from}.lock`) && fs.existsSync(`${to}.lock`),
        });
      }
      return realRename.call(fs, from, to, ...rest);
    });
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (String(p).endsWith(STATE_LOCK_SUFFIX)) events.push({ type: 'open', path: String(p) });
      return realOpen.call(fs, p, ...rest);
    });
    return events;
  }

  function seedFlat(tmpDir) {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(planning, 'STATE.md'), '# State\noriginal\n');
    fs.writeFileSync(path.join(planning, 'REQUIREMENTS.md'), '# Requirements\n');
    fs.mkdirSync(path.join(planning, 'phases', '01-a'), { recursive: true });
    return planning;
  }

  function seedLockedWorkstream(tmpDir, name, extraDir) {
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', name);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\nworkstream\n');
    if (extraDir) {
      fs.mkdirSync(path.join(wsDir, extraDir), { recursive: true });
      fs.writeFileSync(path.join(wsDir, extraDir, 'x.md'), 'x\n');
    }
    return wsDir;
  }

  function lockFilesIn(dir) {
    return fs.readdirSync(dir).filter(n => n.startsWith(STATE_LOCK_SUFFIX));
  }

  test('migrateToWorkstreams moves STATE.md with the STATE.md lock held on both ends (#5120 pre-push review Mi4)', (t) => {
    const tmpDir = createFixture();
    try {
      const planning = seedFlat(tmpDir);
      const events = instrument(t);
      migrateToWorkstreams(tmpDir, 'main');
      const renames = events.filter(e => e.type === 'rename');
      assert.equal(renames.length, 1);
      assert.equal(renames[0].from, path.join(planning, 'STATE.md'));
      assert.equal(renames[0].to, path.join(planning, 'workstreams', 'main', 'STATE.md'));
      assert.ok(renames.every(e => e.bothLocked), JSON.stringify(renames));
      assert.deepEqual(lockFilesIn(planning), []);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('migrateToWorkstreams takes both STATE.md locks once, in sorted path order, before its first move, and rolls back inside them (#5120 pre-push review Mi4)', (t) => {
    const tmpDir = createFixture();
    try {
      const planning = seedFlat(tmpDir);
      const phasesDir = path.join(planning, 'phases');
      const events = instrument(t, { failWhen: (from) => from === phasesDir });
      assert.throws(() => migrateToWorkstreams(tmpDir, 'main'), (err) => err.code === 'EIO');

      assert.equal(fs.readFileSync(path.join(planning, 'STATE.md'), 'utf-8'), '# State\noriginal\n');
      const forwardFrom = path.join(planning, 'STATE.md');
      const wsState = path.join(planning, 'workstreams', 'main', 'STATE.md');
      const stateMoves = events.map((e, i) => ({ e, i })).filter(x => x.e.type === 'rename');
      assert.equal(stateMoves.length, 2);
      const [forward, rollback] = stateMoves;
      assert.equal(forward.e.from, forwardFrom);
      assert.equal(forward.e.to, wsState);
      assert.equal(rollback.e.from, wsState);
      assert.equal(rollback.e.to, forwardFrom);
      assert.equal(forward.e.bothLocked, true);
      assert.equal(rollback.e.bothLocked, true);

      // One lock scope for the whole move, rollback included: the two locks are opened once, in
      // ascending path order (a fixed order, so two moves between the same directories cannot
      // each hold the lock the other waits for), before the first rename of any entry.
      const opens = events.filter(e => e.type === 'open').map(e => e.path);
      assert.deepEqual(opens, [forwardFrom + '.lock', wsState + '.lock']);
      assert.deepEqual(opens, [...opens].sort());
      const firstRename = events.findIndex(e => e.type === 'rename' || e.type === 'any-rename');
      const lastOpen = events.map(e => e.type).lastIndexOf('open');
      assert.ok(firstRename === -1 || lastOpen < firstRename, JSON.stringify(events));
      assert.deepEqual(lockFilesIn(planning), []);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('cmdWorkstreamCreate keeps a STATE.md another writer created while it waited for the lock (#5120 pre-push review Mi4)', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const statePath = path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'STATE.md');
      const realOpen = fs.openSync;
      const realWrite = fs.writeFileSync;
      let injected = false;
      t.mock.method(fs, 'openSync', (p, ...rest) => {
        if (String(p) === `${statePath}.lock` && !injected) {
          injected = true;
          // The other writer lands after create's first existence check and before it holds the lock.
          realWrite.call(fs, statePath, '# Other writer\n');
        }
        return realOpen.call(fs, p, ...rest);
      });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamCreate(tmpDir, 'alpha', {}, false)));
      assert.equal(injected, true);
      assert.equal(out.created, true);
      assert.equal(fs.readFileSync(statePath, 'utf-8'), '# Other writer\n');
      assert.deepEqual(lockFilesIn(path.dirname(statePath)), []);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('cmdWorkstreamComplete archives a workstream whose STATE.md lock is stale, leaving no lock behind (#5120 pre-push review M1)', () => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedLockedWorkstream(tmpDir, 'alpha');
      // A pid far above any real pid limit: not running, so the lock is stolen, not waited for.
      fs.writeFileSync(path.join(wsDir, 'STATE.md.lock'), '2147483646');
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      assert.equal(out.completed, true);
      const archive = path.join(tmpDir, out.archived_to);
      assert.equal(fs.readFileSync(path.join(archive, 'STATE.md'), 'utf-8'), '# State\nworkstream\n');
      assert.deepEqual(lockFilesIn(archive), []);
      assert.equal(fs.existsSync(wsDir), false);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('cmdWorkstreamComplete archives a leftover STATE.md.lock.stale-* file like any other file and removes the workstream directory (#5120 pre-push review M1)', () => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedLockedWorkstream(tmpDir, 'alpha');
      const leftover = path.join(wsDir, 'STATE.md.lock.stale-1-2-3');
      fs.writeFileSync(leftover, '2147483646');
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      assert.equal(out.completed, true);
      const archive = path.join(tmpDir, out.archived_to);
      assert.equal(fs.existsSync(path.join(archive, 'STATE.md')), true);
      // A lock a steal renamed aside is a leftover, not the live lock: it is archived as before,
      // so the workstream directory empties and is removed.
      assert.deepEqual(lockFilesIn(archive), ['STATE.md.lock.stale-1-2-3']);
      assert.equal(fs.existsSync(wsDir), false);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('cmdWorkstreamComplete rolls STATE.md back under both locks when a later move fails (#5120 pre-push review Mi4)', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedLockedWorkstream(tmpDir, 'alpha', 'phases');
      const realReaddir = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (p, ...rest) => {
        const result = realReaddir.call(fs, p, ...rest);
        if (String(p) !== wsDir || !rest[0] || !rest[0].withFileTypes) return result;
        // STATE.md is moved first and the phases directory last, whatever the filesystem lists.
        return [...result].sort((a, b) => Number(b.name === 'STATE.md') - Number(a.name === 'STATE.md') || a.name.localeCompare(b.name));
      });
      const failFrom = path.join(wsDir, 'phases');
      const events = instrument(t, { failWhen: (from) => from === failFrom });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      assert.equal(out.completed, false);
      assert.equal(out.error, 'archive_failed');
      assert.equal(fs.readFileSync(path.join(wsDir, 'STATE.md'), 'utf-8'), '# State\nworkstream\n');
      const renames = events.filter(e => e.type === 'rename');
      assert.equal(renames.length, 2);
      assert.equal(renames[0].from, path.join(wsDir, 'STATE.md'));
      assert.equal(renames[1].to, path.join(wsDir, 'STATE.md'));
      assert.ok(renames.every(e => e.bothLocked), JSON.stringify(renames));
      assert.deepEqual(lockFilesIn(wsDir), []);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });
});

describe('workstream migrate and complete fault sweep (#5120)', () => {
  const FILES = {
    'ROADMAP.md': '# Roadmap\nroadmap-bytes\n',
    'STATE.md': '# State\nstate-bytes\n',
    'REQUIREMENTS.md': '# Requirements\nrequirements-bytes\n',
    'phases/01-a/PLAN.md': '# Plan\nplan-bytes\n',
  };

  function seedFiles(dir) {
    for (const [rel, content] of Object.entries(FILES)) {
      const p = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }

  function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  }

  // Runs one fresh fixture with the call numbers in `faults` (index into the ordered list of
  // matching fs calls) throwing. Returns the recorded call labels and the violations found.
  function runOnce(t, kind, faults) {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    const planning = path.join(tmpDir, '.planning');
    const calls = [];
    const violations = [];
    try {
      let srcDir; let newDirs;
      if (kind === 'migrate') {
        seedFiles(planning);
        srcDir = planning;
        newDirs = () => [path.join(planning, 'workstreams', 'main')];
      } else {
        srcDir = path.join(planning, 'workstreams', 'alpha');
        seedFiles(srcDir);
        newDirs = () => (fs.existsSync(path.join(planning, 'milestones'))
          ? fs.readdirSync(path.join(planning, 'milestones'))
            .filter(n => n.startsWith('ws-alpha-')).map(n => path.join(planning, 'milestones', n))
          : []);
      }
      const rel = (p) => path.relative(planning, p).split(path.sep).join('/');
      const realRename = fs.renameSync;
      const realOpen = fs.openSync;
      const hit = (label, err) => {
        const n = calls.length;
        calls.push(label);
        if (faults.has(n)) throw Object.assign(new Error('injected ' + err), { code: err });
      };
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (String(from).startsWith(planning) || String(to).startsWith(planning)) {
          hit('rename ' + rel(String(from)) + ' -> ' + rel(String(to)), 'EIO');
        }
        return realRename.call(fs, from, to, ...rest);
      });
      t.mock.method(fs, 'openSync', (p, ...args) => {
        if (String(p).endsWith('STATE.md.lock')) hit('lock ' + rel(String(p)), 'ENOSPC');
        return realOpen.call(fs, p, ...args);
      });

      let outcome;
      try {
        if (kind === 'migrate') {
          migrateToWorkstreams(tmpDir, 'main');
          outcome = 'returned';
        } else {
          outcome = captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)).replace(/\s+/g, ' ').trim().slice(0, 90);
        }
      } catch (err) {
        outcome = 'threw ' + (err && err.code ? err.code : String(err && err.message).slice(0, 60));
      }
      t.mock.restoreAll();

      const label = kind + ' faults=[' + [...faults].map(n => n + ':' + calls[n]).join(' ; ') + '] (' + outcome + ')';
      for (const [relFile, content] of Object.entries(FILES)) {
        const parts = relFile.split('/');
        const found = [path.join(srcDir, ...parts), ...newDirs().map(d => path.join(d, ...parts))]
          .filter(p => fs.existsSync(p));
        if (found.length !== 1) {
          violations.push(label + ': ' + relFile + ' present in ' + found.length + ' places [' + found.map(rel).join(', ') + ']');
        } else if (fs.readFileSync(found[0], 'utf-8') !== content) {
          violations.push(label + ': ' + relFile + ' changed bytes at ' + rel(found[0]));
        }
      }
      for (const p of walk(planning)) {
        if (path.basename(p).startsWith('STATE.md.lock')) violations.push(label + ': lock left behind ' + rel(p));
      }
    } finally {
      t.mock.restoreAll();
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
    return { calls, violations };
  }

  const sweepCalls = {};

  test('workstream migrate and complete conserve every file under any single injected failure (#5120 pre-push review R2-B1)', (t) => {
    const violations = [];
    for (const kind of ['migrate', 'complete']) {
      const dry = runOnce(t, kind, new Set());
      violations.push(...dry.violations);
      sweepCalls[kind] = dry.calls;
      for (let k = 0; k < dry.calls.length; k++) {
        const first = runOnce(t, kind, new Set([k]));
        violations.push(...first.violations);
        // Second level: a forward rename fails, then each later call (the rollback) fails too.
        if (dry.calls[k].startsWith('rename')) {
          for (let j = k + 1; j < first.calls.length; j++) {
            violations.push(...runOnce(t, kind, new Set([k, j])).violations);
          }
        }
      }
    }
    assert.deepEqual(violations, [], 'recorded calls: ' + JSON.stringify(sweepCalls, null, 1) + '\nviolations (' + violations.length + '):\n' + violations.join('\n'));
  });
});

// #5120 pre-push review R3-M1: the fault sweep above checks that files are conserved; these rows pin
// what migrate and complete promise beyond that, each in one fixture: the error names an entry the
// rollback could not return, a dead holder's lock with no STATE.md is removed, this process's own
// lock stays in the workstream directory for the whole move, the active pointer comes back when the
// archive fails, a stale lock another process removes mid-move is tolerated, and a failed migrate
// leaves no workstreams directory behind.
describe('workstream migrate and complete keep their promises (#5120 pre-push review R3-M1)', () => {
  const planningWorkspace = require('../gsd-core/bin/lib/planning-workspace.cjs');
  const eio = (message) => Object.assign(new Error(message), { code: 'EIO' });

  function seedFlat(planning) {
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(planning, 'STATE.md'), '# State\noriginal\n');
    fs.mkdirSync(path.join(planning, 'phases', '01-a'), { recursive: true });
  }

  function seedAlpha(tmpDir, files) {
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(wsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(wsDir, name), content);
    return wsDir;
  }

  // Makes the forward rename whose source is `failFrom` throw, and the reverse rename of STATE.md
  // (back onto `stateHome`) throw too, so the rollback cannot return STATE.md.
  function failForwardAndStateReturn(t, failFrom, stateHome) {
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
      if (String(from) === failFrom) throw eio('injected forward EIO');
      if (String(to) === path.join(stateHome, 'STATE.md')) throw eio('injected return EIO');
      return realRename.call(fs, from, to, ...rest);
    });
  }

  test('a failed migrate names the entry its rollback could not return and keeps the directory that holds it', (t) => {
    const tmpDir = createFixture();
    try {
      const planning = path.join(tmpDir, '.planning');
      seedFlat(planning);
      failForwardAndStateReturn(t, path.join(planning, 'phases'), planning);
      assert.throws(() => migrateToWorkstreams(tmpDir, 'main'), (err) =>
        err.message === 'injected forward EIO; NOT rolled back: STATE.md left in .planning/workstreams/main'
        && err.cause && err.cause.message === 'injected forward EIO');
      t.mock.restoreAll();
      assert.equal(fs.readFileSync(path.join(planning, 'workstreams', 'main', 'STATE.md'), 'utf-8'), '# State\noriginal\n');
      assert.equal(fs.existsSync(path.join(planning, 'ROADMAP.md')), true, 'every other entry is back');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('a failed migrate that returned every entry leaves no .planning/workstreams directory behind', (t) => {
    const tmpDir = createFixture();
    try {
      const planning = path.join(tmpDir, '.planning');
      seedFlat(planning);
      const realRename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (String(from) === path.join(planning, 'phases')) throw eio('injected forward EIO');
        return realRename.call(fs, from, to, ...rest);
      });
      assert.throws(() => migrateToWorkstreams(tmpDir, 'main'), (err) => err.message === 'injected forward EIO');
      t.mock.restoreAll();
      // An empty workstreams/<name>/ would switch the project into workstream mode.
      assert.equal(fs.existsSync(path.join(planning, 'workstreams')), false);
      assert.equal(fs.readFileSync(path.join(planning, 'STATE.md'), 'utf-8'), '# State\noriginal\n');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('a failed complete names the entry its rollback could not return and restores the active pointer', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n', 'ROADMAP.md': '# Roadmap\n' });
      fs.mkdirSync(path.join(wsDir, 'phases'));
      planningWorkspace.setActiveWorkstream(tmpDir, 'alpha');
      assert.equal(planningWorkspace.getActiveWorkstream(tmpDir), 'alpha', 'precondition: alpha is active');
      const realReaddir = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (p, ...rest) => {
        const result = realReaddir.call(fs, p, ...rest);
        if (String(p) !== wsDir || !rest[0] || !rest[0].withFileTypes) return result;
        // STATE.md is moved first and the phases directory last, whatever the filesystem lists.
        return [...result].sort((a, b) => Number(b.name === 'STATE.md') - Number(a.name === 'STATE.md') || Number(a.name === 'phases') - Number(b.name === 'phases'));
      });
      failForwardAndStateReturn(t, path.join(wsDir, 'phases'), wsDir);
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      t.mock.restoreAll();
      assert.equal(out.completed, false);
      assert.equal(out.error, 'archive_failed');
      assert.match(out.message, /^injected forward EIO; NOT rolled back: STATE\.md left in \.planning\/milestones\/ws-alpha-[^,]+$/);
      const archive = path.join(tmpDir, out.message.slice(out.message.indexOf('.planning/')));
      assert.equal(fs.readFileSync(path.join(archive, 'STATE.md'), 'utf-8'), '# State\nworkstream\n');
      assert.equal(planningWorkspace.getActiveWorkstream(tmpDir), 'alpha', 'the active pointer is restored');
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('complete removes a workstream that holds a dead holder\'s STATE.md.lock and no STATE.md (#5120 pre-push review R2-M1)', () => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      // A pid far above any real pid limit: not running, so the lock is taken over, not waited for.
      const wsDir = seedAlpha(tmpDir, { 'ROADMAP.md': '# Roadmap\n', 'STATE.md.lock': '2147483646' });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      assert.equal(out.completed, true);
      assert.equal(out.reverted_to_flat, true);
      assert.equal(fs.existsSync(wsDir), false, 'the workstream directory is removed');
      const archive = path.join(tmpDir, out.archived_to);
      assert.deepEqual(fs.readdirSync(archive), ['ROADMAP.md']);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('complete keeps this process\'s own STATE.md.lock in the workstream directory while it moves every entry', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n', 'ROADMAP.md': '# Roadmap\n' });
      const lock = path.join(wsDir, 'STATE.md.lock');
      const realReaddir = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (p, ...rest) => {
        const result = realReaddir.call(fs, p, ...rest);
        if (String(p) !== wsDir || !rest[0] || !rest[0].withFileTypes) return result;
        // The lock is listed first, so a move of it would come before every other entry's move.
        return [...result].sort((a, b) => Number(b.name === 'STATE.md.lock') - Number(a.name === 'STATE.md.lock'));
      });
      const realRename = fs.renameSync;
      const seen = [];
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (path.dirname(String(from)) === wsDir) {
          seen.push({ entry: path.basename(String(from)), ownLockHeld: fs.existsSync(lock) && fs.readFileSync(lock, 'utf-8') === String(process.pid) });
        }
        return realRename.call(fs, from, to, ...rest);
      });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      t.mock.restoreAll();
      assert.equal(out.completed, true);
      assert.deepEqual(seen.map(s => s.entry).sort(), ['ROADMAP.md', 'STATE.md'], 'the lock itself is never moved');
      assert.deepEqual(seen.filter(s => !s.ownLockHeld), [], 'the lock is held at every move');
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('complete tolerates a STATE.md.lock.stale-* leftover that another process removes before it is moved', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n', 'STATE.md.lock.stale-1-2-3': '2147483646' });
      const leftover = path.join(wsDir, 'STATE.md.lock.stale-1-2-3');
      const realRename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        // The other process's cleanup lands between the listing and this move.
        if (String(from) === leftover) fs.unlinkSync(leftover);
        return realRename.call(fs, from, to, ...rest);
      });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      t.mock.restoreAll();
      assert.equal(out.completed, true);
      assert.equal(fs.existsSync(wsDir), false);
      assert.deepEqual(fs.readdirSync(path.join(tmpDir, out.archived_to)), ['STATE.md']);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  // Makes the first unlink of `lock` throw EPERM, the transient Windows class the lock code retries elsewhere.
  function failFirstUnlinkOf(t, lock) {
    const realUnlink = fs.unlinkSync;
    const state = { failed: false };
    t.mock.method(fs, 'unlinkSync', (p, ...rest) => {
      if (!state.failed && String(p) === lock) {
        state.failed = true;
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      }
      return realUnlink.call(fs, p, ...rest);
    });
    return state;
  }

  test('a failed migrate names the directory it leaves when the release of its own lock fails (#5120 pre-push review R4-m3)', (t) => {
    const tmpDir = createFixture();
    try {
      const planning = path.join(tmpDir, '.planning');
      seedFlat(planning);
      const realRename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (String(from) === path.join(planning, 'phases')) throw eio('injected forward EIO');
        return realRename.call(fs, from, to, ...rest);
      });
      const unlink = failFirstUnlinkOf(t, path.join(planning, 'workstreams', 'main', 'STATE.md.lock'));
      assert.throws(() => migrateToWorkstreams(tmpDir, 'main'), (err) =>
        err.message === 'injected forward EIO; directory left behind: .planning/workstreams/main');
      t.mock.restoreAll();
      assert.equal(unlink.failed, true, 'precondition: the release of the workstream lock failed');
      assert.deepEqual(fs.readdirSync(path.join(planning, 'workstreams', 'main')), ['STATE.md.lock']);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('a failed complete names the archive directory it leaves when the release of its own lock fails (#5120 pre-push review R4-m3)', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n' });
      fs.mkdirSync(path.join(wsDir, 'phases'));
      const realRename = fs.renameSync;
      let archiveLock = null;
      t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (String(from) === path.join(wsDir, 'phases')) {
          archiveLock = path.join(path.dirname(String(to)), 'STATE.md.lock');
          throw eio('injected forward EIO');
        }
        return realRename.call(fs, from, to, ...rest);
      });
      const realUnlink = fs.unlinkSync;
      let failed = false;
      t.mock.method(fs, 'unlinkSync', (p, ...rest) => {
        if (!failed && archiveLock !== null && String(p) === archiveLock) {
          failed = true;
          throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
        }
        return realUnlink.call(fs, p, ...rest);
      });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      t.mock.restoreAll();
      assert.equal(failed, true, 'precondition: the release of the archive lock failed');
      assert.equal(out.error, 'archive_failed');
      assert.match(out.message, /^injected forward EIO; directory left behind: \.planning\/milestones\/ws-alpha-[^ ]+$/);
      assert.deepEqual(fs.readdirSync(path.join(tmpDir, out.message.slice(out.message.indexOf('.planning/')))), ['STATE.md.lock']);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('a completed archive whose workstream directory is gone has no workstream_dir_left in its output (#5120 pre-push review R4-n5)', () => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n' });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      assert.equal(out.completed, true);
      assert.equal(fs.existsSync(wsDir), false);
      assert.equal('workstream_dir_left' in out, false);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });

  test('complete names a workstream directory it could not remove because the release of its own lock failed (#5120 pre-push review R3-m2)', (t) => {
    const tmpDir = createFixture();
    const pointerDir = getSessionPointerDir(tmpDir);
    try {
      const wsDir = seedAlpha(tmpDir, { 'STATE.md': '# State\nworkstream\n' });
      const lock = path.join(wsDir, 'STATE.md.lock');
      const realUnlink = fs.unlinkSync;
      let failed = false;
      t.mock.method(fs, 'unlinkSync', (p, ...rest) => {
        if (!failed && String(p) === lock) {
          failed = true;
          throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
        }
        return realUnlink.call(fs, p, ...rest);
      });
      const out = JSON.parse(captureFdSync(1, () => cmdWorkstreamComplete(tmpDir, 'alpha', {}, false)));
      t.mock.restoreAll();
      assert.equal(failed, true, 'precondition: the release of the workstream\'s lock failed');
      assert.equal(out.completed, true);
      assert.equal(out.workstream_dir_left, '.planning/workstreams/alpha');
      assert.deepEqual(fs.readdirSync(wsDir), ['STATE.md.lock']);
    } finally {
      cleanup(pointerDir);
      cleanup(tmpDir);
    }
  });
});

describe('workstream list', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    // Create two workstreams
    for (const ws of ['alpha', 'beta']) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), `# State\n**Status:** Working on ${ws}\n**Current Phase:** 1\n`);
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'beta\n');
  });

  after(() => cleanup(tmpDir));

  test('lists all workstreams with active first, then lexical name', () => {
    const result = runGsdTools(['workstream', 'list', '--raw'], tmpDir);
    assert.ok(result.success, `list failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.mode, 'workstream');
    assert.strictEqual(data.count, 2);
    assert.deepStrictEqual(data.workstreams.map(w => w.name), ['beta', 'alpha']);
  });

  describe('flat mode', () => {
    let flatDir;

    beforeEach(() => {
      flatDir = createFixture();
    });

    afterEach(() => {
      cleanup(flatDir);
    });

    test('reports flat mode when no workstreams exist', () => {
      const result = runGsdTools(['workstream', 'list', '--raw'], flatDir);
      assert.ok(result.success);
      const data = JSON.parse(result.output);
      assert.strictEqual(data.mode, 'flat');
    });
  });
});

describe('workstream status', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(path.join(wsDir, 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'phases', '01-setup', 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n**Status:** In progress\n**Current Phase:** 1 — Setup\n');
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), '## Roadmap\n');
  });

  after(() => cleanup(tmpDir));

  test('returns detailed status for workstream', () => {
    const result = runGsdTools(['workstream', 'status', 'alpha', '--raw'], tmpDir);
    assert.ok(result.success, `status failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.found, true);
    assert.strictEqual(data.workstream, 'alpha');
    assert.strictEqual(data.files.roadmap, true);
    assert.strictEqual(data.files.state, true);
    assert.strictEqual(data.phase_count, 1);
  });

  test('returns not found for missing workstream', () => {
    const result = runGsdTools(['workstream', 'status', 'nonexistent', '--raw'], tmpDir);
    assert.ok(result.success);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.found, false);
  });
});

describe('workstream complete', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'done-ws');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n**Status:** Complete\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'done-ws\n');
  });

  after(() => cleanup(tmpDir));

  test('archives workstream to milestones/', () => {
    const result = runGsdTools(['workstream', 'complete', 'done-ws', '--raw'], tmpDir);
    assert.ok(result.success, `complete failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.completed, true);
    assert.ok(data.archived_to.startsWith('.planning/milestones/ws-done-ws'));
    // Workstream dir should be gone
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'workstreams', 'done-ws')));
  });

  test('clears active-workstream when completing active one', () => {
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'active-workstream')));
  });
});

describe('workstream set/get', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    for (const ws of ['ws-a', 'ws-b']) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n');
    }
  });

  after(() => cleanup(tmpDir));

  test('sets active workstream', () => {
    const result = runGsdTools(['workstream', 'set', 'ws-a', '--raw'], tmpDir);
    assert.ok(result.success);
    assert.strictEqual(result.output, 'ws-a');
  });

  test('gets active workstream', () => {
    const result = runGsdTools(['workstream', 'get', '--raw'], tmpDir);
    assert.ok(result.success);
    assert.strictEqual(result.output, 'ws-a');
  });

  test('errors when set called with no name (#1527)', () => {
    const result = runGsdTools(['workstream', 'set', '--raw'], tmpDir);
    assert.ok(!result.success, 'should fail when no name provided');
    assert.ok(result.error.includes('name required'), 'error should mention name required');
  });

  test('--clear explicitly unsets active workstream', () => {
    // First set one
    runGsdTools(['workstream', 'set', 'ws-b', '--raw'], tmpDir);
    // Then clear
    const result = runGsdTools(['workstream', 'set', '--clear', '--raw'], tmpDir);
    assert.ok(result.success);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.active, null);
    assert.strictEqual(data.cleared, true);
    assert.strictEqual(data.previous, 'ws-b');
  });
});

// ─── Collision Detection ────────────────────────────────────────────────────

describe('getOtherActiveWorkstreams', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    // Create 3 workstreams: alpha (active), beta (active), gamma (completed)
    for (const ws of ['alpha', 'beta', 'gamma']) {
      const wsDir = path.join(tmpDir, '.planning', 'workstreams', ws);
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'STATE.md'),
      '# State\n**Status:** In progress\n**Current Phase:** 3\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'beta', 'STATE.md'),
      '# State\n**Status:** In progress\n**Current Phase:** 5\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'gamma', 'STATE.md'),
      '# State\n**Status:** 1.0 milestone complete\n');
  });

  after(() => cleanup(tmpDir));

  test('workstream list excludes completed workstreams from active count', () => {
    const result = runGsdTools(['workstream', 'list', '--raw'], tmpDir);
    assert.ok(result.success);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.count, 3); // all listed
    const activeWs = data.workstreams.filter(w =>
      !w.status.toLowerCase().includes('milestone complete'));
    assert.strictEqual(activeWs.length, 2); // alpha and beta active
  });

  test('returns only non-complete siblings with phase progress metadata', () => {
    const alphaPlan = path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'phases', '01-alpha', 'PLAN.md');
    const betaPlan = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases', '01-beta', 'PLAN.md');
    const betaSummary = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases', '01-beta', 'SUMMARY.md');
    fs.mkdirSync(path.dirname(alphaPlan), { recursive: true });
    fs.mkdirSync(path.dirname(betaPlan), { recursive: true });
    fs.writeFileSync(alphaPlan, '# Plan\n');
    fs.writeFileSync(betaPlan, '# Plan\n');
    fs.writeFileSync(betaSummary, '# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
    // *-VERIFICATION.md is what makes beta's phase count as complete now.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases', '01-beta', '01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n# Verification\n',
    );

    const others = getOtherActiveWorkstreams(tmpDir, 'alpha');
    assert.strictEqual(others.length, 1);
    assert.strictEqual(others[0].name, 'beta');
    assert.strictEqual(others[0].phases, '1/1');
  });
});

describe('workstream progress', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    const alphaDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(path.join(alphaDir, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(alphaDir, 'STATE.md'), '# State\n**Status:** In progress\n');
    fs.writeFileSync(path.join(alphaDir, 'ROADMAP.md'), '## Roadmap\n');

    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'feature');
    fs.mkdirSync(path.join(wsDir, 'phases', '01-init'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'phases', '01-init', 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(wsDir, 'phases', '01-init', 'SUMMARY.md'), '# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
    // *-VERIFICATION.md is what makes phase 01 count as complete now.
    fs.writeFileSync(path.join(wsDir, 'phases', '01-init', '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n**Status:** In progress\n**Current Phase:** 2\n');
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), '## Roadmap\n### Phase 1: Init\n### Phase 2: Build\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'feature\n');
  });

  after(() => cleanup(tmpDir));

  test('returns progress summary in deterministic order', () => {
    const result = runGsdTools(['workstream', 'progress', '--raw'], tmpDir);
    assert.ok(result.success, `progress failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.mode, 'workstream');
    assert.strictEqual(data.count, 2);
    assert.deepStrictEqual(data.workstreams.map(w => w.name), ['feature', 'alpha']);
    assert.strictEqual(data.workstreams[0].name, 'feature');
    assert.strictEqual(data.workstreams[0].active, true);
    assert.strictEqual(data.workstreams[0].progress_percent, 50);
  });

  test('clamps progress percent when completed phase dirs exceed roadmap count', () => {
    const isolatedDir = createFixture();
    try {
      const wsDir = path.join(isolatedDir, '.planning', 'workstreams', 'overflow');
      for (const phase of ['01-one', '02-two']) {
        const phaseDir = path.join(wsDir, 'phases', phase);
        fs.mkdirSync(phaseDir, { recursive: true });
        fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), '# Plan\n');
        fs.writeFileSync(path.join(phaseDir, 'SUMMARY.md'), '# Summary\n');
        // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
        // *-VERIFICATION.md is what makes each phase count as complete now.
        fs.writeFileSync(path.join(phaseDir, `${phase.slice(0, 2)}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n');
      }
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n**Status:** In progress\n');
      fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), '# Roadmap\n### Phase 1: One\n');

      const result = runGsdTools(['workstream', 'progress', '--raw'], isolatedDir);
      assert.ok(result.success, `progress failed: ${result.error}`);
      const data = JSON.parse(result.output);
      assert.strictEqual(data.workstreams[0].progress_percent, 100);
    } finally {
      cleanup(isolatedDir);
    }
  });

  test('returns flat mode when no workstreams exist', () => {
    const emptyDir = createFixture();
    try {
      const result = runGsdTools(['workstream', 'progress', '--raw'], emptyDir);
      assert.ok(result.success, `progress in flat mode failed: ${result.error}`);
      const data = JSON.parse(result.output);
      assert.strictEqual(data.mode, 'flat');
    } finally {
      cleanup(emptyDir);
    }
  });
});

// ─── Integration: gsd-tools --ws flag ────────────────────────────────────────

describe('gsd-tools --ws flag integration', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    // Create a workstream with roadmap
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'test-ws');
    fs.mkdirSync(path.join(wsDir, 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'),
      '## Roadmap v1.0: Test\n### Phase 1: Setup\nDo setup things.\n');
    fs.writeFileSync(path.join(wsDir, 'STATE.md'),
      '---\nmilestone: v1.0\n---\n# State\n**Status:** In progress\n**Current Phase:** 1 — Setup\n');
    fs.writeFileSync(path.join(wsDir, 'phases', '01-setup', 'PLAN.md'), '# Plan\n');
  });

  after(() => cleanup(tmpDir));

  test('find-phase resolves to workstream-scoped phases via --ws', () => {
    const result = runGsdTools(['find-phase', '1', '--raw', '--ws', 'test-ws'], tmpDir);
    assert.ok(result.success, `find-phase failed: ${result.error}`);
    assert.ok(result.output.includes('workstreams/test-ws'), `path should be workstream-scoped: ${result.output}`);
  });

  test('find-phase returns JSON with workstream path when not raw', () => {
    const result = runGsdTools(['find-phase', '1', '--ws', 'test-ws'], tmpDir);
    assert.ok(result.success, `find-phase failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.ok(data.found, 'phase should be found');
    assert.ok(data.directory.includes('workstreams/test-ws'), `path should be workstream-scoped: ${data.directory}`);
  });
});

// ─── Path Traversal Rejection ────────────────────────────────────────────────

describe('path traversal rejection', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'legit');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), '# State\n');
  });

  after(() => cleanup(tmpDir));

  const maliciousNames = [
    '../../etc',
    '../foo',
    'ws/../../../passwd',
    'a/b',
    'ws name with spaces',
    '..',
    '.',
    'ws..traversal',
  ];

  describe('--ws flag rejects traversal attempts', () => {
    for (const name of maliciousNames) {
      test(`rejects --ws=${name}`, () => {
        const result = runGsdTools(['workstream', 'list', '--raw', '--ws', name], tmpDir);
        assert.ok(!result.success, `should reject --ws=${name}`);
        assert.ok(result.error.includes('Invalid workstream name'), `error should mention invalid name for: ${name}`);
      });
    }
  });

  describe('GSD_WORKSTREAM env var rejects traversal attempts', () => {
    for (const name of maliciousNames) {
      test(`rejects GSD_WORKSTREAM=${name}`, () => {
        const result = runGsdTools(['workstream', 'list', '--raw'], tmpDir, { GSD_WORKSTREAM: name });
        assert.ok(!result.success, `should reject GSD_WORKSTREAM=${name}`);
        assert.ok(result.error.includes('Invalid workstream name'), `error should mention invalid name for: ${name}`);
      });
    }
  });

  describe('cmdWorkstreamSet rejects traversal attempts', () => {
    for (const name of maliciousNames) {
      test(`rejects set ${name}`, () => {
        const result = runGsdTools(['workstream', 'set', name, '--raw'], tmpDir);
        // cmdWorkstreamSet validates the positional arg and returns invalid_name error
        assert.ok(result.success, `command should exit cleanly for: ${name}`);
        const data = JSON.parse(result.output);
        assert.strictEqual(data.error, 'invalid_name', `should return invalid_name error for: ${name}`);
        assert.strictEqual(data.active, null, `active should be null for: ${name}`);
      });
    }
  });

  describe('cmdWorkstreamStatus rejects invalid names consistently', () => {
    for (const name of maliciousNames) {
      test(`rejects status ${name}`, () => {
        const result = runGsdTools(['workstream', 'status', name, '--raw'], tmpDir);
        assert.ok(!result.success, `status should reject invalid name: ${name}`);
        assert.ok(result.error.includes('Invalid workstream name'), `error should mention invalid name for: ${name}`);
      });
    }
  });

  describe('cmdWorkstreamComplete rejects invalid names consistently', () => {
    for (const name of maliciousNames) {
      test(`rejects complete ${name}`, () => {
        const result = runGsdTools(['workstream', 'complete', name, '--raw'], tmpDir);
        assert.ok(!result.success, `complete should reject invalid name: ${name}`);
        assert.ok(result.error.includes('Invalid workstream name'), `error should mention invalid name for: ${name}`);
      });
    }
  });

  describe('getActiveWorkstream rejects poisoned active-workstream file', () => {
    for (const name of maliciousNames) {
      test(`rejects poisoned file containing ${name}`, () => {
        // Write malicious name directly to the active-workstream file
        fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), name + '\n');
        const result = runGsdTools(['workstream', 'get'], tmpDir, { GSD_WORKSTREAM: '' });
        assert.ok(result.success, 'get should succeed');
        const data = JSON.parse(result.output);
        // getActiveWorkstream should return null for invalid names
        assert.strictEqual(data.active, null, `should return null for poisoned name: ${name}`);
      });
    }

    // Cleanup: remove poisoned file
    test('cleanup: remove active-workstream file', () => {
      try { fs.unlinkSync(path.join(tmpDir, '.planning', 'active-workstream')); } catch {}
    });
  });

  describe('setActiveWorkstream rejects invalid names directly', () => {
    const { setActiveWorkstream } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    for (const name of maliciousNames) {
      test(`throws for ${name}`, () => {
        assert.throws(
          () => setActiveWorkstream(tmpDir, name),
          { message: /Invalid workstream name/ },
          `should throw for: ${name}`
        );
      });
    }
  });
});

// #2562: the inventory can refuse a shipped marker its artifacts contradict, but
// a refusal that no command projects is the same silent collapse the issue is
// about — the operator sees a fallback `status` and nothing saying a marker was
// seen and rejected. These assert at the CLI, the surface that was missing it,
// not at the builder that already had the field.
describe('#2562 — a refused shipped marker reaches every workstream command', () => {
  let tmpDir;

  before(() => {
    tmpDir = createFixture();
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'dirty-archive');
    // A milestone that was archived (snapshot present) and then reopened: phase 1
    // is complete and still on disk, phase 2 is declared with no directory. The
    // archive is therefore not clean AND the ratio is short.
    fs.mkdirSync(path.join(wsDir, 'phases', '1-foo'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'phases', '1-foo', '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(wsDir, 'phases', '1-foo', '01-SUMMARY.md'), '# Summary\n');
    // Disk-strict completion (ADR-3180 §7.4, #3186): a passing
    // *-VERIFICATION.md is what makes phase 1 count as complete now.
    fs.writeFileSync(path.join(wsDir, 'phases', '1-foo', '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
      '# Roadmap', '', '## Milestone v2.0 — Two', '', '## Progress', '',
      '| Phase | Milestone | Plans | Status | Done |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Foo | v2.0 | 1/1 | Complete | - |',
      '| 2. Bar | v2.0 | 0/1 | Not started | - |', '',
    ].join('\n'));
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v2.0-ROADMAP.md'), '# v2.0 archived\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'dirty-archive\n');
  });

  after(() => cleanup(tmpDir));

  test('workstream progress projects the refusal beside the percentage', () => {
    const result = runGsdTools(['workstream', 'progress', '--raw'], tmpDir);
    assert.ok(result.success, `progress failed: ${result.error}`);
    const ws = JSON.parse(result.output).workstreams.find(w => w.name === 'dirty-archive');
    assert.ok(ws, 'workstream missing from progress output');
    assert.strictEqual(ws.milestone_shipped_unverified, true);
    assert.notStrictEqual(ws.status, 'milestone complete', 'status must not contradict the percentage');
    assert.strictEqual(ws.progress_percent, 50);
  });

  test('workstream status projects the refusal', () => {
    const result = runGsdTools(['workstream', 'status', 'dirty-archive', '--raw'], tmpDir);
    assert.ok(result.success, `status failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.found, true);
    assert.strictEqual(data.milestone_shipped_unverified, true);
  });

  test('workstream list projects the refusal', () => {
    const result = runGsdTools(['workstream', 'list', '--raw'], tmpDir);
    assert.ok(result.success, `list failed: ${result.error}`);
    const ws = JSON.parse(result.output).workstreams.find(w => w.name === 'dirty-archive');
    assert.ok(ws, 'workstream missing from list output');
    assert.strictEqual(ws.milestone_shipped_unverified, true);
  });

  test('a clean archive reports no refusal at the CLI', () => {
    const isolatedDir = createFixture();
    try {
      const wsDir = path.join(isolatedDir, '.planning', 'workstreams', 'clean-archive');
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true }); // dirs moved out by the archive
      fs.writeFileSync(path.join(wsDir, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
      fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), [
        '# Roadmap', '', '## Milestone v2.0 — Two', '', '## Progress', '',
        '| Phase | Milestone | Plans | Status | Done |',
        '| --- | --- | --- | --- | --- |',
        '| 1. Foo | v2.0 | 1/1 | Complete | - |',
        '| 2. Bar | v2.0 | 1/1 | Complete | - |', '',
      ].join('\n'));
      fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'milestones', 'v2.0-ROADMAP.md'), '# v2.0 archived\n');

      const result = runGsdTools(['workstream', 'progress', '--raw'], isolatedDir);
      assert.ok(result.success, `progress failed: ${result.error}`);
      const ws = JSON.parse(result.output).workstreams.find(w => w.name === 'clean-archive');
      assert.ok(ws, 'workstream missing from progress output');
      assert.strictEqual(ws.milestone_shipped_unverified, false);
      assert.strictEqual(ws.status, 'milestone complete');
    } finally {
      cleanup(isolatedDir);
    }
  });
});

// ─── #4772: `none` is reserved (CLI end to end) ─────────────────────────────
describe('regressions: reserved workstream name none (#4772)', () => {
  const { RESERVED_WORKSTREAM_NAMES } = require('../gsd-core/bin/lib/workstream-name-policy.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    seedWorkstream(tmpDir, { name: 'alpha', state: '# State\n' });
  });

  afterEach(() => cleanup(tmpDir));

  const wsDirOf = (name) => path.join(tmpDir, '.planning', 'workstreams', name);

  test('query init.quick --ws none fails loudly and creates no workstreams/none', () => {
    const r = runGsdTools(['query', 'init.quick', 'a task', '--ws', 'none'], tmpDir);
    assert.equal(r.success, false);
    assert.match(r.error, /Workstream name 'none' is reserved/);
    assert.equal(fs.existsSync(wsDirOf('none')), false);
  });

  test('--ws=none and GSD_WORKSTREAM=none are rejected the same way', () => {
    const viaEquals = runGsdTools(['query', 'init.quick', 'a task', '--ws=none'], tmpDir);
    assert.equal(viaEquals.success, false);
    assert.match(viaEquals.error, /is reserved/);
    const viaEnv = runGsdTools(['query', 'init.quick', 'a task'], tmpDir, { GSD_WORKSTREAM: 'none' });
    assert.equal(viaEnv.success, false);
    assert.match(viaEnv.error, /is reserved/);
    assert.equal(fs.existsSync(wsDirOf('none')), false);
  });

  test('agent-skills --ws none errors instead of leaking the root config', () => {
    const r = runGsdTools(['query', 'agent-skills', 'gsd-planner', '--ws', 'none'], tmpDir);
    assert.equal(r.success, false);
    assert.match(r.error, /is reserved/);
  });

  test('workstream create none is rejected and writes nothing', () => {
    const r = runGsdTools(['workstream', 'create', 'none'], tmpDir);
    assert.equal(r.success, false);
    assert.match(r.error, /is reserved/);
    assert.equal(fs.existsSync(wsDirOf('none')), false);
  });

  test('workstream set none reports invalid_name with the reserved message and leaves the pointer alone', () => {
    const r = runGsdTools(['workstream', 'set', 'none'], tmpDir);
    const out = JSON.parse(r.output);
    assert.equal(out.error, 'invalid_name');
    assert.match(out.message, /is reserved/);
    assert.equal(out.active, null);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'active-workstream')), false);
  });

  test('a stale GSD_WORKSTREAM=none names the env var as the remedy', () => {
    const r = runGsdTools(['query', 'agent-skills', 'gsd-planner'], tmpDir, { GSD_WORKSTREAM: 'none' });
    assert.equal(r.success, false);
    assert.match(r.error, /unset GSD_WORKSTREAM/);
  });

  test('a stale none pointer file with no directory does not brick the CLI', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'none\n');
    const r = runGsdTools(['workstream', 'get'], tmpDir);
    assert.equal(r.success, true, r.error);
    assert.equal(JSON.parse(r.output).active, null);
  });

  test('workstream create --migrate-name none is reports migration_failed in flat mode without moving files', () => {
    const flat = createFixture();
    try {
      fs.writeFileSync(path.join(flat, '.planning', 'ROADMAP.md'), '# Roadmap\n');
      const r = runGsdTools(['workstream', 'create', 'alpha2', '--migrate-name', 'none'], flat);
      const out = JSON.parse(r.output);
      assert.equal(out.created, false);
      assert.equal(out.error, 'migration_failed');
      assert.match(out.message, /is reserved/);
      assert.equal(fs.existsSync(path.join(flat, '.planning', 'ROADMAP.md')), true);
      assert.equal(fs.existsSync(path.join(flat, '.planning', 'workstreams', 'none')), false);
    } finally {
      cleanup(flat);
    }
  });

  test('near-misses still work end to end', () => {
    seedWorkstream(tmpDir, { name: 'none1', state: '# State\n' });
    const r = runGsdTools(['query', 'agent-skills', 'gsd-planner', '--ws', 'none1'], tmpDir);
    assert.equal(r.success, true, r.error);
  });

  test('parity: every reserved name is rejected by create and by --ws from the one exported list', () => {
    assert.ok(RESERVED_WORKSTREAM_NAMES.length > 0);
    for (const name of RESERVED_WORKSTREAM_NAMES) {
      const create = runGsdTools(['workstream', 'create', name], tmpDir);
      assert.equal(create.success, false, 'create ' + name);
      const flag = runGsdTools(['query', 'agent-skills', 'gsd-planner', '--ws', name], tmpDir);
      assert.equal(flag.success, false, '--ws ' + name);
      assert.equal(fs.existsSync(wsDirOf(name)), false, name);
    }
  });
});

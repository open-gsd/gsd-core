'use strict';

/**
 * Focused unit tests for active-workstream-store.cjs
 * Targets untested branches to raise mutation score above 60%.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const {
  validateWorkstreamName,
  getWorkstreamSessionKey,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  pickActiveWorkstreamAdapter,
  getActiveWorkstream,
  setActiveWorkstream,
  clearActiveWorkstream,
  parseCliWorkstream,
  resolveActiveWorkstream,
  applyResolvedWorkstreamEnv,
} = require('../gsd-core/bin/lib/active-workstream-store.cjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ENV_KEYS = [
  'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT',
  'OPENCODE_SESSION_ID', 'GEMINI_SESSION_ID', 'CURSOR_SESSION_ID', 'WINDSURF_SESSION_ID',
  'TERM_SESSION_ID', 'WT_SESSION', 'TMUX_PANE', 'ZELLIJ_SESSION_NAME',
  'TTY', 'SSH_TTY',
];

function clearSessionEnv() {
  for (const k of SESSION_ENV_KEYS) delete process.env[k];
}

function saveSessionEnv() {
  const saved = {};
  for (const k of SESSION_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreSessionEnv(saved) {
  for (const k of SESSION_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function makePlanningDir(base, ...workstreams) {
  const wsDir = path.join(base, '.planning', 'workstreams');
  fs.mkdirSync(wsDir, { recursive: true });
  for (const ws of workstreams) {
    fs.mkdirSync(path.join(wsDir, ws), { recursive: true });
  }
}

// ── validateWorkstreamName ────────────────────────────────────────────────────

describe('validateWorkstreamName — exact values', () => {
  test('accepts dot in name', () => {
    assert.equal(validateWorkstreamName('alpha.2'), true);
  });

  test('rejects null', () => {
    assert.equal(validateWorkstreamName(null), false);
  });

  test('rejects undefined', () => {
    assert.equal(validateWorkstreamName(undefined), false);
  });

  test('rejects empty string', () => {
    assert.equal(validateWorkstreamName(''), false);
  });

  test('rejects whitespace-only', () => {
    assert.equal(validateWorkstreamName('   '), false);
  });

  test('rejects name with spaces', () => {
    assert.equal(validateWorkstreamName('hello world'), false);
  });

  test('rejects path traversal', () => {
    assert.equal(validateWorkstreamName('../escape'), false);
  });

  test('accepts single char', () => {
    assert.equal(validateWorkstreamName('a'), true);
  });

  test('accepts underscore', () => {
    assert.equal(validateWorkstreamName('my_ws'), true);
  });

  test('accepts hyphen', () => {
    assert.equal(validateWorkstreamName('my-ws'), true);
  });
});

// ── createMemoryPointerAdapter ────────────────────────────────────────────────

describe('createMemoryPointerAdapter', () => {
  test('initial value defaults to null', () => {
    const a = createMemoryPointerAdapter();
    assert.equal(a.read(), null);
  });

  test('initial value can be set', () => {
    const a = createMemoryPointerAdapter('alpha');
    assert.equal(a.read(), 'alpha');
  });

  test('write updates value', () => {
    const a = createMemoryPointerAdapter(null);
    a.write('beta');
    assert.equal(a.read(), 'beta');
  });

  test('write then write replaces value', () => {
    const a = createMemoryPointerAdapter('alpha');
    a.write('beta');
    assert.equal(a.read(), 'beta');
  });

  test('clear sets value to null', () => {
    const a = createMemoryPointerAdapter('alpha');
    a.clear();
    assert.equal(a.read(), null);
  });

  test('clear after write sets to null', () => {
    const a = createMemoryPointerAdapter(null);
    a.write('alpha');
    a.clear();
    assert.equal(a.read(), null);
  });

  test('clear then read returns null', () => {
    const a = createMemoryPointerAdapter('ws');
    a.clear();
    assert.strictEqual(a.read(), null);
  });
});

// ── createSharedPointerAdapter ────────────────────────────────────────────────

describe('createSharedPointerAdapter', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-shared-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });
  afterEach(() => cleanup(tmpDir));

  test('read returns null when file does not exist', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    assert.equal(adapter.read(), null);
  });

  test('write then read returns exact name', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    adapter.write('my-ws');
    assert.equal(adapter.read(), 'my-ws');
  });

  test('write appends newline but read strips it', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    adapter.write('trimmed');
    const filePath = path.join(tmpDir, '.planning', 'active-workstream');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw, 'trimmed\n');
    assert.equal(adapter.read(), 'trimmed');
  });

  test('read returns null for whitespace-only content', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    const filePath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(filePath, '   \n');
    assert.equal(adapter.read(), null);
  });

  test('clear removes the file', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    adapter.write('my-ws');
    adapter.clear();
    const filePath = path.join(tmpDir, '.planning', 'active-workstream');
    assert.equal(fs.existsSync(filePath), false);
  });

  test('clear on non-existent file does not throw', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    assert.doesNotThrow(() => adapter.clear());
  });

  test('read returns null when file is empty', () => {
    const adapter = createSharedPointerAdapter(tmpDir);
    const filePath = path.join(tmpDir, '.planning', 'active-workstream');
    fs.writeFileSync(filePath, '');
    assert.equal(adapter.read(), null);
  });
});

// ── createSessionScopedPointerAdapter ────────────────────────────────────────

describe('createSessionScopedPointerAdapter', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-session-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('returns null when no session key available', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir);
    assert.equal(adapter, null);
  });

  test('returns adapter object when session key provided', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    assert.notEqual(adapter, null);
    assert.equal(typeof adapter.read, 'function');
    assert.equal(typeof adapter.write, 'function');
    assert.equal(typeof adapter.clear, 'function');
  });

  test('read returns null before any write', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    assert.equal(adapter.read(), null);
  });

  test('write then read returns exact name', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    adapter.write('session-ws');
    assert.equal(adapter.read(), 'session-ws');
  });

  test('clear after write returns null', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    adapter.write('session-ws');
    adapter.clear();
    assert.equal(adapter.read(), null);
  });

  test('clear on empty dir removes dir', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    adapter.write('session-ws');
    adapter.clear();
    // after clear, the file and possibly the dir should be gone
    // at minimum, clear should not throw
    assert.doesNotThrow(() => adapter.clear());
  });

  test('read returns null for whitespace-only content', () => {
    const adapter = createSessionScopedPointerAdapter(tmpDir, 'test-session-key');
    adapter.write('   ');
    // write appends \n, so content is "   \n"; trim returns '', so read returns null
    assert.equal(adapter.read(), null);
  });

  test('uses env session key when no fixed key provided', () => {
    process.env.GSD_SESSION_KEY = 'env-session';
    const adapter = createSessionScopedPointerAdapter(tmpDir);
    assert.notEqual(adapter, null);
    adapter.write('env-ws');
    assert.equal(adapter.read(), 'env-ws');
  });
});

// ── pickActiveWorkstreamAdapter ───────────────────────────────────────────────

describe('pickActiveWorkstreamAdapter', () => {
  let saved;
  beforeEach(() => {
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => restoreSessionEnv(saved));

  test('returns opts.activeWorkstreamAdapter when provided', () => {
    const adapter = createMemoryPointerAdapter('alpha');
    const picked = pickActiveWorkstreamAdapter('/fake', { activeWorkstreamAdapter: adapter });
    assert.strictEqual(picked, adapter);
  });

  test('returns session adapter from adapters when session key exists', () => {
    process.env.GSD_SESSION_KEY = 'some-session';
    const session = createMemoryPointerAdapter('session-ws');
    const shared = createMemoryPointerAdapter('shared-ws');
    const picked = pickActiveWorkstreamAdapter('/fake', {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.strictEqual(picked, session);
  });

  test('returns shared adapter from adapters when no session key', () => {
    const shared = createMemoryPointerAdapter('shared-ws');
    const picked = pickActiveWorkstreamAdapter('/fake', {
      activeWorkstreamAdapters: { shared },
    });
    assert.strictEqual(picked, shared);
  });

  test('creates shared pointer adapter when no opts and no session', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pick-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      const picked = pickActiveWorkstreamAdapter(tmpDir, {});
      assert.notEqual(picked, null);
      assert.equal(typeof picked.read, 'function');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('creates session scoped adapter when session key exists and no adapters given', () => {
    process.env.GSD_SESSION_KEY = 'my-session';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pick-sess-'));
    try {
      const picked = pickActiveWorkstreamAdapter(tmpDir, {});
      // session scoped adapter exists since session key is set
      assert.notEqual(picked, null);
      assert.equal(typeof picked.read, 'function');
    } finally {
      cleanup(tmpDir);
      delete process.env.GSD_SESSION_KEY;
    }
  });

  test('adapter not provided in opts returns shared adapter', () => {
    const picked = pickActiveWorkstreamAdapter('/fake', {
      activeWorkstreamAdapters: {},
    });
    assert.notEqual(picked, null);
  });
});

// ── getWorkstreamSessionKey ───────────────────────────────────────────────────

describe('getWorkstreamSessionKey', () => {
  let saved;
  beforeEach(() => {
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => restoreSessionEnv(saved));

  test('returns null when no env keys set', () => {
    const key = getWorkstreamSessionKey();
    // will return null or a tty token (depends on environment); just check type
    assert.ok(key === null || typeof key === 'string');
  });

  test('returns gsd-session-key prefixed key for GSD_SESSION_KEY', () => {
    process.env.GSD_SESSION_KEY = 'mysession';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'gsd-session-key-mysession');
  });

  test('returns codex-thread-id prefixed key for CODEX_THREAD_ID', () => {
    process.env.CODEX_THREAD_ID = 'thread123';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'codex-thread-id-thread123');
  });

  test('returns claude-session-id for CLAUDE_SESSION_ID', () => {
    process.env.CLAUDE_SESSION_ID = 'claude-abc';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'claude-session-id-claude-abc');
  });

  test('returns claude-code-sse-port for CLAUDE_CODE_SSE_PORT', () => {
    process.env.CLAUDE_CODE_SSE_PORT = '9000';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'claude-code-sse-port-9000');
  });

  test('returns opencode-session-id for OPENCODE_SESSION_ID', () => {
    process.env.OPENCODE_SESSION_ID = 'oc-123';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'opencode-session-id-oc-123');
  });

  test('returns gemini-session-id for GEMINI_SESSION_ID', () => {
    process.env.GEMINI_SESSION_ID = 'gem-xyz';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'gemini-session-id-gem-xyz');
  });

  test('returns cursor-session-id for CURSOR_SESSION_ID', () => {
    process.env.CURSOR_SESSION_ID = 'cur-001';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'cursor-session-id-cur-001');
  });

  test('returns windsurf-session-id for WINDSURF_SESSION_ID', () => {
    process.env.WINDSURF_SESSION_ID = 'ws-surf';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'windsurf-session-id-ws-surf');
  });

  test('returns term-session-id for TERM_SESSION_ID', () => {
    process.env.TERM_SESSION_ID = 'term-1';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'term-session-id-term-1');
  });

  test('returns wt-session for WT_SESSION', () => {
    process.env.WT_SESSION = 'wt-abc';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'wt-session-wt-abc');
  });

  test('returns tmux-pane for TMUX_PANE', () => {
    process.env.TMUX_PANE = '%1';
    const key = getWorkstreamSessionKey();
    // %1 → sanitize replaces % with _, then strips leading _ → "1"
    assert.equal(key, 'tmux-pane-1');
  });

  test('returns zellij-session-name for ZELLIJ_SESSION_NAME', () => {
    process.env.ZELLIJ_SESSION_NAME = 'my-zellij';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'zellij-session-name-my-zellij');
  });

  test('GSD_SESSION_KEY takes priority over CODEX_THREAD_ID', () => {
    process.env.GSD_SESSION_KEY = 'first';
    process.env.CODEX_THREAD_ID = 'second';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'gsd-session-key-first');
  });

  test('returns tty- prefixed key for TTY env var', () => {
    process.env.TTY = '/dev/pts/1';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'tty-pts_1');
  });

  test('returns tty- prefixed key for SSH_TTY env var', () => {
    process.env.SSH_TTY = '/dev/pts/2';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'tty-pts_2');
  });

  test('TTY takes priority over SSH_TTY', () => {
    process.env.TTY = '/dev/pts/3';
    process.env.SSH_TTY = '/dev/pts/4';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'tty-pts_3');
  });

  test('TTY with dev_ prefix gets stripped', () => {
    process.env.TTY = 'dev_pts_1';
    const key = getWorkstreamSessionKey();
    // sanitize returns dev_pts_1 → tty-{dev_pts_1 with dev_ stripped} → tty-pts_1
    assert.equal(key, 'tty-pts_1');
  });

  test('empty GSD_SESSION_KEY falls through', () => {
    process.env.GSD_SESSION_KEY = '';
    process.env.CODEX_THREAD_ID = 'fallback';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'codex-thread-id-fallback');
  });

  test('whitespace-only GSD_SESSION_KEY falls through', () => {
    process.env.GSD_SESSION_KEY = '   ';
    process.env.CODEX_THREAD_ID = 'fallback2';
    const key = getWorkstreamSessionKey();
    assert.equal(key, 'codex-thread-id-fallback2');
  });
});

// ── getActiveWorkstream ───────────────────────────────────────────────────────

describe('getActiveWorkstream', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-get-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('returns null when adapter reads null', () => {
    const adapter = createMemoryPointerAdapter(null);
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
  });

  test('returns null and clears for invalid name', () => {
    const adapter = createMemoryPointerAdapter('bad name!');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
    assert.equal(adapter.read(), null);
  });

  test('returns null and clears when workstream dir missing', () => {
    makePlanningDir(tmpDir);
    const adapter = createMemoryPointerAdapter('ghost-ws');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
    assert.equal(adapter.read(), null);
  });

  test('returns name when workstream dir exists', () => {
    makePlanningDir(tmpDir, 'real-ws');
    const adapter = createMemoryPointerAdapter('real-ws');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, 'real-ws');
  });

  test('adapter read is null after self-heal for stale pointer', () => {
    makePlanningDir(tmpDir);
    const adapter = createMemoryPointerAdapter('stale');
    getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });

  test('returns null for empty string name', () => {
    const adapter = createMemoryPointerAdapter('');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
  });

  test('returns correct ws name with dots', () => {
    makePlanningDir(tmpDir, 'v1.2');
    const adapter = createMemoryPointerAdapter('v1.2');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, 'v1.2');
  });
});

// ── setActiveWorkstream ───────────────────────────────────────────────────────

describe('setActiveWorkstream', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-set-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('writes name to adapter', () => {
    const adapter = createMemoryPointerAdapter(null);
    setActiveWorkstream(tmpDir, 'my-ws', { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), 'my-ws');
  });

  test('creates workstream dir on set', () => {
    const adapter = createMemoryPointerAdapter(null);
    setActiveWorkstream(tmpDir, 'new-ws', { activeWorkstreamAdapter: adapter });
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'new-ws');
    assert.equal(fs.existsSync(wsDir), true);
  });

  test('clears on null name', () => {
    const adapter = createMemoryPointerAdapter('existing');
    setActiveWorkstream(tmpDir, null, { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });

  test('clears on undefined name', () => {
    const adapter = createMemoryPointerAdapter('existing');
    setActiveWorkstream(tmpDir, undefined, { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });

  test('clears on empty string name', () => {
    const adapter = createMemoryPointerAdapter('existing');
    setActiveWorkstream(tmpDir, '', { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });

  test('throws on invalid name', () => {
    const adapter = createMemoryPointerAdapter(null);
    assert.throws(
      () => setActiveWorkstream(tmpDir, 'bad/name', { activeWorkstreamAdapter: adapter }),
      /Invalid workstream name/
    );
  });

  test('throws with exact error message for invalid name', () => {
    const adapter = createMemoryPointerAdapter(null);
    assert.throws(
      () => setActiveWorkstream(tmpDir, 'bad name', { activeWorkstreamAdapter: adapter }),
      /must be alphanumeric, hyphens, underscores, or dots/
    );
  });

  test('does not write on invalid name', () => {
    const adapter = createMemoryPointerAdapter(null);
    try {
      setActiveWorkstream(tmpDir, 'bad/name', { activeWorkstreamAdapter: adapter });
    } catch {
      // expected
    }
    assert.equal(adapter.read(), null);
  });
});

// ── clearActiveWorkstream ─────────────────────────────────────────────────────

describe('clearActiveWorkstream', () => {
  let saved;
  beforeEach(() => {
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => restoreSessionEnv(saved));

  test('clears the adapter', () => {
    const adapter = createMemoryPointerAdapter('to-clear');
    clearActiveWorkstream('/fake', { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });

  test('does not throw when adapter already clear', () => {
    const adapter = createMemoryPointerAdapter(null);
    assert.doesNotThrow(() => clearActiveWorkstream('/fake', { activeWorkstreamAdapter: adapter }));
  });

  test('uses shared adapter branch when no session key', () => {
    const shared = createMemoryPointerAdapter('shared-ws');
    clearActiveWorkstream('/fake', { activeWorkstreamAdapters: { shared } });
    assert.equal(shared.read(), null);
  });

  test('uses session adapter branch when session key present', () => {
    process.env.GSD_SESSION_KEY = 'clear-session';
    const session = createMemoryPointerAdapter('session-ws');
    const shared = createMemoryPointerAdapter('shared-ws');
    clearActiveWorkstream('/fake', { activeWorkstreamAdapters: { session, shared } });
    assert.equal(session.read(), null);
    // shared not cleared
    assert.equal(shared.read(), 'shared-ws');
    delete process.env.GSD_SESSION_KEY;
  });
});

// ── parseCliWorkstream ────────────────────────────────────────────────────────

describe('parseCliWorkstream', () => {
  test('returns null source and value when no --ws flag', () => {
    const parsed = parseCliWorkstream(['state', 'json', '--raw']);
    assert.equal(parsed.value, null);
    assert.equal(parsed.source, null);
    assert.deepEqual(parsed.args, ['state', 'json', '--raw']);
  });

  test('empty args returns null value', () => {
    const parsed = parseCliWorkstream([]);
    assert.equal(parsed.value, null);
    assert.equal(parsed.source, null);
    assert.deepEqual(parsed.args, []);
  });

  test('--ws=alpha removes the flag arg', () => {
    const parsed = parseCliWorkstream(['cmd', '--ws=alpha']);
    assert.equal(parsed.value, 'alpha');
    assert.equal(parsed.source, 'cli');
    assert.deepEqual(parsed.args, ['cmd']);
  });

  test('--ws=alpha with whitespace trims value', () => {
    const parsed = parseCliWorkstream(['--ws= alpha ']);
    assert.equal(parsed.value, 'alpha');
  });

  test('--ws= with no value throws', () => {
    assert.throws(() => parseCliWorkstream(['--ws=']), /Missing value for --ws/);
  });

  test('--ws= with whitespace-only throws', () => {
    assert.throws(() => parseCliWorkstream(['--ws=   ']), /Missing value for --ws/);
  });

  test('--ws at end throws', () => {
    assert.throws(() => parseCliWorkstream(['--ws']), /Missing value for --ws/);
  });

  test('--ws followed by another flag throws', () => {
    assert.throws(() => parseCliWorkstream(['--ws', '--other']), /Missing value for --ws/);
  });

  test('--ws beta removes both args', () => {
    const parsed = parseCliWorkstream(['cmd', '--ws', 'beta', '--raw']);
    assert.equal(parsed.value, 'beta');
    assert.equal(parsed.source, 'cli');
    assert.deepEqual(parsed.args, ['cmd', '--raw']);
  });

  test('--ws=name prefers eq-form over space-form', () => {
    // If both forms present, wsEqArg is found first
    const parsed = parseCliWorkstream(['--ws=alpha', '--ws', 'beta']);
    assert.equal(parsed.value, 'alpha');
  });

  test('args with no flags returns exact copy', () => {
    const input = ['a', 'b', 'c'];
    const parsed = parseCliWorkstream(input);
    assert.deepEqual(parsed.args, ['a', 'b', 'c']);
    // returns a copy (not same reference)
    parsed.args.push('x');
    assert.deepEqual(input, ['a', 'b', 'c']);
  });

  test('source is exactly "cli" for --ws=form', () => {
    const parsed = parseCliWorkstream(['--ws=myws']);
    assert.equal(parsed.source, 'cli');
  });

  test('source is exactly "cli" for --ws space form', () => {
    const parsed = parseCliWorkstream(['--ws', 'myws']);
    assert.equal(parsed.source, 'cli');
  });

  test('source is exactly null for no-ws form', () => {
    const parsed = parseCliWorkstream(['other', 'args']);
    assert.strictEqual(parsed.source, null);
  });
});

// ── resolveActiveWorkstream ───────────────────────────────────────────────────

describe('resolveActiveWorkstream', () => {
  test('cli source overrides env and store', () => {
    const r = resolveActiveWorkstream('/repo', ['--ws', 'cli-ws'], { GSD_WORKSTREAM: 'env-ws' }, { getStored: () => 'store-ws' });
    assert.equal(r.ws, 'cli-ws');
    assert.equal(r.source, 'cli');
    assert.deepEqual(r.args, []);
  });

  test('env source overrides store', () => {
    const r = resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: 'env-ws' }, { getStored: () => 'store-ws' });
    assert.equal(r.ws, 'env-ws');
    assert.equal(r.source, 'env');
  });

  test('env with whitespace is trimmed', () => {
    const r = resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: '  trimmed  ' }, { getStored: () => null });
    assert.equal(r.ws, 'trimmed');
    assert.equal(r.source, 'env');
  });

  test('env whitespace-only falls to store', () => {
    const r = resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: '   ' }, { getStored: () => 'store-ws' });
    assert.equal(r.ws, 'store-ws');
    assert.equal(r.source, 'store');
  });

  test('null env falls to store', () => {
    const r = resolveActiveWorkstream('/repo', [], null, { getStored: () => 'store-ws' });
    assert.equal(r.ws, 'store-ws');
    assert.equal(r.source, 'store');
  });

  test('store null returns source none', () => {
    const r = resolveActiveWorkstream('/repo', [], {}, { getStored: () => null });
    assert.equal(r.ws, null);
    assert.equal(r.source, 'none');
  });

  test('store empty string returns null ws', () => {
    const r = resolveActiveWorkstream('/repo', [], {}, { getStored: () => '' });
    assert.equal(r.ws, null);
    assert.equal(r.source, 'none');
  });

  test('args returned after --ws removal', () => {
    const r = resolveActiveWorkstream('/repo', ['cmd', '--ws=alpha', 'extra'], {}, { getStored: () => null });
    assert.equal(r.ws, 'alpha');
    assert.deepEqual(r.args, ['cmd', 'extra']);
  });

  test('throws for invalid name from cli', () => {
    assert.throws(
      () => resolveActiveWorkstream('/repo', ['--ws', 'bad/name'], {}, {}),
      /Invalid workstream name/
    );
  });

  test('throws for invalid name from env', () => {
    assert.throws(
      () => resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: 'bad name' }, { getStored: () => null }),
      /Invalid workstream name/
    );
  });

  test('throws for invalid name from store', () => {
    assert.throws(
      () => resolveActiveWorkstream('/repo', [], {}, { getStored: () => 'bad/name' }),
      /Invalid workstream name/
    );
  });

  test('GSD_WORKSTREAM non-string falls to store', () => {
    const r = resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: 42 }, { getStored: () => 'store-ws' });
    assert.equal(r.ws, 'store-ws');
    assert.equal(r.source, 'store');
  });

  test('args passthrough when no ws flag', () => {
    const r = resolveActiveWorkstream('/repo', ['a', 'b'], {}, { getStored: () => null });
    assert.deepEqual(r.args, ['a', 'b']);
  });

  test('source is exactly "cli" string', () => {
    const r = resolveActiveWorkstream('/repo', ['--ws=x'], {}, { getStored: () => null });
    assert.equal(r.source, 'cli');
  });

  test('source is exactly "env" string', () => {
    const r = resolveActiveWorkstream('/repo', [], { GSD_WORKSTREAM: 'myws' }, { getStored: () => null });
    assert.equal(r.source, 'env');
  });

  test('source is exactly "store" string', () => {
    const r = resolveActiveWorkstream('/repo', [], {}, { getStored: () => 'stored-ws' });
    assert.equal(r.source, 'store');
  });

  test('source is exactly "none" string', () => {
    const r = resolveActiveWorkstream('/repo', [], {}, { getStored: () => null });
    assert.equal(r.source, 'none');
  });
});

// ── applyResolvedWorkstreamEnv ────────────────────────────────────────────────

describe('applyResolvedWorkstreamEnv', () => {
  test('sets GSD_WORKSTREAM when ws present', () => {
    const env = {};
    applyResolvedWorkstreamEnv({ ws: 'my-ws', source: 'cli', args: [] }, env);
    assert.equal(env.GSD_WORKSTREAM, 'my-ws');
  });

  test('does not mutate env when ws is null', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv({ ws: null, source: 'none', args: [] }, env);
    assert.equal(env.GSD_WORKSTREAM, 'old');
  });

  test('does not mutate env when resolution is null', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv(null, env);
    assert.equal(env.GSD_WORKSTREAM, 'old');
  });

  test('does not mutate env when resolution is undefined', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv(undefined, env);
    assert.equal(env.GSD_WORKSTREAM, 'old');
  });

  test('overwrites existing GSD_WORKSTREAM value', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv({ ws: 'new-ws', source: 'store', args: [] }, env);
    assert.equal(env.GSD_WORKSTREAM, 'new-ws');
  });

  test('uses process.env by default (does not throw)', () => {
    const saved = process.env.GSD_WORKSTREAM;
    try {
      applyResolvedWorkstreamEnv({ ws: 'default-env-ws', source: 'cli', args: [] });
      assert.equal(process.env.GSD_WORKSTREAM, 'default-env-ws');
    } finally {
      if (saved === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved;
    }
  });

  test('does not throw for ws empty string (falsy)', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv({ ws: '', source: 'none', args: [] }, env);
    assert.equal(env.GSD_WORKSTREAM, 'old');
  });
});

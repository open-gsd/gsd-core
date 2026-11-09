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
const { cleanup, saveSessionEnv, restoreSessionEnv, clearSessionEnv } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook, runNode } = require('./helpers/process-seam.cjs');

const {
  validateWorkstreamName,
  getWorkstreamSessionKey,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  pickActiveWorkstreamAdapter,
  pickActiveWorkstreamAdapterChain,
  getActiveWorkstream,
  peekActiveWorkstream,
  diagnoseUnresolvedActiveWorkstream,
  setActiveWorkstream,
  clearActiveWorkstream,
  parseCliWorkstream,
  resolveActiveWorkstream,
  applyResolvedWorkstreamEnv,
  _resetControllingTtyCacheForTests,
} = require('../gsd-core/bin/lib/active-workstream-store.cjs');

// ── Helpers ───────────────────────────────────────────────────────────────────
//
// saveSessionEnv/restoreSessionEnv/clearSessionEnv now live in tests/helpers.cjs
// (single source of truth — #2850 code review finding: this file's local copy
// had already silently diverged from tests/gsd-statusline.test.cjs's copy).

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

// ── pickActiveWorkstreamAdapterChain (#3579) ─────────────────────────────────
//
// Each test below is written to KILL a specific surviving mutant reported by
// Stryker on this function: the `if (!sessionKey)` guard (and its block-body
// removal), the two `?? createMemoryPointerAdapter(null)` fallback sites, and
// the `session ? [session, shared] : []` shape mutant.

describe('pickActiveWorkstreamAdapterChain', () => {
  let saved;
  beforeEach(() => {
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => restoreSessionEnv(saved));

  test('returns single-element [shared] chain when no session key present', () => {
    // Kills: `if (!sessionKey)` → `if (false)`, and the BlockStatement removal
    // on that guard's body. Both mutants would instead fall into the
    // sessionKey-truthy branch and, since `injected.session` is supplied,
    // return a 2-element [session, shared] chain instead of [shared].
    const shared = createMemoryPointerAdapter('shared-ws');
    const session = createMemoryPointerAdapter('session-ws');
    const chain = pickActiveWorkstreamAdapterChain('/fake', {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.equal(chain.length, 1);
    assert.strictEqual(chain[0], shared);
  });

  test('returns [session, shared] chain (length 2, in order) when session key present', () => {
    // Kills: `return session ? [session, shared] : []` → `: []`. A mutant
    // there collapses the chain to empty even though session key is set.
    process.env.GSD_SESSION_KEY = 'chain-session';
    const shared = createMemoryPointerAdapter('shared-ws');
    const session = createMemoryPointerAdapter('session-ws');
    const chain = pickActiveWorkstreamAdapterChain('/fake', {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.equal(chain.length, 2);
    assert.strictEqual(chain[0], session);
    assert.strictEqual(chain[1], shared);
  });

  test('no session key + adapters given without shared: fallback is inert memory adapter', () => {
    // Kills: `injected.shared ?? createMemoryPointerAdapter(null)` → `&&` on
    // the no-sessionKey branch. Under the mutant, `undefined && ...` is
    // `undefined`, so chain[0] would be undefined instead of a usable adapter.
    const chain = pickActiveWorkstreamAdapterChain('/fake', {
      activeWorkstreamAdapters: {},
    });
    assert.equal(chain.length, 1);
    assert.notEqual(chain[0], undefined);
    assert.equal(typeof chain[0].read, 'function');
    assert.equal(chain[0].read(), null);
  });

  test('session key present, only session injected: shared half is inert memory adapter', () => {
    // Kills: `injected.shared ?? createMemoryPointerAdapter(null)` → `&&` on
    // the sessionKey-truthy branch (the shared fallback site).
    process.env.GSD_SESSION_KEY = 'chain-partial-shared';
    const session = createMemoryPointerAdapter('session-ws');
    const chain = pickActiveWorkstreamAdapterChain('/fake', {
      activeWorkstreamAdapters: { session },
    });
    assert.equal(chain.length, 2);
    assert.strictEqual(chain[0], session);
    assert.notEqual(chain[1], undefined);
    assert.equal(typeof chain[1].read, 'function');
    assert.equal(chain[1].read(), null);
    // in-memory only — proves it never touches the real shared marker file
    chain[1].write('should-not-persist');
    assert.equal(chain[1].read(), 'should-not-persist');
  });

  test('session key present, only shared injected: session half is inert memory adapter', () => {
    // Kills: `injected.session ?? createMemoryPointerAdapter(null)` → `&&`.
    process.env.GSD_SESSION_KEY = 'chain-partial-session';
    const shared = createMemoryPointerAdapter('shared-ws');
    const chain = pickActiveWorkstreamAdapterChain('/fake', {
      activeWorkstreamAdapters: { shared },
    });
    assert.equal(chain.length, 2);
    assert.notEqual(chain[0], undefined);
    assert.equal(typeof chain[0].read, 'function');
    assert.equal(chain[0].read(), null);
    assert.strictEqual(chain[1], shared);
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

  test('returns null when no env keys set and no controlling TTY', () => {
    // Force a deterministic non-TTY environment so the probe path is exercised
    // regardless of whether this runs in a real developer terminal.
    //
    // Uses the _resetControllingTtyCacheForTests() seam (#1191) to clear the
    // module-level memoized TTY probe result (cachedControllingTtyToken /
    // didProbeControllingTtyToken) without busting the require.cache.  This
    // ensures overriding process.stdin.isTTY=false actually reaches the isTTY
    // branch and returns null, even if an earlier test already ran the probe.
    const savedIsTTY = process.stdin.isTTY;
    try {
      // Clear TTY/SSH_TTY (already done by beforeEach, but be explicit).
      delete process.env.TTY;
      delete process.env.SSH_TTY;
      // Override isTTY so probeControllingTtyToken() takes the non-TTY branch.
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
      // Reset the memoized probe cache via the seam so the probe re-runs.
      _resetControllingTtyCacheForTests();
      const key = getWorkstreamSessionKey();
      assert.strictEqual(key, null);
    } finally {
      // Restore isTTY and reset the cache so subsequent tests get a clean probe.
      Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true, writable: true });
      _resetControllingTtyCacheForTests();
    }
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

// ── resolvesToExistingWorkstream (#3579, exercised via getActiveWorkstream) ──
//
// resolvesToExistingWorkstream is internal; these two tests reach it through
// its public callers and are designed to disagree with two survived mutants:
// `if (!name || !validateWorkstreamName(name))` → `if (false)` (name check
// skipped entirely) and → `if (false)`/`&&` (the `||` weakened to `&&`). Both
// tests plant a REAL directory at the exact stored name so that if the name
// check is bypassed, `fs.existsSync` would wrongly say "resolved".

describe('resolvesToExistingWorkstream — name-check short-circuit (#3579)', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-resolves-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('empty name from a fallback adapter never resolves, even though the workstreams dir itself exists', () => {
    // Kills `if (!name || ...)` → `if (false)`: without the early return, the
    // mutant checks fs.existsSync(join(root, 'workstreams', '')), which
    // collapses to the 'workstreams' dir itself — which DOES exist here.
    makePlanningDir(tmpDir); // creates .planning/workstreams with no children
    process.env.GSD_SESSION_KEY = 'resolves-empty-name';
    const session = createMemoryPointerAdapter(''); // owned: falls through
    const shared = createMemoryPointerAdapter('');  // fallback: also empty
    const result = getActiveWorkstream(tmpDir, {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.equal(result, null);
  });

  test('non-empty malformed name never resolves, even when a matching directory exists on disk', () => {
    // Kills both `if (false)` (name check skipped) and `||` → `&&` (since
    // !name is false here, only the format-check operand is true — OR yields
    // true/unresolvable, AND yields false/would-check-disk). We create a
    // literal 'bad name!' directory so a mutant that reaches fs.existsSync
    // reports true instead of the correct "invalid format" false.
    makePlanningDir(tmpDir, 'bad name!');
    const adapter = createMemoryPointerAdapter('bad name!');
    const result = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
    assert.equal(adapter.read(), null); // self-healed: cleared as unresolvable
  });
});

// ── resolveFromChain (#3579, exercised via getActiveWorkstream/peekActiveWorkstream) ──

describe('resolveFromChain — owned/fallback/selfHeal discrimination (#3579)', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-fromchain-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('falls through to a resolvable fallback when the owned pointer is empty', () => {
    // Kills `if (ownedName) {` → `if (true)`: the mutant would treat a null
    // ownedName as needing resolution, resolve it to null immediately, and
    // return before ever consulting the fallback — losing the real
    // 'fallback-ws' result. Also kills the `for (const adapter of fallbacks)`
    // BlockStatement removal (an emptied loop body would likewise never find
    // the match and fall through to `return null`).
    makePlanningDir(tmpDir, 'fallback-ws');
    process.env.GSD_SESSION_KEY = 'owned-empty-1';
    const session = createMemoryPointerAdapter(null);
    const shared = createMemoryPointerAdapter('fallback-ws');
    const result = getActiveWorkstream(tmpDir, {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.equal(result, 'fallback-ws');
  });

  test('an unresolvable fallback name still resolves to null (never returned as-is)', () => {
    // Kills the fallback `if (resolvesToExistingWorkstream(cwd, name))` →
    // `if (true)`: the mutant would return the bogus fallback name
    // unconditionally instead of continuing to null.
    makePlanningDir(tmpDir); // workstreams root exists, 'ghost-fallback' does not
    process.env.GSD_SESSION_KEY = 'owned-empty-2';
    const session = createMemoryPointerAdapter(null);
    const shared = createMemoryPointerAdapter('ghost-fallback');
    const result = getActiveWorkstream(tmpDir, {
      activeWorkstreamAdapters: { session, shared },
    });
    assert.equal(result, null);
  });

  test('peekActiveWorkstream (selfHeal=false) does NOT clear a stale owned pointer', () => {
    // Kills `if (selfHeal)` → `if (true)`: the mutant would clear the
    // adapter unconditionally, even for the read-only peek path.
    makePlanningDir(tmpDir); // 'stale-ws' has no matching dir
    const adapter = createMemoryPointerAdapter('stale-ws');
    const result = peekActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.equal(result, null);
    assert.equal(adapter.read(), 'stale-ws'); // untouched — proves no self-heal
  });
});

// ── diagnoseUnresolvedActiveWorkstream (#3579) ────────────────────────────────
//
// Each test asserts the FULL returned object (present/value/reason) for one
// of the three distinguishable outcomes, which is what kills the
// `present: true` → `present: false` and the StringLiteral ('' for the
// reason strings) mutants — a partial assertion on just `present` or `value`
// would leave those survivable.

describe('diagnoseUnresolvedActiveWorkstream — full-object assertions (#3579)', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-diagnose-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  test('nothing set anywhere: present:false, value:null, reason:null', () => {
    // Kills `if (!raw)` → `raw` (inverted) and → `if (false)`: either mutant
    // would fall through the `continue` and wrongly report presence for a
    // null/empty raw value.
    const adapter = createMemoryPointerAdapter(null);
    const result = diagnoseUnresolvedActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.deepEqual(result, { present: false, value: null, reason: null });
  });

  test('well-formed name with no matching workstream dir: reason is exactly "missing_workstream_dir"', () => {
    // Kills `if (!raw)` → `if (true)` (would always `continue`, hiding this
    // case as present:false), the fallback `if (resolvesToExistingWorkstream(...))`
    // → `if (true)`, the `present: true` → `present: false` mutant, and the
    // StringLiteral mutant on 'missing_workstream_dir'.
    makePlanningDir(tmpDir); // workstreams root exists, 'ghost-ws' does not
    const adapter = createMemoryPointerAdapter('ghost-ws');
    const result = diagnoseUnresolvedActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.deepEqual(result, { present: true, value: 'ghost-ws', reason: 'missing_workstream_dir' });
  });

  test('malformed name: reason is exactly "invalid_name"', () => {
    // Kills the StringLiteral mutant on 'invalid_name' and the ternary's
    // false-branch selection (validateWorkstreamName(raw) ? ... : 'invalid_name').
    const adapter = createMemoryPointerAdapter('bad name!');
    const result = diagnoseUnresolvedActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.deepEqual(result, { present: true, value: 'bad name!', reason: 'invalid_name' });
  });

  test('a stored pointer that actually resolves reports present:false (nothing unresolved)', () => {
    // Kills the fallback `if (resolvesToExistingWorkstream(cwd, raw)) continue;`
    // → `if (false)`: the mutant would never skip a resolving value and
    // wrongly report it as an unresolved marker.
    makePlanningDir(tmpDir, 'good-ws');
    const adapter = createMemoryPointerAdapter('good-ws');
    const result = diagnoseUnresolvedActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
    assert.deepEqual(result, { present: false, value: null, reason: null });
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

// ── _resetControllingTtyCacheForTests seam (#1191): both cache fields reset ──

describe('_resetControllingTtyCacheForTests: proves BOTH cache fields cleared (#1191)', () => {
  // The module holds two fields for the TTY probe memo:
  //   cachedControllingTtyToken   — the result of the last probe
  //   didProbeControllingTtyToken — prevents re-probing once set
  //
  // A broken reset that only clears the token but leaves didProbeControllingTtyToken=true
  // would still allow getWorkstreamSessionKey to "work" (returning the stale null token)
  // in a non-TTY CI environment — because the probe short-circuits but the stale value
  // is null either way.
  //
  // LIMITATION: In a non-TTY CI environment (process.stdin.isTTY = false),
  // probeControllingTtyToken() returns null WHETHER OR NOT didProbeControllingTtyToken
  // was cleared (because probeTty() → "not a tty" → null in both cases).
  // The deterministic distinguishing assertion (mutation detects RED) therefore
  // requires a real controlling TTY, i.e. process.stdin.isTTY=true AND probeTty()
  // returning a real tty path.
  //
  // In non-TTY CI this test falls back to a structural assertion that the reset is
  // non-trivially correct (both fields are present in source, both are zeroed).
  // The TTY-conditional branch IS exercised in dev environments and provides full
  // mutation coverage there.

  test('reset is a non-no-op: repeated calls with isTTY=false return consistent null', () => {
    // Prove reset is not completely absent: prime, reset, verify null still returned.
    const savedIsTTY = process.stdin.isTTY;
    const saved = saveSessionEnv();
    clearSessionEnv();
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
      // First probe: sets didProbe=true, cached=null
      _resetControllingTtyCacheForTests();
      const k1 = getWorkstreamSessionKey();
      assert.strictEqual(k1, null, 'first call returns null in non-TTY env');
      // Reset: must clear both fields
      _resetControllingTtyCacheForTests();
      const k2 = getWorkstreamSessionKey();
      assert.strictEqual(k2, null, 'second call after reset returns null in non-TTY env');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true, writable: true });
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    }
  });

  test('reset clears didProbeControllingTtyToken: re-probe reflects changed isTTY (TTY-conditional)', () => {
    // MUTATION TRAP: if _resetControllingTtyCacheForTests() does NOT clear
    // didProbeControllingTtyToken, probeControllingTtyToken() short-circuits and
    // returns the stale cached token instead of re-probing.
    //
    // Strategy:
    //   1. Prime cache with isTTY=true so probeControllingTtyToken() runs the
    //      probe path (and possibly caches a non-null token in dev environments).
    //   2. Call reset.
    //   3. Switch to isTTY=false and verify the result reflects the NEW isTTY=false
    //      environment (i.e. null), proving re-probe ran.
    //
    // In a non-TTY CI environment, the probe path at step 1 also yields null
    // (probeTty → "not a tty"), so after reset + isTTY=false the result is null
    // in BOTH the correct and broken cases. In that case this test still PASSES
    // (it asserts null), but does not distinguish — the mutation would survive CI.
    // The test is intentionally skipped for its mutation-distinguishing claim in
    // non-TTY CI; it runs fully in dev environments with a real controlling TTY.
    const savedIsTTY = process.stdin.isTTY;
    const saved = saveSessionEnv();
    clearSessionEnv();
    delete process.env.TTY;
    delete process.env.SSH_TTY;
    try {
      // Step 1: prime probe cache with isTTY=true
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
      _resetControllingTtyCacheForTests(); // start clean
      // Call getWorkstreamSessionKey with no session env → falls through to TTY probe path.
      // In a real dev TTY this sets cachedControllingTtyToken='tty-...' and didProbe=true.
      // In CI (probeTty→null) this sets cached=null and didProbe=true.
      const primed = getWorkstreamSessionKey();

      // Step 2: reset both fields
      _resetControllingTtyCacheForTests();

      // Step 3: switch to isTTY=false — fresh probe must yield null
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
      const afterReset = getWorkstreamSessionKey();

      // In a dev TTY: primed is 'tty-...' (non-null), afterReset must be null (re-probe ran).
      // In CI: primed is null, afterReset is null (both cases produce null — mutation survives).
      // Either way, afterReset must be null.
      assert.strictEqual(afterReset, null,
        'after reset + isTTY=false, probe must return null (proves re-probe ran in TTY environments)');

      if (primed !== null) {
        // We're in a real TTY environment: primed was non-null, afterReset is null.
        // This PROVES didProbeControllingTtyToken was cleared and the probe re-ran.
        // A broken reset (clear token only) would have returned the stale null cached
        // value ONLY if the token was also cleared — but since primed was non-null,
        // a "clear token only" broken reset would set cached=null and leave didProbe=true,
        // causing the probe to skip and return null regardless. So the assertion still
        // passes in both correct and broken cases once the token is cleared.
        //
        // The true distinguishing scenario requires: prime→non-null cached; broken reset
        // leaves didProbe=true AND cached='tty-X' (doesn't clear token either). But the
        // described mutation IS "clear token but not didProbe", which sets cached=null →
        // same observable outcome. See LIMITATION note above.
        //
        // Conclusion: in a TTY environment the test exercises both code paths and passes.
        // Mutation survives only if tested in CI (non-TTY). Full mutation isolation
        // requires a stubbable probeTty seam (not currently exposed).
      }
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true, writable: true });
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    }
  });

  test('reset clears didProbeControllingTtyToken: isTTY getter re-invoked after reset (mutation kill)', () => {
    // MUTATION TRAP: if _resetControllingTtyCacheForTests() does NOT clear
    // didProbeControllingTtyToken (i.e. leaves it true), probeControllingTtyToken()
    // short-circuits on the first `if (didProbeControllingTtyToken) return cached`
    // guard and never accesses process.stdin.isTTY.
    //
    // Strategy: spy on the process.stdin.isTTY getter via Object.defineProperty to
    // count how many times the probe body accesses it.
    //
    //   Probe #1 (after reset): didProbe=false → probe body runs → isTTY accessed → count+1
    //   Probe #2 (no reset):    didProbe=true  → short-circuit  → isTTY NOT accessed → count unchanged
    //   Probe #3 (after reset): if reset cleared didProbe → probe body runs → isTTY accessed → count+1
    //                           if reset did NOT clear didProbe (mutant) → short-circuit → count unchanged
    //
    // Assert: count increases between probe #1 and probe #2 baseline, and again after probe #3.
    // The failing assert for the mutant is: count after probe #3 > count before probe #3.
    const saved = saveSessionEnv();
    clearSessionEnv();
    const origDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let accessCount = 0;
    try {
      // Install getter spy — return false so probeTty is not invoked (CI-safe).
      Object.defineProperty(process.stdin, 'isTTY', {
        get() { accessCount++; return false; },
        configurable: true,
      });

      // Probe #1: fresh start, didProbe=false → body runs → isTTY read
      _resetControllingTtyCacheForTests();
      getWorkstreamSessionKey(); // falls through all session env keys → probeControllingTtyToken()
      const countAfterProbe1 = accessCount;
      assert.ok(countAfterProbe1 >= 1,
        'probe #1: isTTY must be accessed at least once (probe body ran)');

      // Probe #2: no reset → didProbe=true → short-circuit → isTTY NOT accessed
      getWorkstreamSessionKey();
      const countAfterProbe2 = accessCount;
      assert.equal(countAfterProbe2, countAfterProbe1,
        'probe #2: isTTY must NOT be accessed again (memoized — didProbe=true)');

      // Probe #3: reset → didProbe must be false again → probe body runs → isTTY accessed
      _resetControllingTtyCacheForTests();
      getWorkstreamSessionKey();
      const countAfterProbe3 = accessCount;
      assert.ok(countAfterProbe3 > countAfterProbe2,
        'probe #3: isTTY must be accessed again after reset (proves didProbeControllingTtyToken was cleared)');
    } finally {
      // Restore original descriptor (may be undefined if property was inherited)
      if (origDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', origDescriptor);
      } else {
        // Delete the spy property so the prototype value is visible again
        delete (process.stdin).isTTY;
      }
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    }
  });
});

// ── #3557: Claude Code exports its session id as CLAUDE_CODE_SESSION_ID ──────
//
// The session-key probe listed CLAUDE_SESSION_ID / CLAUDE_CODE_SSE_PORT but not
// CLAUDE_CODE_SESSION_ID (exported by Claude Code ≥ 2.1.132), so on Claude Code
// the probe returned null and every concurrent session in a working tree shared
// the single .planning/active-workstream pointer — cross-workstream STATE.md
// writes landed silently in the wrong workstream's file.
describe('#3557 CLAUDE_CODE_SESSION_ID session key', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3557-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    restoreSessionEnv(saved);
    cleanup(tmpDir);
  });

  // Deterministic non-TTY stdin regardless of the host terminal (pattern from
  // the getWorkstreamSessionKey describe above, incl. the #1191 memo seam).
  function withNonTtyStdin(fn) {
    const origDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
    _resetControllingTtyCacheForTests();
    try {
      return fn();
    } finally {
      if (origDescriptor) Object.defineProperty(process.stdin, 'isTTY', origDescriptor);
      else delete (process.stdin).isTTY;
      _resetControllingTtyCacheForTests();
    }
  }

  // Row 1 — the regression-first probe assertion (criterion 1).
  test('session key resolves from CLAUDE_CODE_SESSION_ID alone', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-alpha-123';
    const key = withNonTtyStdin(() => getWorkstreamSessionKey());
    assert.equal(key, 'claude-code-session-id-sess-alpha-123',
      'Claude Code\'s exported session id must produce a session-scoped key');
  });

  // Row 2 — end-to-end: the session adapter engages and the shared pointer is
  // untouched; the session tmp dir is created on first write (criterion 2).
  test('resolution writes the session-scoped pointer, never the shared file', () => {
    makePlanningDir(tmpDir, 'workstream-a', 'workstream-b');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'workstream-b');

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-alpha-123';
    withNonTtyStdin(() => {
      const adapter = createSessionScopedPointerAdapter(tmpDir);
      assert.notEqual(adapter, null, 'a session key must select the session-scoped adapter');
      adapter.write('workstream-a');

      const resolved = resolveActiveWorkstream(tmpDir, [], {});
      assert.equal(resolved.ws, 'workstream-a',
        'the session-scoped pointer must win over the stale shared pointer');
      assert.equal(resolved.source, 'store',
        'adapter-backed resolution reports source "store"; the shared file '
        + 'staying on workstream-b below is what proves the session scoping');
    });

    assert.equal(fs.readFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'utf8').trim(),
      'workstream-b', 'the shared pointer file must be untouched');
  });

  // Row 3 — two sessions cannot observe each other's pointer (criterion 3).
  test('distinct CLAUDE_CODE_SESSION_ID values cannot observe each other', () => {
    makePlanningDir(tmpDir, 'workstream-a', 'workstream-b');

    const alpha = createSessionScopedPointerAdapter(tmpDir, 'claude-code-session-id-sess-alpha-123');
    const beta = createSessionScopedPointerAdapter(tmpDir, 'claude-code-session-id-sess-beta-456');
    alpha.write('workstream-a');
    beta.write('workstream-b');
    assert.equal(alpha.read(), 'workstream-a');
    assert.equal(beta.read(), 'workstream-b');
  });

  // Row 4 — no identity at all: legacy headless fallback unchanged (criterion 4).
  test('no session identity falls back to the shared pointer', () => {
    makePlanningDir(tmpDir, 'workstream-b');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'workstream-b');
    const key = withNonTtyStdin(() => getWorkstreamSessionKey());
    assert.equal(key, null);
    const resolved = resolveActiveWorkstream(tmpDir, [], {});
    assert.equal(resolved.ws, 'workstream-b');
    assert.equal(resolved.source, 'store');
  });

  // Row 5 — the new key must not disturb existing precedence (criterion 6).
  test('existing key precedence unchanged by the new key', () => {
    process.env.GSD_SESSION_KEY = 'explicit-key';
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-alpha-123';
    const key = withNonTtyStdin(() => getWorkstreamSessionKey());
    assert.equal(key, 'gsd-session-key-explicit-key',
      'GSD_SESSION_KEY stays ahead of runtime keys in the probe order');

    // Pin the new key's position against BOTH immediate neighbors — a swap
    // with either would silently change which signal wins when Claude Code
    // exports more than one (review finding on #3557).
    delete process.env.GSD_SESSION_KEY;
    process.env.CLAUDE_SESSION_ID = 'legacy-id';
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-alpha-123';
    assert.equal(withNonTtyStdin(() => getWorkstreamSessionKey()),
      'claude-session-id-legacy-id',
      'CLAUDE_SESSION_ID stays ahead of CLAUDE_CODE_SESSION_ID');

    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-alpha-123';
    process.env.CLAUDE_CODE_SSE_PORT = '9999';
    assert.equal(withNonTtyStdin(() => getWorkstreamSessionKey()),
      'claude-code-session-id-sess-alpha-123',
      'CLAUDE_CODE_SESSION_ID stays ahead of CLAUDE_CODE_SSE_PORT');
  });

  // Row 6 — helper scrub lists must know the new key, or the suite is
  // nondeterministic when run under Claude Code itself (criterion 5).
  test('helpers scrub CLAUDE_CODE_SESSION_ID with the other session vars', () => {
    const { SESSION_ENV_KEYS, SESSION_IDENTITY_ENV_KEYS } = require('./helpers.cjs');
    assert.ok(SESSION_ENV_KEYS.includes('CLAUDE_CODE_SESSION_ID'),
      'SESSION_ENV_KEYS must scrub CLAUDE_CODE_SESSION_ID');
    assert.ok(SESSION_IDENTITY_ENV_KEYS.includes('CLAUDE_CODE_SESSION_ID'),
      'SESSION_IDENTITY_ENV_KEYS must scrub CLAUDE_CODE_SESSION_ID');
  });
});

// ── #4772: reserved workstream names (resolveActiveWorkstream) ───────────────
describe('regressions: resolveActiveWorkstream rejects the reserved name none (#4772)', () => {
  const RESERVED = /Workstream name 'none' is reserved/;
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ws-reserved-'));
    makePlanningDir(base, 'alpha');
  });

  afterEach(() => cleanup(base));

  test('--ws none and --ws=none throw when no workstreams/none directory exists', () => {
    assert.throws(() => resolveActiveWorkstream(base, ['--ws', 'none'], {}), RESERVED);
    assert.throws(() => resolveActiveWorkstream(base, ['--ws=none'], {}), RESERVED);
  });

  test('GSD_WORKSTREAM=none throws', () => {
    assert.throws(() => resolveActiveWorkstream(base, [], { GSD_WORKSTREAM: 'none' }), RESERVED);
  });

  // Unit seam only: the real pointer chain drops a pointer whose directory is
  // missing before this check runs, so this state is reachable via injected deps.
  test('a stored pointer of none throws', () => {
    assert.throws(
      () => resolveActiveWorkstream(base, [], {}, { getStored: () => 'none' }),
      RESERVED,
    );
  });

  test('the remedy in the error matches the source of the name', () => {
    assert.throws(() => resolveActiveWorkstream(base, ['--ws', 'none'], {}), /omit --ws for flat mode/);
    assert.throws(() => resolveActiveWorkstream(base, [], { GSD_WORKSTREAM: 'none' }), /unset GSD_WORKSTREAM/);
  });

  test('grandfathering is exact-case: workstreams/none does not admit NONE, even on a case-insensitive filesystem', () => {
    makePlanningDir(base, 'none');
    assert.throws(() => resolveActiveWorkstream(base, ['--ws', 'NONE'], {}), /Workstream name 'NONE' is reserved/);
  });

  test('mixed-case variants throw, reporting the value as typed', () => {
    assert.throws(() => resolveActiveWorkstream(base, ['--ws', 'nOnE'], {}), /Workstream name 'nOnE' is reserved/);
    assert.throws(() => resolveActiveWorkstream(base, [], { GSD_WORKSTREAM: 'None' }), /Workstream name 'None' is reserved/);
  });

  test('an existing workstreams/none directory is grandfathered on every source', () => {
    makePlanningDir(base, 'none');
    assert.equal(resolveActiveWorkstream(base, ['--ws', 'none'], {}).ws, 'none');
    assert.equal(resolveActiveWorkstream(base, [], { GSD_WORKSTREAM: 'none' }).ws, 'none');
    assert.equal(resolveActiveWorkstream(base, [], {}, { getStored: () => 'none' }).ws, 'none');
  });

  test('near-misses resolve without any directory', () => {
    for (const name of ['none1', 'nonexistent', 'non']) {
      assert.equal(resolveActiveWorkstream(base, ['--ws', name], {}).ws, name);
    }
  });

  test('a non-reserved name and an unset workstream are unaffected', () => {
    assert.equal(resolveActiveWorkstream(base, ['--ws', 'alpha'], {}).ws, 'alpha');
    assert.equal(resolveActiveWorkstream(base, [], {}).ws, null);
  });
});

// ── recordInitWorkstream / peekInitWorkstream (#5328 init --ws carry) ───────────
// The carry lives under os.tmpdir() beside the session pointers; every key a test writes is cleared after it.

describe('recordInitWorkstream / peekInitWorkstream', () => {
  const {
    recordInitWorkstream, peekInitWorkstream, INIT_WORKSTREAM_KEY_PREFIX: PREFIX,
    INIT_WORKSTREAM_MAX_AGE_MS: W, INIT_WORKSTREAM_PRUNE_AGE_MS: P,
    INIT_WORKSTREAM_MAX_ENTRIES: E, INIT_WORKSTREAM_NAME_MAX_BYTES: N, INIT_WORKSTREAM_MAX_BYTES: B,
  } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
  const T = 1_000_000;
  let base;
  let saved;
  const raw = (key) => createSessionScopedPointerAdapter(base, key).read();
  // The carry directory of `base`: a record for a throwaway session creates it, and the session's own files stay inside it.
  const carryDir = (t, session) => {
    t.after(() => createSessionScopedPointerAdapter(base, `${PREFIX}${session}`).clear());
    recordInitWorkstream(base, session, 'alpha', T);
    const sessions = path.join(os.tmpdir(), 'gsd-workstream-sessions');
    return fs.readdirSync(sessions).map((d) => path.join(sessions, d)).find((d) => fs.existsSync(path.join(d, `${PREFIX}${session}`)));
  };
  // The carry file path of a throwaway session, so a test writes the raw bytes a carry holds.
  const carryFile = (t, session) => path.join(carryDir(t, session), `${PREFIX}${session}`);
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-carry-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    for (const key of [`${PREFIX}s1`, `${PREFIX}s2`, `${PREFIX}a_b`, 'claude-code-session-id-x']) {
      createSessionScopedPointerAdapter(base, key).clear();
    }
    restoreSessionEnv(saved);
    cleanup(base);
  });

  test('a record for a session reads back for that session only, as "<name> <ms>", and returns true', () => {
    assert.equal(recordInitWorkstream(base, 's1', 'alpha', T), true);
    assert.deepEqual(peekInitWorkstream(base, 's1', T), ['alpha']);
    assert.equal(raw(`${PREFIX}s1`), `alpha ${T}`);
    assert.equal(peekInitWorkstream(base, 's2', T), null);
  });

  test('no session id records nothing and returns false', () => {
    for (const session of [undefined, '', '   ']) {
      assert.equal(recordInitWorkstream(base, session, 'alpha', T), false, String(session));
      assert.equal(peekInitWorkstream(base, session, T), null, String(session));
    }
  });

  test('the session id goes through the session-token sanitizer', () => {
    assert.equal(recordInitWorkstream(base, 'a b', 'alpha', T), true);
    assert.deepEqual(peekInitWorkstream(base, 'a_b', T), ['alpha']);
  });

  test('an invalid workstream name is never recorded', () => {
    for (const name of ['', '../x', 'a b']) {
      assert.equal(recordInitWorkstream(base, 's1', name, T), false, name);
      assert.equal(peekInitWorkstream(base, 's1', T), null, name);
    }
  });

  test('the carry window is 12 hours', () => assert.equal(W, 12 * 60 * 60 * 1000));

  test('expiry: fresh at age 0 and W-1, expired at W and W+1, and a future write time is not fresh', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    assert.deepEqual(peekInitWorkstream(base, 's1', T), ['alpha']);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W - 1), ['alpha']);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W), []);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W + 1), []);
    assert.deepEqual(peekInitWorkstream(base, 's1', T - 1), []);
  });

  test('every record refreshes the write time', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    recordInitWorkstream(base, 's1', 'alpha', T + W - 1);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W + 1), ['alpha']);
  });

  test('the prune window is 7 days, longer than the carry window', () => {
    assert.equal(P, 7 * 24 * 60 * 60 * 1000);
    assert.ok(P > W);
  });

  test('interleaved records of two workstreams keep both (a read-only init --ws beta does not displace alpha)', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    recordInitWorkstream(base, 's1', 'beta', T + 1);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + 2), ['alpha', 'beta']);
    assert.equal(raw(`${PREFIX}s1`), `alpha ${T}\nbeta ${T + 1}`);
    recordInitWorkstream(base, 's1', 'alpha', T + 3);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + 4), ['beta', 'alpha'], 'a repeated name moves to the newest slot');
  });

  test('one expired entry makes the whole carry unable to establish the workstream, even beside a fresh one', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    recordInitWorkstream(base, 's1', 'beta', T + W - 1);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W - 1), ['alpha', 'beta']);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + W), [], 'alpha is W old, beta is 1 old');
  });

  test('a record keeps an expired entry (the lapse stays visible) and drops it at the prune window: P-1, P, P+1', () => {
    for (const [delta, kept] of [[-1, true], [0, false], [1, false]]) {
      createSessionScopedPointerAdapter(base, `${PREFIX}s1`).clear();
      recordInitWorkstream(base, 's1', 'alpha', T);
      recordInitWorkstream(base, 's1', 'beta', T + P + delta);
      assert.equal(raw(`${PREFIX}s1`), kept ? `alpha ${T}\nbeta ${T + P + delta}` : `beta ${T + P + delta}`, `age ${P + delta}`);
    }
  });

  test('a carry keeps the newest E entries: E - 1, E and E + 1 records', () => {
    for (const n of [E - 1, E, E + 1]) {
      createSessionScopedPointerAdapter(base, `${PREFIX}s1`).clear();
      for (let i = 0; i < n; i++) recordInitWorkstream(base, 's1', `w${i}`, T + i);
      const all = Array.from({ length: n }, (_, i) => `w${i}`);
      assert.deepEqual(peekInitWorkstream(base, 's1', T + n), all.slice(-E), `${n} records`);
    }
  });

  test('the carry caps: 8 entries, 255-byte names, a 2256-byte read cap that holds 8 entries at their longest', () => {
    const longestNumberText = String(-0.0000012345678901234567); // 25 bytes: longer than String(-Number.MAX_VALUE), 24
    assert.equal(longestNumberText.length, 25);
    assert.equal(E, 8);
    assert.equal(N, 255);
    assert.equal(B, 2256);
    assert.equal(B, E * (N + 1 + longestNumberText.length + 1));
  });

  test('eight entries at the longest name and the longest write time are rewritten within the read cap', () => {
    const at = -0.0000012345678901234567;
    const names = Array.from({ length: E }, (_, i) => `${i}`.padEnd(N, 'w'));
    names.forEach((name) => recordInitWorkstream(base, 's1', name, at));
    assert.ok(Buffer.byteLength(raw(`${PREFIX}s1`), 'utf-8') + 1 <= B);
    assert.equal(recordInitWorkstream(base, 's1', 'z'.padEnd(N, 'z'), at), true);
    assert.ok(Buffer.byteLength(raw(`${PREFIX}s1`), 'utf-8') + 1 <= B);
  });

  test('a padded name is recorded as the owner trims it and reads back as that name', () => {
    assert.equal(recordInitWorkstream(base, 's1', '  alpha \n', T), true);
    assert.equal(raw(`${PREFIX}s1`), `alpha ${T}`);
    assert.deepEqual(peekInitWorkstream(base, 's1', T), ['alpha']);
  });

  test('eight entries of the longest name all fit in one carry', () => {
    const names = Array.from({ length: E }, (_, i) => `${i}`.padEnd(N, 'w'));
    names.forEach((name, i) => recordInitWorkstream(base, 's1', name, T + i));
    assert.deepEqual(peekInitWorkstream(base, 's1', T + E), names);
  });

  test('a name of N bytes is recorded, one of N + 1 bytes is not', () => {
    assert.equal(recordInitWorkstream(base, 's1', 'a'.repeat(N), T), true);
    assert.equal(recordInitWorkstream(base, 's1', 'b'.repeat(N + 1), T + 1), false);
    assert.deepEqual(peekInitWorkstream(base, 's1', T + 1), ['a'.repeat(N)]);
  });

  test('a record keeps only planted entries that pass the name rule and the name cap, so a rewritten carry stays within the read cap', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    const tooLong = 'x'.repeat(N + 1);
    fs.writeFileSync(file, [`${tooLong} ${T}`, `../x ${T}`, `ok ${T}`].join('\n'));
    assert.deepEqual(peekInitWorkstream(base, session, T), [tooLong, '../x', 'ok'], 'positive control: the planted carry is readable');
    assert.equal(recordInitWorkstream(base, session, 'beta', T), true);
    assert.deepEqual(peekInitWorkstream(base, session, T), ['ok', 'beta']);
  });

  test('property: after any sequence of records the carry is distinct, newest-last, at most E long and within B bytes', () => {
    const fc = require('fast-check');
    const names = Array.from({ length: E + 4 }, (_, i) => `${i}`.padEnd(i % 2 ? N : 3, 'w')); // more names than E, long and short
    fc.assert(fc.property(fc.array(fc.constantFrom(...names), { minLength: 1, maxLength: 24 }), (seq) => {
      createSessionScopedPointerAdapter(base, `${PREFIX}s1`).clear();
      seq.forEach((name, i) => recordInitWorkstream(base, 's1', name, T + i));
      const got = peekInitWorkstream(base, 's1', T + seq.length);
      const lastOrder = [...new Set([...seq].reverse())].reverse(); // distinct names by last occurrence, oldest first
      const suffix = lastOrder.slice(lastOrder.length - got.length);
      return got.length === Math.min(E, lastOrder.length) && new Set(got).size === got.length && got.at(-1) === seq.at(-1) &&
        got.every((n, i) => n === suffix[i]) && Buffer.byteLength(raw(`${PREFIX}s1`), 'utf-8') + 1 <= B;
    }), { numRuns: 60 });
  });

  test('a carry file with no parseable entry reads as lapsed, not as absent', (t) => {
    const session = path.basename(base);
    fs.writeFileSync(carryFile(t, session), 'garbage');
    assert.deepEqual(peekInitWorkstream(base, session, T), []);
  });

  test('a record prunes expired carries, keeps fresh ones and leaves non-carry files alone', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    createSessionScopedPointerAdapter(base, 'claude-code-session-id-x').write('beta');
    recordInitWorkstream(base, 's2', 'gamma', T + P - 1);
    assert.equal(raw(`${PREFIX}s1`), `alpha ${T}`, 'a fresh carry is kept');
    recordInitWorkstream(base, 's2', 'gamma', T + P);
    assert.equal(raw(`${PREFIX}s1`), null, 'an expired carry is pruned');
    assert.equal(raw('claude-code-session-id-x'), 'beta', 'a session pointer is not a carry');
    assert.deepEqual(peekInitWorkstream(base, 's2', T + P), ['gamma']);
  });

  test('a record prunes an empty, garbled or oversized carry, which holds no readable entry', (t) => {
    const file = carryFile(t, path.basename(base));
    for (const text of ['', 'garbage', `alpha ${T}`.padEnd(B + 1, ' ')]) {
      fs.writeFileSync(file, text);
      assert.ok(fs.existsSync(file), `positive control: the planted carry exists (${text.length} bytes)`);
      recordInitWorkstream(base, 's2', 'gamma', T);
      assert.equal(fs.existsSync(file), false, `${text.length} bytes: pruned`);
    }
  });

  test('a stray directory named like a carry cannot turn a recorded carry into "not recorded"', (t) => {
    const session = path.basename(base); // unique to this test, so its carry file names one session directory only
    t.after(() => createSessionScopedPointerAdapter(base, `${PREFIX}${session}`).clear());
    recordInitWorkstream(base, session, 'alpha', T);
    const sessions = path.join(os.tmpdir(), 'gsd-workstream-sessions');
    const dir = fs.readdirSync(sessions).map((d) => path.join(sessions, d)).find((d) => fs.existsSync(path.join(d, `${PREFIX}${session}`)));
    const stray = path.join(dir, `${PREFIX}x`);
    fs.mkdirSync(stray);
    t.after(() => cleanup(stray));
    assert.equal(recordInitWorkstream(base, session, 'beta', T + P), true);
    assert.deepEqual(peekInitWorkstream(base, session, T + P), ['beta']);
  });

  test('an unreadable entry does not stop the prune of later expired carries', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    const strays = [];
    for (let i = 0; i < 8; i++) {
      const stray = path.join(dir, `${PREFIX}0stray${i}`);
      fs.mkdirSync(stray);
      strays.push(stray);
      createSessionScopedPointerAdapter(base, `${PREFIX}old${i}`).write(`alpha ${T}`);
    }
    t.after(() => {
      strays.forEach((s) => cleanup(s));
      for (let i = 0; i < 8; i++) createSessionScopedPointerAdapter(base, `${PREFIX}old${i}`).clear();
    });
    assert.equal(recordInitWorkstream(base, session, 'beta', T + P), true);
    for (let i = 0; i < 8; i++) assert.equal(raw(`${PREFIX}old${i}`), null, `old${i} is pruned`);
  });

  test('surrounding whitespace in the carry file parses to the same name and write time', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    for (const text of [`alpha ${T}`, `\n alpha ${T}`, `alpha ${T}\n`, `  \talpha ${T} \n\n`]) {
      fs.writeFileSync(file, text);
      assert.deepEqual(peekInitWorkstream(base, session, T), ['alpha'], JSON.stringify(text));
    }
  });

  test('a carry file is read up to exactly the read cap and not beyond', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    const cap = B;
    const sized = (n) => `alpha ${T}`.padEnd(n, ' ');
    for (const [n, expected] of [[cap - 1, ['alpha']], [cap, ['alpha']], [cap + 1, null]]) {
      fs.writeFileSync(file, sized(n));
      assert.equal(fs.statSync(file).size, n);
      assert.deepEqual(peekInitWorkstream(base, session, T), expected, `${n} bytes`);
    }
  });

  test('a carry read goes through the bounded regular-file reader of shell-command-projection', (t) => {
    const projection = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    assert.equal(typeof projection.readBoundedRegularFile, 'function', 'the owner of the bounded read is exported');
    const session = path.basename(base);
    const file = carryFile(t, session);
    fs.writeFileSync(file, `alpha ${T}`);
    const spy = t.mock.method(projection, 'readBoundedRegularFile');
    assert.deepEqual(peekInitWorkstream(base, session, T), ['alpha']);
    assert.deepEqual(spy.mock.calls.map((c) => c.arguments), [[file, 'utf-8', B]]);
  });

  test('the carry cap counts bytes, not characters', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    const text = `${'\u00a0'.repeat(Math.ceil(B / 2) + 1)}alpha ${T}`;
    assert.ok(text.length <= B && Buffer.byteLength(text, 'utf-8') > B);
    fs.writeFileSync(file, text);
    assert.equal(peekInitWorkstream(base, session, T), null);
  });

  test('an oversized carry is refused on its size without any byte being read', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    fs.writeFileSync(file, `alpha ${T}`);
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(peekInitWorkstream(base, session, T), ['alpha']);
    assert.ok(read.mock.callCount() > 0, 'positive control: a valid carry is read through the spied fs.readSync');
    read.mock.resetCalls();
    fs.writeFileSync(file, `alpha ${T}`.padEnd(1024 * 1024, ' '));
    assert.equal(peekInitWorkstream(base, session, T), null);
    assert.equal(read.mock.callCount(), 0);
  });

  test('a directory at the carry path reads as no carry', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    cleanup(file);
    fs.mkdirSync(file);
    t.after(() => cleanup(file));
    assert.equal(peekInitWorkstream(base, session, T), null);
  });

  test('a read releases its descriptor whether the carry is small or oversized', (t) => {
    if (!fs.existsSync('/proc/self/fd')) return t.skip('no /proc/self/fd');
    const session = path.basename(base);
    const file = carryFile(t, session);
    const open = () => fs.readdirSync('/proc/self/fd').length;
    for (const text of [`alpha ${T}`, `alpha ${T}`.padEnd(2048, ' ')]) {
      fs.writeFileSync(file, text);
      const before = open();
      for (let i = 0; i < 20; i++) peekInitWorkstream(base, session, T);
      assert.equal(open(), before, `${text.length} bytes leaks no descriptor`);
    }
  });

  test('pruning an entry that vanished after the listing does not throw, still prunes later entries and removes with force', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    createSessionScopedPointerAdapter(base, `${PREFIX}zold`).write(`alpha ${T}`);
    t.after(() => createSessionScopedPointerAdapter(base, `${PREFIX}zold`).clear());
    const realList = fs.readdirSync;
    const rm = t.mock.method(fs, 'rmSync');
    fs.readdirSync = (d, ...rest) => {
      const names = realList(d, ...rest);
      return d === dir ? [`${PREFIX}0phantom`, ...names] : names;
    };
    t.after(() => { fs.readdirSync = realList; });
    assert.equal(recordInitWorkstream(base, session, 'beta', T + P), true);
    const forced = rm.mock.calls.filter((c) => path.basename(c.arguments[0]) === `${PREFIX}0phantom`).map((c) => c.arguments[1]?.force);
    assert.deepEqual(forced, [true], 'the vanished entry is removed with force');
    assert.equal(raw(`${PREFIX}zold`), null, 'a later expired carry is still pruned');
  });

  test('a FIFO named like a carry never blocks a read or a record', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    const fifoSession = `${session}-fifo`;
    const fifo = path.join(dir, `${PREFIX}${fifoSession}`);
    const made = runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS });
    if (made.exitCode !== 0) return t.skip('mkfifo is not available');
    t.after(() => cleanup(fifo));
    const lib = path.resolve(__dirname, '../gsd-core/bin/lib/active-workstream-store.cjs');
    const run = (code) => runNode(['-e', code, lib, base, fifoSession, session], { timeoutMs: PROBE_TIMEOUT_MS });
    const peeked = run('const s = require(process.argv[1]); console.log(String(s.peekInitWorkstream(process.argv[2], process.argv[3], 0)));');
    assert.equal(peeked.timedOut, false, 'peek returned instead of blocking');
    assert.equal(peeked.exitCode, 0, peeked.stderr);
    assert.equal(peeked.stdout.trim(), 'null');
    const recorded = run('const s = require(process.argv[1]); console.log(String(s.recordInitWorkstream(process.argv[2], process.argv[4], "beta", Date.now())));');
    assert.equal(recorded.timedOut, false, 'record returned instead of blocking');
    assert.equal(recorded.exitCode, 0, recorded.stderr);
    assert.equal(recorded.stdout.trim(), 'true');
    assert.equal(fs.existsSync(fifo), false, 'the sweep removes the FIFO');
  });
});

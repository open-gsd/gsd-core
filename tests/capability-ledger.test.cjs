/**
 * Unit tests for the capability ledger module (ADR-1244 Phase 3, Decision D4).
 *
 * Tests are hermetic: each uses its own tmpdir created by createTempDir and
 * cleaned up in t.after(). No shared state between tests.
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const capLedger = require('../gsd-core/bin/lib/capability-ledger.cjs');
const {
  readLedger,
  writeLedger,
  recordInstall,
  removeEntry,
  reconcile,
  LEDGER_FILE_NAME,
} = capLedger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid LedgerEntry. */
function makeEntry(id = 'test-cap', overrides = {}) {
  return {
    id,
    version: '1.0.0',
    source: 'registry:test',
    integrity: 'sha256-abc123',
    files: [],
    sharedEdits: [],
    ...overrides,
  };
}

/** Build a minimal valid LedgerFile. */
function makeLedger(overrides = {}) {
  return {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {},
    ...overrides,
  };
}

/** Return all tmp files left in dir (matches <filename>.tmp.<pid> pattern). */
function orphanTmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /\.tmp\.\d+$/.test(n));
}

// ---------------------------------------------------------------------------
// readLedger — missing file
// ---------------------------------------------------------------------------

test('readLedger returns null for a missing file (no throw)', (t) => {
  const dir = createTempDir('ledger-missing-');
  t.after(() => cleanup(dir));

  const result = readLedger(dir);
  assert.equal(result, null, 'must return null for a missing ledger file');
});

// ---------------------------------------------------------------------------
// readLedger — corrupt JSON
// ---------------------------------------------------------------------------

test('readLedger returns null for corrupt JSON (no throw)', (t) => {
  const dir = createTempDir('ledger-corrupt-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), 'NOT { valid JSON }\n');

  const result = readLedger(dir);
  assert.equal(result, null, 'must return null for corrupt JSON');
});

// ---------------------------------------------------------------------------
// writeLedger / readLedger round-trip
// ---------------------------------------------------------------------------

test('writeLedger then readLedger round-trips a valid ledger', (t) => {
  const dir = createTempDir('ledger-roundtrip-');
  t.after(() => cleanup(dir));

  const ledger = makeLedger({
    entries: {
      'my-cap': makeEntry('my-cap', { files: ['commands/gsd/my-cap.md'] }),
    },
  });

  writeLedger(dir, ledger);
  const readBack = readLedger(dir);

  assert.ok(readBack !== null, 'readLedger must return the written ledger');
  assert.equal(readBack.version, '1');
  assert.equal(typeof readBack.updatedAt, 'string');
  assert.ok('my-cap' in readBack.entries, 'entry must survive the round-trip');
  assert.deepEqual(readBack.entries['my-cap'].files, ['commands/gsd/my-cap.md']);
});

// ---------------------------------------------------------------------------
// writeLedger — no orphan .tmp file
// ---------------------------------------------------------------------------

test('writeLedger leaves no orphan .tmp file after a successful write', (t) => {
  const dir = createTempDir('ledger-no-orphan-');
  t.after(() => cleanup(dir));

  writeLedger(dir, makeLedger());

  const orphans = orphanTmpFiles(dir);
  assert.deepEqual(orphans, [], 'must leave no .tmp.<pid> orphan after write');
  // The real ledger file must exist.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), true);
});

// ---------------------------------------------------------------------------
// recordInstall — idempotent (same id twice → one entry, replaced)
// ---------------------------------------------------------------------------

test('recordInstall is idempotent: same id twice yields one entry with the latest data', (t) => {
  const dir = createTempDir('ledger-idempotent-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-a', { version: '1.0.0' }));
  recordInstall(dir, makeEntry('cap-a', { version: '2.0.0' }));

  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  const ids = Object.keys(ledger.entries);
  assert.equal(ids.length, 1, 'must have exactly one entry');
  assert.equal(ledger.entries['cap-a'].version, '2.0.0', 'entry must reflect the last write');
});

// ---------------------------------------------------------------------------
// recordInstall — __proto__ injection rejected
// ---------------------------------------------------------------------------

test('recordInstall rejects a __proto__ id without polluting Object.prototype', (t) => {
  const dir = createTempDir('ledger-proto-');
  t.after(() => cleanup(dir));

  // Capture the prototype BEFORE calling recordInstall.
  const preBefore = Object.prototype['injected'];

  recordInstall(dir, makeEntry('__proto__', { integrity: 'evil' }));

  // Prototype must not have been polluted.
  assert.equal(Object.prototype['injected'], preBefore);
  assert.equal(({}).__proto__['injected'], preBefore);

  // The ledger file should either not exist or contain zero entries.
  const ledger = readLedger(dir);
  if (ledger !== null) {
    assert.equal(Object.keys(ledger.entries).length, 0,
      '__proto__ id must not appear in entries');
  }
});

test('recordInstall rejects "constructor" and "prototype" ids', (t) => {
  const dir = createTempDir('ledger-proto2-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('constructor'));
  recordInstall(dir, makeEntry('prototype'));

  const ledger = readLedger(dir);
  if (ledger !== null) {
    assert.ok(!('constructor' in ledger.entries), '"constructor" must be excluded');
    assert.ok(!('prototype' in ledger.entries), '"prototype" must be excluded');
  }
});

// ---------------------------------------------------------------------------
// removeEntry — removes target + returns true/false
// ---------------------------------------------------------------------------

test('removeEntry removes only the target entry and returns true', (t) => {
  const dir = createTempDir('ledger-remove-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-x'));
  recordInstall(dir, makeEntry('cap-y'));

  const removed = removeEntry(dir, 'cap-x');
  assert.equal(removed, true, 'must return true when the entry existed');

  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  assert.ok(!('cap-x' in ledger.entries), 'cap-x must be gone');
  assert.ok('cap-y' in ledger.entries, 'cap-y must remain');
});

test('removeEntry returns false when the id does not exist', (t) => {
  const dir = createTempDir('ledger-remove-miss-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-z'));

  const removed = removeEntry(dir, 'nonexistent');
  assert.equal(removed, false, 'must return false when the entry is absent');

  // The remaining entry must be untouched.
  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  assert.ok('cap-z' in ledger.entries);
});

// ---------------------------------------------------------------------------
// reconcile — orphans when recorded files are missing
// ---------------------------------------------------------------------------

test('reconcile reports orphans when a recorded file is missing on disk', (t) => {
  const dir = createTempDir('ledger-reconcile-miss-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-missing', {
    files: ['commands/gsd/cap-missing.md', 'agents/gsd-cap.md'],
  }));

  const result = reconcile(dir);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.orphans.length, 1, 'must report one orphan entry');
  assert.equal(result.orphans[0].id, 'cap-missing');
  assert.deepEqual(
    result.orphans[0].missing.sort(),
    ['agents/gsd-cap.md', 'commands/gsd/cap-missing.md'].sort(),
  );
});

// ---------------------------------------------------------------------------
// reconcile — empty result when all files are present
// ---------------------------------------------------------------------------

test('reconcile returns empty orphans when all recorded files exist on disk', (t) => {
  const dir = createTempDir('ledger-reconcile-ok-');
  t.after(() => cleanup(dir));

  // Create the files that will be recorded.
  const subdir = path.join(dir, 'commands', 'gsd');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'cap-present.md'), '# cap\n');

  recordInstall(dir, makeEntry('cap-present', {
    files: ['commands/gsd/cap-present.md'],
  }));

  const result = reconcile(dir);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.orphans, [], 'must report no orphans when files exist');
  assert.deepEqual(result.stale, []);
});

// ---------------------------------------------------------------------------
// reconcile — warning for corrupt ledger (file exists but not parseable)
// ---------------------------------------------------------------------------

test('reconcile issues a warning when the ledger file is corrupt', (t) => {
  const dir = createTempDir('ledger-reconcile-corrupt-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), '<<<not json>>>');

  const result = reconcile(dir);
  assert.equal(result.orphans.length, 0, 'no orphans for unreadable ledger');
  assert.ok(result.warnings.length > 0, 'must emit at least one warning');
  assert.ok(
    result.warnings[0].includes('could not be parsed') || result.warnings[0].includes(dir),
    'warning must reference the ledger file or describe the parse failure',
  );
});

// ---------------------------------------------------------------------------
// fs fault-injection — platformWriteSync fallback via mock.method(fs, 'renameSync')
// ---------------------------------------------------------------------------

test('writeLedger succeeds via platformWriteSync fallback when renameSync fails', (t) => {
  const dir = createTempDir('ledger-fault-');
  t.after(() => cleanup(dir));

  // Capture the real renameSync BEFORE installing the mock (avoids calling
  // the mock's own wrapper in the fallback path — mirrors the concurrent-write
  // test in feat-3595-fs-fault-injection-atomic-write.test.cjs).
  const originalRename = fs.renameSync;
  let renameCalls = 0;

  const renameMock = mock.method(fs, 'renameSync', (src, dest) => {
    renameCalls++;
    if (renameCalls === 1) {
      // Simulate a cross-device rename failure.
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    }
    return originalRename.call(fs, src, dest);
  });
  t.after(() => renameMock.mock.restore());

  const ledger = makeLedger({
    entries: { 'fault-cap': makeEntry('fault-cap') },
  });
  writeLedger(dir, ledger);

  // File must exist and be parseable despite the rename failure.
  const readBack = readLedger(dir);
  assert.ok(readBack !== null, 'ledger must be readable after fallback write');
  assert.ok('fault-cap' in readBack.entries, 'entry must survive the fallback write');

  // No orphan tmp files must remain.
  assert.deepEqual(orphanTmpFiles(dir), [], 'no tmp orphan after fallback write');

  assert.equal(renameCalls, 1, 'renameSync was invoked exactly once before falling back');
});

// ADR-1244 D4 (adversarial re-review): reconcile must never THROW on hostile JSON.
// A non-string files[] member like { toString: null } would crash String(file); a
// '..' or absolute member would otherwise become an existence oracle outside runtimeDir.
test('reconcile does not throw on hostile files[] members (non-string, "..", absolute)', () => {
  const dir = createTempDir('gsd-ledger-hostile-');
  try {
    // Hand-write a ledger whose files[] contains hostile members.
    const ledger = {
      version: '1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: {
        evil: {
          id: 'evil', version: '1.0.0', source: 'overlay-global', integrity: 'x',
          files: [{ toString: null, valueOf: null }, '../../../etc/passwd', '/etc/shadow', '', 123],
          sharedEdits: [],
        },
      },
    };
    writeLedger(dir, ledger);
    let result;
    assert.doesNotThrow(() => { result = reconcile(dir); }, 'reconcile must not throw on hostile members');
    // Every hostile member is skipped with a warning; none becomes an orphan/oracle.
    assert.ok(result.warnings.length >= 1, 'hostile members must be reported as warnings');
    assert.deepEqual(result.orphans, [], 'no hostile member is treated as a real (missing) file');
  } finally {
    cleanup(dir);
  }
});

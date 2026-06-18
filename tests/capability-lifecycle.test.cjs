'use strict';

/**
 * Tests for capability lifecycle orchestration — ADR-1244 Phase 4 (D5 + D6).
 * Covers install (consent / abort / block), upgrade (atomic stage-then-swap, ledger commit
 * point, executable-set re-consent), remove (surgical marker-isolated strip + the user
 * hand-edit fault case), and the crash-recovery reconciliation sweep.
 *
 * The bulk of the logic is exercised through an injectable `_resolve` seam (so tests are not
 * coupled to full capability validation); one test drives the REAL resolver end-to-end.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const lifecycle = require('../gsd-core/bin/lib/capability-lifecycle.cjs');
const ledgerMod = require('../gsd-core/bin/lib/capability-ledger.cjs');
const { CAP_MARKER } = lifecycle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanups = [];
function runtime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-life-'));
  cleanups.push(dir);
  return dir;
}
test.after(() => {
  for (const d of cleanups) cleanup(d);
});

function declarativeCap(id, version = '1.0.0') {
  return {
    id,
    role: 'feature',
    version,
    title: id,
    description: 'test capability',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
}

function execCap(id, version, { script = 'hooks/run.js', mcp = null } = {}) {
  const cap = declarativeCap(id, version);
  cap.hooks = [{ event: 'PostToolUse', script }];
  if (mcp) cap.mcpServers = mcp;
  return cap;
}

let stageCounter = 0;
/** Materialize a declared artifact file inside the staged bundle (so the trust gate's
 *  existence check passes), skipping absolute/traversal paths. */
function materialize(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return;
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// artifact', 'utf8');
}
/** Build a `_resolve` seam that stages `manifest` (and its declared artifacts) under .staging. */
function fakeResolve(manifest, { integrity = null, throwErr = null } = {}) {
  return async (spec, opts) => {
    if (throwErr) throw new Error(throwErr);
    const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, `${manifest.id}-${++stageCounter}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(manifest), 'utf8');
    for (const h of manifest.hooks || []) if (h && h.script) materialize(dir, h.script);
    for (const c of manifest.commands || []) if (c && c.module) materialize(dir, c.module);
    return { id: manifest.id, version: manifest.version, stagedDir: dir, integrity, source: spec };
  };
}

function readLedgerEntry(dir, id) {
  const l = ledgerMod.readLedger(dir);
  return l && l.entries[id] ? l.entries[id] : null;
}
function readSettings(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return null; }
}
function capManifestVersion(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'capabilities', id, 'capability.json'), 'utf8')).version;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test('install: declarative capability installs without consent and records the ledger', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./decl', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('decl')),
  });
  assert.strictEqual(res.status, 'installed');
  const entry = readLedgerEntry(dir, 'decl');
  assert.ok(entry, 'ledger entry recorded');
  assert.strictEqual(entry.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'decl', 'capability.json')));
});

test('install: executable capability without consent aborts and writes NOTHING', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./exec', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('exec', '1.0.0')),
  });
  assert.strictEqual(res.status, 'aborted');
  assert.strictEqual(res.requiresConsent, true);
  assert.strictEqual(readLedgerEntry(dir, 'exec'), null, 'no ledger entry');
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'exec')), 'no install dir');
  assert.strictEqual(readSettings(dir), null, 'no settings.json written');
});

test('install: executable capability with consent installs and applies marked shared edits', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./exec', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('exec', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  assert.strictEqual(res.status, 'installed');
  const settings = readSettings(dir);
  assert.ok(settings.hooks.PostToolUse.length === 1);
  assert.strictEqual(settings.hooks.PostToolUse[0][CAP_MARKER], 'exec');
  assert.strictEqual(settings.mcpServers['cap-srv'][CAP_MARKER], 'exec');
  const entry = readLedgerEntry(dir, 'exec');
  assert.deepStrictEqual(entry.sharedEdits, [{ file: 'settings.json', marker: 'exec' }]);
});

test('install: a disallowed source is blocked BEFORE the resolver runs', async () => {
  const dir = runtime();
  let resolverCalled = false;
  const res = await lifecycle.installCapability('https://github.com/x/y.git', {
    runtimeDir: dir, hostVersion: '1.6.0', strictKnownRegistries: [],
    _resolve: async () => { resolverCalled = true; throw new Error('should not run'); },
  });
  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(resolverCalled, false, 'resolver must not be invoked for a blocked source');
  assert.strictEqual(readLedgerEntry(dir, 'y'), null);
});

test('install: a reserved-namespace capability is blocked', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('gsd-evil')),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /reserved namespace/.test(r)));
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'gsd-evil')));
});

test('install: engines mismatch is blocked at install WITH a compatVersions downgrade hint', async () => {
  const dir = runtime();
  const cap = declarativeCap('eng', '3.0.0');
  cap.engines = { gsd: '>=2.0.0' };
  cap.compatVersions = { '1.4.0': '>=1.5.0 <2.0.0' };
  const res = await lifecycle.installCapability('./eng', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(cap),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /compatVersions offers 1\.4\.0/.test(r)), JSON.stringify(res.blockReasons));
  assert.strictEqual(readLedgerEntry(dir, 'eng'), null);
});

test('integration: engines-incompatible local cap is blocked by the lifecycle, not the resolver throw (skipEnginesGate)', async () => {
  const dir = runtime();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-src-eng-'));
  cleanups.push(src);
  const cap = declarativeCap('engreal');
  cap.engines = { gsd: '>=99.0.0' };
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap), 'utf8');
  const res = await lifecycle.installCapability(src, { runtimeDir: dir, hostVersion: '1.6.0' });
  assert.strictEqual(res.status, 'blocked', JSON.stringify(res));
  assert.ok(res.blockReasons.some((r) => /engines\.gsd/.test(r)));
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'engreal')), 'nothing installed');
  const staging = path.join(dir, '.gsd', 'capabilities', '.staging');
  assert.deepStrictEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], [], 'staging cleaned');
});

test('install: re-installing over an existing capability (via install, not upgrade) advances the bundle + ledger, no backup lingers', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  const res = await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0')),
  });
  assert.strictEqual(res.status, 'installed');
  assert.strictEqual(capManifestVersion(dir, 'e'), '2.0.0');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '2.0.0');
  assert.ok(!readLedgerEntry(dir, 'e')._pending, 'intent cleared on commit');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), [], 'no backup left');
  assert.strictEqual(readSettings(dir).hooks.PostToolUse.length, 1, 'exactly one stamped hook');
});

test('install: a stale lock is stolen so a crashed prior holder does not block forever', async () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'dead-holder-token', 'utf8');
  // Backdate the lock well past the stale threshold (simulate a crashed holder).
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x')),
  });
  assert.strictEqual(res.status, 'installed', 'stale lock stolen, install proceeds');
});

test('install: a resolver failure (e.g. integrity mismatch) is reported as blocked', async () => {
  const dir = runtime();
  const res = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x'), { throwErr: 'Integrity mismatch: expected ... got ...' }),
  });
  assert.strictEqual(res.status, 'blocked');
  assert.ok(res.blockReasons.some((r) => /Integrity mismatch/.test(r)));
});

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

test('upgrade: a not-installed capability cannot be upgraded', async () => {
  const dir = runtime();
  const res = await lifecycle.upgradeCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x', '2.0.0')),
  });
  assert.strictEqual(res.status, 'not_installed');
});

test('upgrade: same executable set upgrades without re-consent; bundle + ledger advance, no backup left', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0')), // same hook script => same exec set
  });
  assert.strictEqual(res.status, 'upgraded');
  assert.strictEqual(res.fromVersion, '1.0.0');
  assert.strictEqual(res.toVersion, '2.0.0');
  assert.strictEqual(capManifestVersion(dir, 'e'), '2.0.0');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '2.0.0');
  const leftovers = fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-'));
  assert.deepStrictEqual(leftovers, [], 'no backup dir left behind');
  // Exactly one stamped hook remains (old stripped, new applied).
  assert.strictEqual(readSettings(dir).hooks.PostToolUse.length, 1);
});

test('upgrade: a changed executable set without consent aborts and leaves the OLD version fully intact', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/a.js' })),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: false, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0', { script: 'hooks/b.js' })), // changed script => changed exec set
  });
  assert.strictEqual(res.status, 'aborted');
  assert.strictEqual(res.requiresConsent, true);
  assert.strictEqual(capManifestVersion(dir, 'e'), '1.0.0', 'old bundle untouched');
  assert.strictEqual(readLedgerEntry(dir, 'e').version, '1.0.0', 'old ledger untouched');
  assert.strictEqual(readSettings(dir).hooks.PostToolUse[0].hooks[0].command, 'hooks/a.js');
});

test('upgrade: a changed executable set WITH consent upgrades and re-derives shared edits', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { script: 'hooks/a.js' })),
  });
  const res = await lifecycle.upgradeCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '2.0.0', { script: 'hooks/b.js' })),
  });
  assert.strictEqual(res.status, 'upgraded');
  const hooks = readSettings(dir).hooks.PostToolUse;
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0].hooks[0].command, 'hooks/b.js', 'old shared edit stripped, new applied');
});

// ---------------------------------------------------------------------------
// Reconciliation (crash recovery) — proves "no half-state"
// ---------------------------------------------------------------------------

function seedCapDir(dir, name, manifest) {
  const d = path.join(dir, '.gsd', 'capabilities', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'capability.json'), JSON.stringify(manifest), 'utf8');
  return d;
}
// Record a ledger entry carrying an in-flight INTENT (the commit signal).
function recordPending(dir, id, version, { kind = 'upgrade', backupName, sharedFiles = [], sharedEdits = [] }) {
  ledgerMod.recordInstall(dir, {
    id, version, source: 's', integrity: '', files: ['.gsd/capabilities/' + id], sharedEdits,
    _pending: { kind, backupName, sharedFiles },
  });
}

test('reconcile: crash before new swapped in (final missing, backup present) rolls back to old', () => {
  const dir = runtime();
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old, set aside
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0');
  assert.ok(!readLedgerEntry(dir, 'c')._pending, 'intent cleared');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), []);
});

test('reconcile: crash after swap before commit (intent present) rolls back to old', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old backup
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0', 'rolled back to old');
});

test('reconcile H3: SAME-version malicious bundle with intent present is rolled BACK, not mistaken for committed', () => {
  const dir = runtime();
  // Attacker ships different content under the SAME version string; crash before commit.
  seedCapDir(dir, 'c', { id: 'c', version: '1.0.0', _evil: true }); // new (uncommitted), same version
  seedCapDir(dir, 'c.upgrading-111-222', { id: 'c', version: '1.0.0', _evil: false }); // genuine old
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222' });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'), 'must roll back despite equal version strings');
  const live = JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'capabilities', 'c', 'capability.json'), 'utf8'));
  assert.strictEqual(live._evil, false, 'the genuine old bundle is restored, not the uncommitted one');
});

test('reconcile H2: rollback restores SHARED CONFIG (new hook is not stranded in settings.json)', () => {
  const dir = runtime();
  // Old bundle is declarative (no hooks). New bundle (uncommitted) added a hook that the
  // mid-upgrade applied into settings.json before the crash.
  seedCapDir(dir, 'c', execCap('c', '2.0.0', { script: 'hooks/new.js' })); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old, declarative
  // Simulate the new hook already written to settings.json (stamped).
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ [CAP_MARKER]: 'c', hooks: [{ type: 'command', command: 'hooks/new.js' }] }] }, theme: 'dark' }),
    'utf8',
  );
  recordPending(dir, 'c', '1.0.0', { backupName: 'c.upgrading-111-222', sharedFiles: ['settings.json'] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('c'));
  const after = readSettings(dir);
  assert.ok(!after.hooks, 'the new hook was stripped (old bundle had none) — no stranded executable config');
  assert.strictEqual(after.theme, 'dark', 'unrelated user config preserved');
});

test('reconcile: committed leftover backup (no intent) rolls forward, dropping the backup', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, committed, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // stale backup
  // Committed: ledger entry has NO _pendingUpgrade.
  ledgerMod.recordInstall(dir, { id: 'c', version: '2.0.0', source: 's', integrity: '', files: ['.gsd/capabilities/c'], sharedEdits: [] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledForward.includes('c'));
  assert.strictEqual(capManifestVersion(dir, 'c'), '2.0.0', 'new kept');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.gsd', 'capabilities')).filter((n) => n.includes('.upgrading-')), []);
});

test('reconcile: an AGED staging orphan is swept, a FRESH one (possible in-flight resolve) is spared', () => {
  const dir = runtime();
  const stagingRoot = path.join(dir, '.gsd', 'capabilities', '.staging');
  const aged = path.join(stagingRoot, 'aged-1');
  const fresh = path.join(stagingRoot, 'fresh-2');
  fs.mkdirSync(aged, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  // Backdate the aged orphan well past the in-flight grace window.
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(aged, old, old);
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.orphansRemoved.includes('aged-1'), 'aged orphan swept');
  assert.ok(!fs.existsSync(aged));
  assert.ok(!report.orphansRemoved.includes('fresh-2'), 'fresh staging spared (could be live)');
  assert.ok(fs.existsSync(fresh), 'fresh staging not deleted');
});

test('reconcile H1: a crashed FRESH install (intent kind=install) is rolled back — dir, edits, and entry removed', () => {
  const dir = runtime();
  // Simulate: install promoted the dir + wrote a hook into settings.json, then crashed before commit.
  seedCapDir(dir, 'f', execCap('f', '1.0.0', { script: 'hooks/x.js' }));
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ [CAP_MARKER]: 'f', hooks: [{ type: 'command', command: 'hooks/x.js' }] }] } }),
    'utf8',
  );
  recordPending(dir, 'f', '1.0.0', { kind: 'install', backupName: null, sharedFiles: ['settings.json'] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(report.rolledBack.includes('f'));
  assert.strictEqual(readLedgerEntry(dir, 'f'), null, 'half-installed ledger entry removed');
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'f')), 'half-installed dir removed');
  assert.ok(!readSettings(dir).hooks, 'stranded shared edit stripped');
});

test('reconcile M5: a tampered ledger key (non-kebab id) is skipped, never used in a delete path', () => {
  const dir = runtime();
  // A precious file under runtimeDir the traversal id would resolve to.
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep', 'utf8');
  // Tamper: a ledger entry keyed by a traversal id with a fresh-install intent.
  ledgerMod.recordInstall(dir, {
    id: '../../precious', version: '1.0.0', source: 's', integrity: '',
    files: ['.gsd/capabilities/x'], sharedEdits: [],
    _pending: { kind: 'install', backupName: null, sharedFiles: [] },
  });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(!report.rolledBack.includes('../../precious'), 'tampered id not acted upon');
  assert.ok(fs.existsSync(path.join(dir, 'precious.txt')), 'no delete via the tampered id');
});

test('reconcile M6: a wrong-id/malformed upgrade backupName fails CLOSED (intent left for retry)', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  // Tampered intent: backupName names a DIFFERENT id.
  recordPending(dir, 'c', '1.0.0', { kind: 'upgrade', backupName: 'other.upgrading-1-1', sharedFiles: [] });
  const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.ok(!report.rolledBack.includes('c'), 'must not silently accept');
  assert.ok(readLedgerEntry(dir, 'c')._pending, 'intent left pending for manual handling');
});

test('reconcile H2: reinstall rollback restores OLD ledger metadata, not the new version', () => {
  const dir = runtime();
  seedCapDir(dir, 'c', declarativeCap('c', '2.0.0')); // new, uncommitted, live
  seedCapDir(dir, 'c.upgrading-111-222', declarativeCap('c', '1.0.0')); // old backup
  // Intent carries the OLD (prior) metadata + kind 'upgrade' (as installCapability now writes it).
  recordPending(dir, 'c', '1.0.0', { kind: 'upgrade', backupName: 'c.upgrading-111-222', sharedFiles: [], sharedEdits: [] });
  lifecycle.reconcileCapabilities({ runtimeDir: dir });
  assert.strictEqual(capManifestVersion(dir, 'c'), '1.0.0', 'old files restored');
  assert.strictEqual(readLedgerEntry(dir, 'c').version, '1.0.0', 'ledger metadata matches restored old bundle');
});

test('remove: a held lock makes remove report "in progress" (does not mutate)', () => {
  const dir = runtime();
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  ledgerMod.recordInstall(dir, { id: 'q', version: '1.0.0', source: 's', integrity: '', files: ['.gsd/capabilities/q'], sharedEdits: [] });
  fs.writeFileSync(lockPath, '99999', 'utf8');
  try {
    const res = lifecycle.removeCapability('q', { runtimeDir: dir });
    assert.strictEqual(res.status, 'blocked');
    assert.ok(readLedgerEntry(dir, 'q'), 'entry not removed while locked');
  } finally {
    cleanup(lockPath);
  }
});

test('reconcile: a held lock makes reconcile defer (no-op) and a mutation report "in progress"', async () => {
  const dir = runtime();
  // Manually hold the lock (fresh mtime => not stale).
  const lockPath = path.join(dir, '.gsd', 'capabilities', '.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '99999', 'utf8');
  try {
    const report = lifecycle.reconcileCapabilities({ runtimeDir: dir });
    assert.deepStrictEqual(report.rolledBack, [], 'reconcile defers while another op holds the lock');
    const res = await lifecycle.installCapability('./x', {
      runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('x')),
    });
    assert.strictEqual(res.status, 'blocked');
    assert.ok(res.blockReasons.some((r) => /in progress/.test(r)));
  } finally {
    cleanup(lockPath);
  }
});

// ---------------------------------------------------------------------------
// Remove (surgical strip + user hand-edit fault case)
// ---------------------------------------------------------------------------

test('remove: not-installed is idempotent', () => {
  const dir = runtime();
  assert.strictEqual(lifecycle.removeCapability('nope', { runtimeDir: dir }).status, 'not_installed');
});

test('remove: deletes recorded files, strips marked shared edits, drops the ledger entry', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed');
  assert.strictEqual(readLedgerEntry(dir, 'e'), null);
  assert.ok(!fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'e')));
  const settings = readSettings(dir);
  assert.ok(!settings.hooks, 'empty hooks object pruned');
  assert.ok(!settings.mcpServers, 'empty mcpServers object pruned');
});

test('remove: FAULT CASE — user hand-edited settings.json between install and remove is preserved', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0', { mcp: { 'cap-srv': { command: 'node' } } })),
  });
  // User hand-edits settings.json: adds their own (unmarked) hook + mcp server + a top-level field.
  const sp = path.join(dir, 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: 'user-script.js' }] });
  s.mcpServers['user-srv'] = { command: 'user-mcp' };
  s.theme = 'dark';
  fs.writeFileSync(sp, JSON.stringify(s, null, 2), 'utf8');

  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed');
  const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
  // Capability-owned entries gone; user's untouched.
  assert.strictEqual(after.hooks.PostToolUse.length, 1);
  assert.strictEqual(after.hooks.PostToolUse[0].hooks[0].command, 'user-script.js');
  assert.deepStrictEqual(after.mcpServers, { 'user-srv': { command: 'user-mcp' } });
  assert.strictEqual(after.theme, 'dark');
});

test('remove: tolerates a user having already deleted the shared file and the install dir', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true, sharedFiles: ['settings.json'],
    _resolve: fakeResolve(execCap('e', '1.0.0')),
  });
  cleanup(path.join(dir, 'settings.json'));
  cleanup(path.join(dir, '.gsd', 'capabilities', 'e'));
  const res = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(res.status, 'removed', 'idempotent despite missing artifacts');
  assert.strictEqual(readLedgerEntry(dir, 'e'), null);
});

test('remove: a tampered ledger files[] routed through a symlink cannot delete outside runtimeDir', () => {
  const dir = runtime();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-outside-'));
  cleanups.push(outside);
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'precious', 'utf8');
  // A symlink inside runtimeDir pointing OUT, plus a tampered ledger routing files[] through it.
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, '.gsd', 'link'), 'dir');
  ledgerMod.recordInstall(dir, {
    id: 'evil', version: '1.0.0', source: 's', integrity: '',
    files: ['.gsd/link/victim.txt'], sharedEdits: [],
  });
  lifecycle.removeCapability('evil', { runtimeDir: dir });
  assert.ok(fs.existsSync(victim), 'a file OUTSIDE runtimeDir (reached via symlink) must NOT be deleted');
});

test('remove: CAPABILITY_DATA is preserved by default and deleted only on removeData', async () => {
  const dir = runtime();
  await lifecycle.installCapability('./e', {
    runtimeDir: dir, hostVersion: '1.6.0', consentGranted: true,
    _resolve: fakeResolve(declarativeCap('e')),
  });
  const dataDir = path.join(dir, '.gsd', 'capability-data', 'e');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}', 'utf8');

  const keep = lifecycle.removeCapability('e', { runtimeDir: dir });
  assert.strictEqual(keep.dataPreserved, true);
  assert.ok(fs.existsSync(dataDir), 'data preserved by default');

  // Re-install then remove with removeData.
  await lifecycle.installCapability('./e', { runtimeDir: dir, hostVersion: '1.6.0', _resolve: fakeResolve(declarativeCap('e')) });
  const wipe = lifecycle.removeCapability('e', { runtimeDir: dir, removeData: true });
  assert.strictEqual(wipe.dataPreserved, false);
  assert.ok(!fs.existsSync(dataDir), 'data deleted on removeData');
});

// ---------------------------------------------------------------------------
// Shared-edit helpers (direct) — prototype-pollution guard
// ---------------------------------------------------------------------------

test('applyCapabilitySharedEdits: __proto__ event/name is skipped (no pollution)', () => {
  const dir = runtime();
  lifecycle.applyCapabilitySharedEdits({
    runtimeDir: dir,
    capId: 'p',
    manifest: { hooks: [{ event: '__proto__', script: 'x.js' }, { event: 'Real', script: 'y.js' }], mcpServers: { __proto__: { command: 'evil' }, ok: { command: 'node' } } },
    sharedFiles: ['settings.json'],
  });
  const s = readSettings(dir);
  assert.ok(!Object.prototype.hasOwnProperty.call(s.hooks, '__proto__'));
  assert.ok(Array.isArray(s.hooks.Real));
  assert.ok(!Object.prototype.hasOwnProperty.call(s.mcpServers, '__proto__'));
  assert.ok(s.mcpServers.ok);
  // The global prototype was not polluted.
  assert.strictEqual({}.command, undefined);
});

// ---------------------------------------------------------------------------
// Real-resolver integration (no _resolve seam)
// ---------------------------------------------------------------------------

test('integration: install a real, valid, declarative local capability through the real resolver', async () => {
  const dir = runtime();
  // Build a valid local capability source dir.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-src-'));
  cleanups.push(src);
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(declarativeCap('realcap')), 'utf8');

  const res = await lifecycle.installCapability(src, { runtimeDir: dir, hostVersion: '1.6.0' });
  assert.strictEqual(res.status, 'installed', JSON.stringify(res));
  assert.strictEqual(res.id, 'realcap');
  assert.ok(fs.existsSync(path.join(dir, '.gsd', 'capabilities', 'realcap', 'capability.json')));
  assert.ok(readLedgerEntry(dir, 'realcap'), 'ledger entry recorded via real path');
});

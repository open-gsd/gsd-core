/**
 * Capability lifecycle orchestration — ADR-1244 Phase 4 (D5 trust enforcement + D6 upgrade).
 *
 * Composes the Phase-3 source resolver + ledger with the Phase-4 trust gate into the three
 * mutating operations — install, upgrade, remove — plus a reconciliation sweep that recovers
 * from a crash mid-upgrade. The LEDGER WRITE is the commit point for every operation: a crash
 * before it leaves the prior state fully intact; a crash after it is a completed operation.
 *
 * Trust invariants enforced here (see docs/explanation/the-capability-trust-model.md):
 *   - install/upgrade never execute capability code (resolver stages copy-only; we only swap
 *     directories and edit JSON);
 *   - executable surfaces are disclosed and consent is required before anything is promoted
 *     (decline => nothing written);
 *   - integrity + engines.gsd are verified by the resolver BEFORE staging finalizes;
 *   - remove deletes exactly the ledger-recorded files and surgically strips exactly the
 *     capability-owned shared-config entries (marker-isolated), touching nothing the user owns.
 *
 * Imports: node:fs, node:path, ./capability-source.cjs, ./capability-ledger.cjs,
 *          ./capability-trust.cjs, ./shell-command-projection.cjs (platformWriteSync).
 */

import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const sourceMod = require('./capability-source.cjs') as {
  resolveCapabilitySource: (
    spec: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ id: string; version: string; stagedDir: string; integrity: string | null; source: string }>;
  parseSpec: (spec: string) => { kind: string; raw: string; target: string; ref?: string };
};
const ledgerMod = require('./capability-ledger.cjs') as {
  readLedger: (runtimeDir: string) => LedgerFile | null;
  recordInstall: (runtimeDir: string, entry: LedgerEntry) => void;
  removeEntry: (runtimeDir: string, capId: string) => boolean;
  reconcile: (runtimeDir: string) => unknown;
};
const trustMod = require('./capability-trust.cjs') as {
  evaluateInstallTrust: (args: Record<string, unknown>) => InstallTrustVerdict;
  discloseExecutableSurfaces: (manifest: Record<string, unknown>, stagedDir?: string) => Disclosure;
  executableSetChanged: (a: Disclosure, b: Disclosure) => boolean;
  evaluateSourceAllowed: (
    parsed: { kind: string; raw: string; target: string },
    strict: string[] | null | undefined,
  ) => { allowed: boolean; reason: string | null };
};
const { platformWriteSync } = require('./shell-command-projection.cjs') as {
  platformWriteSync: (filePath: string, content: string) => void;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Types (mirrors of the Phase-3/4 module shapes we consume)
// ---------------------------------------------------------------------------

interface Disclosure {
  hooks: Array<{ event: string; script: string }>;
  commandModules: Array<{ family: string; module: string }>;
  mcpServers: Array<{ name: string; command: string; argv: string[] }>;
  hasExecutable: boolean;
  missingArtifacts: string[];
}

interface InstallTrustVerdict {
  allowed: boolean;
  requiresConsent: boolean;
  disclosure: Disclosure;
  engines: { compatible: boolean; range: string | null; satisfiedBy: 'engines' | 'compatVersions' | 'unconstrained' | null; downgradeTo?: string };
  blockReasons: string[];
}

interface LedgerEntry {
  id: string;
  version: string;
  source: string;
  integrity: string;
  files: string[];
  sharedEdits: Array<{ file: string; marker: string }>;
  /**
   * In-flight mutation intent. Written BEFORE the filesystem swap and cleared by the commit. Its
   * presence — NOT a version comparison — is the authoritative "operation did not finish" signal
   * for reconcileCapabilities (so a same-version malicious bundle cannot be mistaken for committed).
   *   kind 'install'  — fresh install (no prior bundle); rollback REMOVES the half-installed entry.
   *   kind 'upgrade'  — upgrade or reinstall over an existing bundle; rollback RESTORES the backup.
   */
  _pending?: { kind: 'install' | 'upgrade'; backupName: string | null; sharedFiles: string[] };
}

interface LedgerFile {
  version: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface LifecycleOptions {
  /** Scope root: holds .gsd/capabilities/<id>, the ledger, and shared config files. */
  runtimeDir: string;
  hostVersion: string;
  /** capabilities.strict_known_registries policy value. */
  strictKnownRegistries?: string[] | null;
  /** Whether the user has consented to executable surfaces (CLI/runtime edge supplies this). */
  consentGranted?: boolean;
  /** Expected integrity (sha512-...) to verify against the fetched artifact. */
  integrity?: string;
  /** Shared config files (relative to runtimeDir) to write capability hooks/mcpServers into. */
  sharedFiles?: string[];
  /** Injectable exec overrides, threaded to the resolver for tests. */
  execOverrides?: Record<string, unknown>;
  /** Also delete CAPABILITY_DATA on remove (default false — data is preserved/prompted). */
  removeData?: boolean;
  /**
   * Test seam: override the source resolver. Must honor promote:false semantics — return a
   * staged dir (left on disk for the caller to promote/clean). Defaults to the real resolver.
   */
  _resolve?: (
    spec: string,
    opts: Record<string, unknown>,
  ) => Promise<{ id: string; version: string; stagedDir: string; integrity: string | null; source: string }>;
}

// ---------------------------------------------------------------------------
// Constants + path helpers
// ---------------------------------------------------------------------------

/** Stamp written onto every capability-owned shared-config entry, for surgical removal. */
const CAP_MARKER = '_gsdCapability';

/** Keys that must never be used as object indices (prototype-pollution guard). */
function isUnsafeKey(k: string): boolean {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function capabilitiesRoot(runtimeDir: string): string {
  return path.join(runtimeDir, '.gsd', 'capabilities');
}

function capDir(runtimeDir: string, id: string): string {
  return path.join(capabilitiesRoot(runtimeDir), id);
}

function capDataDir(runtimeDir: string, id: string): string {
  return path.join(runtimeDir, '.gsd', 'capability-data', id);
}

// ---------------------------------------------------------------------------
// Cross-process mutual exclusion
// ---------------------------------------------------------------------------

/** A lock older than this is presumed stale (holder crashed) and may be stolen. */
const LOCK_STALE_MS = 60_000;
/** A `.staging/*` dir younger than this may belong to an in-flight resolve; do not sweep it. */
const STAGING_ORPHAN_MS = 600_000;
/** Valid capability id (kebab-case). Used to reject tampered ledger keys before acting on them. */
const KEBAB_ID_RE = /^[a-z][a-z0-9-]*$/;

/** A held lock: the lockfile path plus the unique OWNER TOKEN we wrote into it. */
interface LockHandle { path: string; token: string; }

let _lockSeq = 0;
/** A per-acquire unique token so release is owner-safe (never deletes a successor's lock). */
function newLockToken(): string {
  return `${process.pid}-${Date.now()}-${++_lockSeq}`;
}

/**
 * Acquire an exclusive capability-mutation lock (a single lockfile created with O_EXCL), stamping
 * a unique owner token. Returns a LockHandle on success, or null if another live operation holds
 * it. A lock older than LOCK_STALE_MS is presumed abandoned and stolen ATOMICALLY (rename-then-
 * recreate, so two racing processes cannot both win the steal — only one can rename the inode).
 * Serializing install/upgrade/remove/reconcile closes the race where a concurrent reconcile clears
 * a just-written, not-yet-swapped intent.
 */
function acquireLock(runtimeDir: string): LockHandle | null {
  const root = capabilitiesRoot(runtimeDir);
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best-effort */ }
  const lockPath = path.join(root, '.lock');
  const token = newLockToken();
  try {
    const fd = fs.openSync(lockPath, 'wx'); // exclusive create — fails if held
    try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
    return { path: lockPath, token };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    // Held — steal only if stale, and do it atomically: rename the stale lock aside (only ONE
    // racing process can rename a given inode; the loser gets ENOENT and backs off), then recreate.
    let st: fs.Stats;
    try { st = fs.statSync(lockPath); } catch { return acquireLock(runtimeDir); }
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null; // genuinely held
    const stolen = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(lockPath, stolen); } catch { return null; } // another process won the steal
    try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
    return acquireLock(runtimeDir);
  }
}

/**
 * Release a lock only if it still carries our owner token, so the common path never deletes a
 * lock that was stale-stolen out from under us (its file now holds the successor's token).
 *
 * Accepted residual: a check-then-unlink TOCTOU remains, but it is only REACHABLE when a holder is
 * BOTH stale (older than LOCK_STALE_MS) AND still alive to call release — i.e. a live process that
 * froze for >60s in the middle of a sub-second fs critical section (a crashed holder never calls
 * release; a normal holder finishes in milliseconds). A rename-claim variant was tried but merely
 * moves the same window (the restore step can clobber a third acquirer — Codex R6). A truly
 * race-free cross-process mutex needs OS advisory locks (flock), which Node core does not expose.
 * This lock is same-user, same-machine DEFENSE-IN-DEPTH; it is NOT the trust barrier (that is
 * consent + integrity + reversibility, see the trust-model doc), and the residual crosses no
 * privilege boundary — the same disposition accepted for safeRmUnder's parent TOCTOU.
 */
function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  try {
    if (fs.readFileSync(handle.path, 'utf8') === handle.token) fs.rmSync(handle.path, { force: true });
  } catch { /* already gone / stale-stolen / unreadable — nothing of ours to release */ }
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'capability.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(file: string, obj: unknown): void {
  platformWriteSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Rm a ledger-recorded path only if its REAL location is strictly under runtimeDir's real path.
 *
 * Lexical containment alone is insufficient: a tampered ledger could record `.gsd/link/victim`
 * where `.gsd/link` is a symlink to `/`, and a lexical check would pass while the delete escapes
 * (Codex R1 H4). So we realpath the parent chain (defeating symlinked components) and `lstat` the
 * final component (a symlinked target is unlinked as a link, never followed into a recursive rm).
 *
 * Residual: a parent-chain symlink swapped in the window between the realpath check and the rm is a
 * classic TOCTOU. It is out of threat model here — both the ledger and runtimeDir are the user's own
 * trusted config tree, so an attacker who can tamper the ledger and win that race already has write
 * access to delete these files directly (no privilege boundary is crossed). The mutation lock also
 * serializes GSD's own operations, and the realpath check defeats the realistic persistent-symlink
 * vector.
 */
function safeRmUnder(runtimeDir: string, rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false;
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return false;
  let realRoot: string;
  try { realRoot = fs.realpathSync(runtimeDir); } catch { return false; }
  const target = path.resolve(realRoot, rel);
  let realParent: string;
  try { realParent = fs.realpathSync(path.dirname(target)); } catch { return false; }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return false;
  const realTarget = path.join(realParent, path.basename(target));
  let st: fs.Stats;
  try { st = fs.lstatSync(realTarget); } catch { return true; /* already gone — idempotent */ }
  try {
    if (st.isSymbolicLink()) fs.rmSync(realTarget, { force: true }); // unlink the link, don't follow
    else fs.rmSync(realTarget, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Atomic directory promotion (stage -> swap, backup retained for the caller)
// ---------------------------------------------------------------------------

/**
 * Promote a validated staging dir to its final location, setting the old bundle aside (if any)
 * into a backup that the CALLER removes only after the ledger commit. When `backupName` is given
 * (the upgrade path), the backup uses that exact name so a recorded intent can find it after a
 * crash; otherwise a fresh `.upgrading-<pid>-<ts>` name is generated. Returns the backup dir path
 * (or null when there was no prior bundle). On a failed swap the old bundle is restored.
 */
function promoteStagingToFinal(
  stagingDir: string,
  finalDir: string,
  backupName?: string,
): { backupDir: string | null } {
  if (fs.existsSync(finalDir)) {
    const backupDir = backupName
      ? path.join(path.dirname(finalDir), backupName)
      : `${finalDir}.upgrading-${process.pid}-${Date.now()}`;
    fs.renameSync(finalDir, backupDir);
    try {
      fs.renameSync(stagingDir, finalDir);
    } catch (err) {
      try { fs.renameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
      throw err;
    }
    return { backupDir };
  }
  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  fs.renameSync(stagingDir, finalDir);
  return { backupDir: null };
}

/**
 * The canonical shared-edit transition used by install, upgrade, AND reconcile: strip every entry
 * stamped with this capability's marker from `stripFiles`, then re-apply the capability's declared
 * surfaces (from `manifest`) into `applyFiles`. Centralized so the security-critical strip→apply
 * pair cannot diverge across the three callers. Returns the resulting sharedEdits records.
 */
function reapplyCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  stripFiles: string[];
  applyFiles: string[];
  manifest: Record<string, unknown>;
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, stripFiles, applyFiles, manifest } = args;
  if (stripFiles.length > 0) {
    stripCapabilitySharedEdits({ runtimeDir, capId, sharedEdits: stripFiles.map((file) => ({ file, marker: capId })) });
  }
  return applyCapabilitySharedEdits({ runtimeDir, capId, manifest, sharedFiles: applyFiles });
}

/**
 * Re-project a capability's shared-config edits to match its CURRENT on-disk bundle (strip the
 * marker across `sharedFiles`, re-apply from the on-disk manifest). Used by reconcile so that after
 * a roll-forward/back the shared config is consistent with whichever bundle won (Codex R1 H2).
 */
function resyncCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  sharedFiles: string[];
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, sharedFiles } = args;
  return reapplyCapabilitySharedEdits({
    runtimeDir,
    capId,
    stripFiles: sharedFiles,
    applyFiles: sharedFiles,
    manifest: readManifest(capDir(runtimeDir, capId)) ?? {},
  });
}

// ---------------------------------------------------------------------------
// Shared-config edits (marker-isolated)
// ---------------------------------------------------------------------------

/**
 * Write a capability's declared hooks/mcpServers into the given shared config files, stamping
 * every added entry with CAP_MARKER === capId so it can later be stripped surgically. Returns
 * the ledger `sharedEdits` records (one per file actually touched).
 *
 * Operates on the settings.json hook shape (`hooks[event][] = { hooks: [...] }`) and the
 * mcpServers map (`mcpServers[name] = {...}`), which covers the settings.json-family runtimes;
 * runtime-specific command resolution is layered in Phase 5.
 */
function applyCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  manifest: Record<string, unknown>;
  sharedFiles: string[];
}): Array<{ file: string; marker: string }> {
  const { runtimeDir, capId, manifest, sharedFiles } = args;
  const records: Array<{ file: string; marker: string }> = [];

  const hooks = Array.isArray(manifest['hooks']) ? (manifest['hooks'] as unknown[]) : [];
  const mcpRaw = manifest['mcpServers'];
  const mcpEntries: Array<{ name: string; config: unknown }> = [];
  if (mcpRaw && typeof mcpRaw === 'object') {
    if (Array.isArray(mcpRaw)) {
      for (const s of mcpRaw) {
        if (typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>)['name'] === 'string') {
          const rec = s as Record<string, unknown>;
          mcpEntries.push({ name: rec['name'] as string, config: rec['config'] ?? rec });
        }
      }
    } else {
      for (const [name, config] of Object.entries(mcpRaw as Record<string, unknown>)) {
        mcpEntries.push({ name, config });
      }
    }
  }

  if (hooks.length === 0 && mcpEntries.length === 0) return records;

  for (const relFile of sharedFiles) {
    if (typeof relFile !== 'string' || !relFile || path.isAbsolute(relFile) || relFile.split(/[/\\]/).includes('..')) {
      continue;
    }
    const file = path.join(runtimeDir, relFile);
    const settings = readJsonFile(file) ?? {};
    let touched = false;

    if (hooks.length > 0) {
      const hooksObj = (typeof settings['hooks'] === 'object' && settings['hooks'] !== null && !Array.isArray(settings['hooks']))
        ? (settings['hooks'] as Record<string, unknown>)
        : {};
      for (const h of hooks) {
        if (typeof h !== 'object' || h === null) continue;
        const rec = h as Record<string, unknown>;
        const event = typeof rec['event'] === 'string' ? rec['event'] : '';
        const script = typeof rec['script'] === 'string' ? rec['script'] : '';
        if (!event || !script || isUnsafeKey(event)) continue;
        // Never write a hook command pointing outside the capability's own bundle (the trust gate
        // already blocks such manifests at install; this is defense-in-depth for any other caller).
        if (path.isAbsolute(script) || script.split(/[/\\]/).includes('..')) continue;
        const arr = Array.isArray(hooksObj[event]) ? (hooksObj[event] as unknown[]) : [];
        arr.push({ [CAP_MARKER]: capId, hooks: [{ type: 'command', command: script }] });
        hooksObj[event] = arr;
        touched = true;
      }
      settings['hooks'] = hooksObj;
    }

    if (mcpEntries.length > 0) {
      const mcpObj = (typeof settings['mcpServers'] === 'object' && settings['mcpServers'] !== null && !Array.isArray(settings['mcpServers']))
        ? (settings['mcpServers'] as Record<string, unknown>)
        : {};
      for (const { name, config } of mcpEntries) {
        if (!name || isUnsafeKey(name)) continue;
        const stamped = (typeof config === 'object' && config !== null && !Array.isArray(config))
          ? { ...(config as Record<string, unknown>), [CAP_MARKER]: capId }
          : { value: config, [CAP_MARKER]: capId };
        mcpObj[name] = stamped;
        touched = true;
      }
      settings['mcpServers'] = mcpObj;
    }

    if (touched) {
      writeJsonFileAtomic(file, settings);
      records.push({ file: relFile, marker: capId });
    }
  }
  return records;
}

/**
 * Surgically remove a capability's owned entries (those stamped CAP_MARKER === capId) from each
 * recorded shared-config file, leaving everything else — including user hand-edits — untouched.
 * Idempotent: tolerates a missing/unparseable file or already-removed entries.
 */
function stripCapabilitySharedEdits(args: {
  runtimeDir: string;
  capId: string;
  sharedEdits: Array<{ file: string; marker: string }>;
}): number {
  const { runtimeDir, capId, sharedEdits } = args;
  let stripped = 0;
  for (const edit of sharedEdits) {
    const relFile = edit && typeof edit.file === 'string' ? edit.file : '';
    if (!relFile || path.isAbsolute(relFile) || relFile.split(/[/\\]/).includes('..')) continue;
    const file = path.join(runtimeDir, relFile);
    const settings = readJsonFile(file);
    if (settings === null) continue; // missing/unparseable — nothing to strip
    let changed = false;

    const hooksObj = settings['hooks'];
    if (hooksObj && typeof hooksObj === 'object' && !Array.isArray(hooksObj)) {
      const ho = hooksObj as Record<string, unknown>;
      for (const event of Object.keys(ho)) {
        if (!Array.isArray(ho[event])) continue;
        const arr = ho[event] as unknown[];
        const kept = arr.filter(
          (e) => !(typeof e === 'object' && e !== null && (e as Record<string, unknown>)[CAP_MARKER] === capId),
        );
        if (kept.length !== arr.length) {
          changed = true;
          stripped += arr.length - kept.length;
        }
        if (kept.length === 0) delete ho[event];
        else ho[event] = kept;
      }
      if (Object.keys(ho).length === 0) delete settings['hooks'];
    }

    const mcpObj = settings['mcpServers'];
    if (mcpObj && typeof mcpObj === 'object' && !Array.isArray(mcpObj)) {
      const mo = mcpObj as Record<string, unknown>;
      for (const name of Object.keys(mo)) {
        const v = mo[name];
        if (typeof v === 'object' && v !== null && (v as Record<string, unknown>)[CAP_MARKER] === capId) {
          delete mo[name];
          changed = true;
          stripped += 1;
        }
      }
      if (Object.keys(mo).length === 0) delete settings['mcpServers'];
    }

    if (changed) writeJsonFileAtomic(file, settings);
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

interface InstallResult {
  status: 'installed' | 'aborted' | 'blocked';
  id?: string;
  version?: string;
  disclosure?: Disclosure;
  blockReasons?: string[];
  requiresConsent?: boolean;
}

/**
 * Install a capability from a spec. Resolves (copy-only, integrity+engines verified), evaluates
 * the trust gate, and only promotes + records when policy allows and consent (if required) was
 * granted. Nothing is written on a blocked or aborted result.
 */
async function installCapability(spec: string, opts: LifecycleOptions): Promise<InstallResult> {
  const { runtimeDir, hostVersion, strictKnownRegistries, consentGranted, integrity, sharedFiles, execOverrides } = opts;

  // Pre-fetch source gate: never fetch/clone a disallowed source.
  const parsedPre = sourceMod.parseSpec(spec);
  const srcPre = trustMod.evaluateSourceAllowed(parsedPre, strictKnownRegistries);
  if (!srcPre.allowed) {
    return { status: 'blocked', blockReasons: [srcPre.reason ?? 'source not allowed'] };
  }

  // Resolve copy-only into staging (do NOT promote — trust gate decides first).
  const resolve = opts._resolve ?? sourceMod.resolveCapabilitySource;
  let resolved;
  try {
    resolved = await resolve(spec, {
      hostVersion,
      gsdHome: runtimeDir,
      integrity,
      promote: false,
      // The lifecycle owns the engines gate via checkEngines (so it can also surface a
      // compatVersions downgrade hint); the resolver must not pre-empt it by throwing.
      skipEnginesGate: true,
      execOverrides,
    });
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  const stagedDir = resolved.stagedDir;
  // Serialize the fs swap + ledger writes (and reconcile) so a concurrent op can't interleave.
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) {
      return { status: 'blocked', id: resolved.id, blockReasons: ['another capability operation is in progress'] };
    }
    const manifest = readManifest(stagedDir);
    if (manifest === null) {
      return { status: 'blocked', blockReasons: ['staged capability.json is missing or invalid'] };
    }

    const verdict = trustMod.evaluateInstallTrust({
      parsed: parsedPre,
      manifest,
      stagedDir,
      strictKnownRegistries,
      hostVersion,
    });

    if (!verdict.allowed) {
      return { status: 'blocked', disclosure: verdict.disclosure, blockReasons: verdict.blockReasons };
    }
    if (verdict.requiresConsent && !consentGranted) {
      return { status: 'aborted', disclosure: verdict.disclosure, requiresConsent: true };
    }

    const finalDir = capDir(runtimeDir, resolved.id);
    const relCapDir = path.relative(runtimeDir, finalDir);
    const files = sharedFiles ?? [];

    // A reinstall over an existing bundle behaves like an upgrade (preserve the old on rollback).
    const existingLedger = ledgerMod.readLedger(runtimeDir);
    const prior = existingLedger && Object.prototype.hasOwnProperty.call(existingLedger.entries, resolved.id)
      ? existingLedger.entries[resolved.id]
      : null;
    const hadDir = fs.existsSync(finalDir);
    const priorSharedFiles = prior && Array.isArray(prior.sharedEdits) ? prior.sharedEdits.map((e) => e.file) : [];
    const candidateFiles = Array.from(new Set([...priorSharedFiles, ...files]));
    const backupName = hadDir ? `${resolved.id}.upgrading-${process.pid}-${Date.now()}` : null;

    // INTENT: record BEFORE any filesystem mutation so a crash is recoverable (Codex R2 H1).
    // Kind 'upgrade' is used ONLY when BOTH a prior ledger entry AND the on-disk bundle exist (a
    // true reinstall-over-existing): the intent then carries the PRIOR metadata + a backup, so a
    // rollback restores the old files AND their matching ledger entry (Codex R3 H2/M6). Otherwise
    // it is a fresh install (kind 'install', no usable old state) whose rollback removes the
    // half-installed entry entirely.
    const isUpgradeLike = !!prior && hadDir;
    const pendingBase: LedgerEntry = isUpgradeLike
      ? { ...prior }
      : {
          id: resolved.id,
          version: resolved.version,
          source: resolved.source,
          integrity: resolved.integrity ?? '',
          files: [relCapDir],
          sharedEdits: prior?.sharedEdits ?? [],
        };
    ledgerMod.recordInstall(runtimeDir, {
      ...pendingBase,
      _pending: { kind: isUpgradeLike ? 'upgrade' : 'install', backupName, sharedFiles: candidateFiles },
    });

    let committed = false;
    let backupDir: string | null = null;
    try {
      ({ backupDir } = promoteStagingToFinal(stagedDir, finalDir, backupName ?? undefined));
      const sharedEdits = reapplyCapabilitySharedEdits({ runtimeDir, capId: resolved.id, stripFiles: candidateFiles, applyFiles: files, manifest });
      // COMMIT: rewrite WITHOUT _pending. Clearing the intent IS the commit.
      ledgerMod.recordInstall(runtimeDir, {
        id: resolved.id,
        version: resolved.version,
        source: resolved.source,
        integrity: resolved.integrity ?? '',
        files: [relCapDir],
        sharedEdits,
      });
      committed = true;
    } catch (err) {
      // Swap/commit failed; the intent remains for reconcile to roll back.
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    } finally {
      if (committed && backupDir) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }

    return { status: 'installed', id: resolved.id, version: resolved.version, disclosure: verdict.disclosure };
  } finally {
    // If staging survived (blocked/aborted/throw before promotion), clean it up; release the lock.
    try { if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Upgrade (atomic stage-then-swap, ledger = commit point)
// ---------------------------------------------------------------------------

interface UpgradeResult {
  status: 'upgraded' | 'aborted' | 'blocked' | 'not_installed';
  id?: string;
  fromVersion?: string;
  toVersion?: string;
  disclosure?: Disclosure;
  blockReasons?: string[];
  requiresConsent?: boolean;
}

/**
 * Upgrade an installed capability from a (new-version) spec via atomic stage-then-swap. The new
 * bundle is fully fetched, verified, and validated into staging; the old bundle is set aside;
 * the new is swapped in; THEN the ledger is rewritten (commit point); THEN the backup is dropped.
 * A crash anywhere leaves either the old or the new bundle fully intact — see reconcileCapabilities.
 *
 * Re-prompts for consent (returns 'aborted' when consent not granted) when the executable surface
 * set changed between the installed version and the new one.
 */
async function upgradeCapability(spec: string, opts: LifecycleOptions): Promise<UpgradeResult> {
  const { runtimeDir, hostVersion, strictKnownRegistries, consentGranted, integrity, sharedFiles, execOverrides } = opts;

  const parsedPre = sourceMod.parseSpec(spec);
  const srcPre = trustMod.evaluateSourceAllowed(parsedPre, strictKnownRegistries);
  if (!srcPre.allowed) {
    return { status: 'blocked', blockReasons: [srcPre.reason ?? 'source not allowed'] };
  }

  const resolve = opts._resolve ?? sourceMod.resolveCapabilitySource;
  let resolved;
  try {
    resolved = await resolve(spec, {
      hostVersion,
      gsdHome: runtimeDir,
      integrity,
      promote: false,
      // The lifecycle owns the engines gate via checkEngines (so it can also surface a
      // compatVersions downgrade hint); the resolver must not pre-empt it by throwing.
      skipEnginesGate: true,
      execOverrides,
    });
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
  }

  const stagedDir = resolved.stagedDir;
  let committed = false;
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) {
      return { status: 'blocked', id: resolved.id, blockReasons: ['another capability operation is in progress'] };
    }
    const existing = ledgerMod.readLedger(runtimeDir);
    const prior = existing && Object.prototype.hasOwnProperty.call(existing.entries, resolved.id)
      ? existing.entries[resolved.id]
      : null;
    if (!prior) {
      return { status: 'not_installed', id: resolved.id, blockReasons: ['capability is not installed; use install'] };
    }

    const newManifest = readManifest(stagedDir);
    if (newManifest === null) {
      return { status: 'blocked', blockReasons: ['staged capability.json is missing or invalid'] };
    }

    const verdict = trustMod.evaluateInstallTrust({
      parsed: parsedPre,
      manifest: newManifest,
      stagedDir,
      strictKnownRegistries,
      hostVersion,
    });
    if (!verdict.allowed) {
      return { status: 'blocked', disclosure: verdict.disclosure, blockReasons: verdict.blockReasons };
    }

    // Re-consent only when the executable surface set changed between versions.
    const finalDir = capDir(runtimeDir, resolved.id);
    const oldManifest = readManifest(finalDir) ?? {};
    const oldDisclosure = trustMod.discloseExecutableSurfaces(oldManifest);
    if (trustMod.executableSetChanged(oldDisclosure, verdict.disclosure) && !consentGranted) {
      return { status: 'aborted', disclosure: verdict.disclosure, requiresConsent: true };
    }

    const files = sharedFiles ?? [];
    // Every shared file that EITHER the old or the new version touches must be cleaned on a
    // rollback, so a crash mid-swap can never strand the new version's executable config.
    const candidateFiles = Array.from(new Set([
      ...(Array.isArray(prior.sharedEdits) ? prior.sharedEdits.map((e) => e.file) : []),
      ...files,
    ]));

    // INTENT: record the in-flight upgrade BEFORE touching the filesystem. Its presence — not a
    // version comparison — is the commit signal reconcile uses (Codex R1 H3).
    const backupName = `${resolved.id}.upgrading-${process.pid}-${Date.now()}`;
    ledgerMod.recordInstall(runtimeDir, { ...prior, _pending: { kind: 'upgrade', backupName, sharedFiles: candidateFiles } });

    let backupDir: string | null = null;
    try {
      // Atomic swap: old -> backup(backupName), new -> live.
      ({ backupDir } = promoteStagingToFinal(stagedDir, finalDir, backupName));

      // Re-derive shared edits across ALL candidate files: strip old marker entries, apply new.
      const sharedEdits = reapplyCapabilitySharedEdits({ runtimeDir, capId: resolved.id, stripFiles: candidateFiles, applyFiles: files, manifest: newManifest });

      // COMMIT: rewrite the entry WITHOUT _pendingUpgrade. Clearing the intent IS the commit.
      const relCapDir = path.relative(runtimeDir, finalDir);
      ledgerMod.recordInstall(runtimeDir, {
        id: resolved.id,
        version: resolved.version,
        source: resolved.source,
        integrity: resolved.integrity ?? '',
        files: [relCapDir],
        sharedEdits,
      });
      committed = true;
    } catch (err) {
      // Swap/commit failed mid-flight; the intent remains in the ledger so reconcile can recover.
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    } finally {
      // Drop the backup ONLY after a successful commit; on failure leave it for reconcile.
      if (committed && backupDir) {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }

    return { status: 'upgraded', id: resolved.id, fromVersion: prior.version, toVersion: resolved.version, disclosure: verdict.disclosure };
  } finally {
    try { if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

interface RemoveResult {
  status: 'removed' | 'not_installed' | 'blocked';
  id: string;
  strippedEdits?: number;
  removedFiles?: string[];
  dataPreserved?: boolean;
  blockReasons?: string[];
}

/**
 * Remove an installed capability: strip exactly its marker-owned shared-config entries, delete
 * exactly the ledger-recorded files, then drop the ledger entry (commit point). Idempotent.
 * CAPABILITY_DATA is preserved unless opts.removeData is set.
 */
function removeCapability(id: string, opts: LifecycleOptions): RemoveResult {
  const { runtimeDir, removeData } = opts;
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) return { status: 'blocked', id, blockReasons: ['another capability operation is in progress'] };
    const ledger = ledgerMod.readLedger(runtimeDir);
    const entry = ledger && Object.prototype.hasOwnProperty.call(ledger.entries, id) ? ledger.entries[id] : null;
    if (!entry) return { status: 'not_installed', id };

    // 1. Surgically strip capability-owned shared-config entries (user edits untouched).
    const strippedEdits = stripCapabilitySharedEdits({
      runtimeDir,
      capId: id,
      sharedEdits: Array.isArray(entry.sharedEdits) ? entry.sharedEdits : [],
    });

    // 2. Delete exactly the ledger-recorded files (guarded to under runtimeDir).
    const removedFiles: string[] = [];
    for (const f of Array.isArray(entry.files) ? entry.files : []) {
      if (typeof f === 'string' && safeRmUnder(runtimeDir, f)) removedFiles.push(f);
    }

    // 3. CAPABILITY_DATA: preserved unless explicitly requested.
    if (removeData) safeRmUnder(runtimeDir, path.relative(runtimeDir, capDataDir(runtimeDir, id)));

    // 4. Ledger commit point — entry no longer referenced.
    ledgerMod.removeEntry(runtimeDir, id);

    return { status: 'removed', id, strippedEdits, removedFiles, dataPreserved: !removeData };
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (crash recovery)
// ---------------------------------------------------------------------------

interface ReconcileReport {
  rolledBack: string[];
  rolledForward: string[];
  orphansRemoved: string[];
  ledger: unknown;
}

/** Backup-dir name shape; the id segment is kebab-case so no traversal is possible. */
const BACKUP_NAME_RE = /^[a-z][a-z0-9-]*\.upgrading-\d+-\d+$/;

/** A backup name is trustworthy for `id` only if it is well-formed AND names that exact id. */
function backupNameMatchesId(name: unknown, id: string): name is string {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name) && name.startsWith(id + '.upgrading-');
}

/**
 * Recover from a crashed install/upgrade and clean staging orphans. The commit signal is the
 * ledger entry's `_pending` INTENT — never a version comparison (a same-version malicious bundle
 * must not read as committed; Codex R1 H3). Holds the mutation lock so a concurrent in-flight
 * operation's just-written intent is never cleared mid-flight (Codex R2 H2); if the lock is held,
 * reconcile defers to that operation and no-ops.
 *
 *   - `_pending.kind === 'upgrade'` (or reinstall): the op did NOT commit -> ROLL BACK by restoring
 *     the backup over the live (possibly new, uncommitted) dir, re-syncing shared config from the
 *     restored OLD bundle, and clearing the intent. The intent is cleared ONLY if the restore
 *     succeeded (Codex R2 M4) so a failed recovery is retried, never silently committed.
 *   - `_pending.kind === 'install'` (fresh): the install did NOT commit -> remove the half-installed
 *     dir + its shared edits + the ledger entry entirely.
 *   - Leftover `<id>.upgrading-*` backups with NO live intent: the op committed -> drop the backup.
 *
 * The post-recovery state is always fully-old or fully-new — never a half-state.
 */
function reconcileCapabilities(opts: { runtimeDir: string }): ReconcileReport {
  const { runtimeDir } = opts;
  const report: ReconcileReport = { rolledBack: [], rolledForward: [], orphansRemoved: [], ledger: null };
  const root = capabilitiesRoot(runtimeDir);

  const lock = acquireLock(runtimeDir);
  if (!lock) return report; // another op is in flight and will reconcile itself.
  try {
    // --- Step 1: resolve uncommitted operations flagged by the intent. ---
    let ledger = ledgerMod.readLedger(runtimeDir);
    if (ledger) {
      for (const id of Object.keys(ledger.entries)) {
        // Reject a tampered ledger key: a non-kebab id (e.g. one containing `../`) must never reach
        // capDir()/safeRmUnder() (Codex R3 M5). Leave it in place for ledger.reconcile to report.
        if (!KEBAB_ID_RE.test(id)) continue;
        const entry = ledger.entries[id];
        const pending = entry._pending;
        if (!pending) continue;
        // Candidate shared files: the intent's list UNION the entry's recorded files, so a
        // tampered/missing `sharedFiles` still cleans the genuinely-touched files (Codex R2 M5).
        const candidateFiles = Array.from(new Set([
          ...(Array.isArray(pending.sharedFiles) ? pending.sharedFiles : []),
          ...(Array.isArray(entry.sharedEdits) ? entry.sharedEdits.map((e) => e.file) : []),
        ]));
        const finalDir = capDir(runtimeDir, id);

        if (pending.kind === 'install') {
          // Uncommitted FRESH install -> remove dir + shared edits + the half-installed entry.
          stripCapabilitySharedEdits({ runtimeDir, capId: id, sharedEdits: candidateFiles.map((file) => ({ file, marker: id })) });
          // Only drop the entry once the dir is actually gone (safeRmUnder returns true when the
          // dir is already absent). If the delete genuinely FAILS (e.g. EPERM), keep `_pending` so
          // the next run retries — never orphan the dir with no recovery signal (code-review H).
          if (!safeRmUnder(runtimeDir, path.relative(runtimeDir, finalDir))) continue;
          ledgerMod.removeEntry(runtimeDir, id);
          report.rolledBack.push(id);
          continue;
        }

        // Uncommitted UPGRADE/reinstall. A kind 'upgrade' intent ALWAYS carries a well-formed
        // backupName naming this id; if it does not, the intent is tampered/corrupt — fail CLOSED
        // (leave it pending for manual handling) rather than silently accepting the live dir
        // (Codex R3 M6).
        if (!backupNameMatchesId(pending.backupName, id)) continue;
        const backupDir = path.join(root, pending.backupName);
        let restored: boolean;
        if (fs.existsSync(backupDir)) {
          try {
            fs.rmSync(finalDir, { recursive: true, force: true });
            fs.renameSync(backupDir, finalDir);
            restored = true;
          } catch {
            restored = false; // restore failed — leave the intent for a later retry.
          }
        } else if (fs.existsSync(finalDir)) {
          // Backup absent with a valid pointer: the swap never started, so the OLD bundle is live.
          restored = true;
        } else {
          // BOTH the backup and the live dir are gone (external deletion of both) — the bundle no
          // longer exists. Self-heal as a clean uninstall (strip + drop the entry) rather than
          // looping on a never-satisfiable restore (code-review M).
          stripCapabilitySharedEdits({ runtimeDir, capId: id, sharedEdits: candidateFiles.map((file) => ({ file, marker: id })) });
          ledgerMod.removeEntry(runtimeDir, id);
          report.rolledBack.push(id);
          continue;
        }

        if (!restored) continue; // keep `_pending` so recovery is retried, never silently committed.

        const refreshed = resyncCapabilitySharedEdits({ runtimeDir, capId: id, sharedFiles: candidateFiles });
        const cleared: LedgerEntry = { ...entry, sharedEdits: refreshed };
        delete cleared._pending;
        ledgerMod.recordInstall(runtimeDir, cleared);
        report.rolledBack.push(id);
      }
      ledger = ledgerMod.readLedger(runtimeDir);
    }

    // --- Step 2: sweep leftover backups (committed ops) + staging orphans. ---
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      try { report.ledger = ledgerMod.reconcile(runtimeDir); } catch { /* best-effort */ }
      return report;
    }

    for (const name of entries) {
      const m = /^(.+)\.upgrading-\d+-\d+$/.exec(name);
      if (!m) continue;
      const id = m[1];
      // If a pending intent still references this backup, step 1 left it (failed restore) — keep it.
      const entry = ledger && Object.prototype.hasOwnProperty.call(ledger.entries, id) ? ledger.entries[id] : null;
      if (entry && entry._pending && entry._pending.backupName === name) continue;
      // No live intent => the op committed (apply ran before commit) — drop the stale backup.
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        report.rolledForward.push(id);
      } catch { /* best-effort */ }
    }

    // Clean staging orphans — but spare recently-created dirs, which may belong to an in-flight
    // resolve that has not yet acquired this lock (resolve stages BEFORE locking; Codex R3 M7).
    const stagingRoot = path.join(root, '.staging');
    try {
      const now = Date.now();
      for (const s of fs.readdirSync(stagingRoot)) {
        const p = path.join(stagingRoot, s);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs <= STAGING_ORPHAN_MS) continue; // too fresh — could be live
          fs.rmSync(p, { recursive: true, force: true });
          report.orphansRemoved.push(s);
        } catch { /* best-effort */ }
      }
    } catch { /* no staging dir */ }

    try { report.ledger = ledgerMod.reconcile(runtimeDir); } catch { /* best-effort */ }
    return report;
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  installCapability,
  upgradeCapability,
  removeCapability,
  reconcileCapabilities,
  applyCapabilitySharedEdits,
  stripCapabilitySharedEdits,
  CAP_MARKER,
};

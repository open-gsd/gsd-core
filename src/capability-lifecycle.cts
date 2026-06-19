/**
 * Capability lifecycle orchestration — ADR-1244 Phase 4 (D5 trust enforcement + D6 upgrade).
 *
 * Composes the Phase-3 source resolver + ledger with the Phase-4 trust gate into the three
 * mutating operations — install, upgrade, remove — plus a reconciliation sweep that recovers
 * from a crash mid-upgrade. The LEDGER WRITE is the commit point for every operation: a crash
 * before it leaves the prior state fully intact; a crash after it is a completed operation.
 *
 * Trust invariants enforced here (see docs/explanation/capability-trust-model.md):
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
import crypto from 'node:crypto';
import os from 'node:os';

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
  readLedgerStrict: (runtimeDir: string) => LedgerFile | null;
  writeLedger: (runtimeDir: string, ledger: LedgerFile) => void;
  recordInstall: (runtimeDir: string, entry: LedgerEntry, opts?: { baseLedger?: LedgerFile | null }) => void;
  removeEntry: (runtimeDir: string, capId: string) => boolean;
  reconcile: (runtimeDir: string) => unknown;
  isUnsafeCapabilityId: (id: unknown) => boolean;
  CorruptLedgerError: new (message: string, ledgerPath: string) => Error & { ledgerPath: string };
  LEDGER_FILE_NAME: string;
  MAX_SHARED_FILES: number;
  // Finding 2 (HIGH): the shared fd-based bounded reader. Returns the content, null for ENOENT, or
  // THROWS for a non-regular (FIFO/device/dir) / oversized / IO-error file (fail closed).
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
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
const { platformWriteSync, execTool } = require('./shell-command-projection.cjs') as {
  platformWriteSync: (filePath: string, content: string) => void;
  execTool: (
    program: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => { exitCode: number; stdout: string; stderr: string; signal: NodeJS.Signals | null; error: Error | null };
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
   * When set, the resolved capability id MUST equal this or the operation is refused with NO writes.
   * `gsd capability update <id>` passes the requested id so a source that has been retargeted or
   * hand-edited to a different manifest id cannot silently act on (and overwrite) another capability.
   */
  expectedId?: string;
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

/** Errnos from a directory fsync that are tolerated (platforms/filesystems disallowing dir fsync). */
const DIR_FSYNC_TOLERATED_ERRNOS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF']);

/**
 * fsync a DIRECTORY so a rename inside it is durable across a power loss (DUR-2/DUR-3). Some
 * platforms/filesystems disallow fsync on a directory fd (EISDIR/EPERM/EINVAL/EBADF) — those are
 * tolerated (best-effort, swallowed). Finding 4: any OTHER errno (e.g. EIO — a real storage error)
 * is RETHROWN as a clear durability-uncertain error rather than silently swallowed; the rename may
 * already be visible, so the caller must NOT claim success when durability could not be confirmed.
 * The directory fd is always closed (finally).
 */
function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // openSync itself failing (e.g. dir vanished) is also non-fatal best-effort UNLESS it's a real
    // storage error; treat tolerated errnos (and a missing code) as best-effort, rethrow the rest.
    if (code !== undefined && !DIR_FSYNC_TOLERATED_ERRNOS.has(code)) {
      throw new Error(
        `Directory fsync of "${dirPath}" failed (${code}); durability of the preceding rename ` +
        `could NOT be confirmed: ${(err as Error).message}`,
      );
    }
    /* tolerated errno (or no code) — best-effort: a missing dir-fsync only weakens durability */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

/**
 * Build a collision-resistant backup-dir name for `id` (CONC-3). Two processes upgrading the same
 * capability in the same millisecond would otherwise produce identical `<id>.upgrading-<pid>-<ts>`
 * names; the random nonce eliminates that collision. The name still matches BACKUP_NAME_RE so a
 * recorded intent can find the backup after a crash.
 */
function newBackupName(id: string): string {
  return `${id}.upgrading-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Cross-process mutual exclusion
// ---------------------------------------------------------------------------

/**
 * A lock older than this is a CANDIDATE for stealing (the holder may have crashed). A same-host
 * lock past this age whose recorded pid is DEAD is stolen immediately (fast local recovery).
 */
const LOCK_STALE_MS = 60_000;
/**
 * HARD deadman timeout (finding 1). A lock older than this is stolen REGARDLESS of pid liveness or
 * host. This is the only thing that can break a permanent deadlock caused by:
 *   - PID REUSE: a crashed holder's pid reused by an unrelated long-lived process makes
 *     `isPidAlive` return true forever, so the dead-pid fast-recovery branch never fires.
 *   - CROSS-HOST (NFS): a remote holder's pid is meaningless to local `process.kill(pid,0)`, so
 *     liveness cannot be judged at all — only the deadman can reclaim such a lock.
 * Much larger than LOCK_STALE_MS so a genuinely slow-but-live SAME-host holder is given a wide grace
 * window (it is protected by the same-host liveness check until then); 10 minutes is far longer than
 * any real sub-second capability fs critical section.
 */
const LOCK_DEADMAN_MS = 600_000;
/** A `.staging/*` dir younger than this may belong to an in-flight resolve; do not sweep it. */
const STAGING_ORPHAN_MS = 600_000;
/** A `.gsd-capabilities.json.tmp.*` temp younger than this may belong to an in-flight write; spare it (W-3/DUR-5). */
const LEDGER_TMP_ORPHAN_MS = 300_000;
/** Valid capability id (kebab-case). Used to reject tampered ledger keys before acting on them. */
const KEBAB_ID_RE = /^[a-z][a-z0-9-]*$/;
/**
 * Finding 2 (HIGH): the lockfile body is UNTRUSTED content. A well-formed lock body is a tiny JSON
 * object (a few hundred bytes at most). The body is read via the shared fd-based bounded reader
 * (ledgerMod.readSmallRegularFile): open → fstat → require a REGULAR file (reject FIFO/device/dir,
 * which could block/read-unbounded) → enforce this size cap on the fstat → read exactly size bytes.
 * A non-regular/oversized body is treated as UNPARSEABLE (no pid/host) → routed to the deadman policy
 * (cannot verify liveness → steal only after the deadman). 64 KiB is orders of magnitude larger than
 * any legitimate lock body.
 */
const LOCK_MAX_BODY_BYTES = 64 * 1024;

/**
 * A held lock: the lockfile path, the unique OWNER TOKEN we wrote into it, and the (dev, ino) of the
 * lockfile inode captured at acquire (finding 4). releaseLock re-confirms BOTH the token AND the
 * captured dev/ino still match the path on disk immediately before rmSync, so a successor lock that
 * replaced ours at the same path (different inode) is never deleted. dev/ino are null when the post-
 * create stat could not be taken (best-effort) — then release falls back to the token check alone.
 */
interface LockHandle { path: string; token: string; dev: number | null; ino: number | null; }

let _lockSeq = 0;
/**
 * A per-acquire unique token so release is owner-safe (never deletes a successor's lock). The FIRST
 * `-`-delimited segment is the holder PID — acquireLock parses it back out to check liveness before
 * stealing a stale lock (CONC-1).
 */
function newLockToken(): string {
  return `${process.pid}-${Date.now()}-${++_lockSeq}`;
}

/** Bounded steal/retry attempts so a pathological never-acquirable lock cannot recurse forever (CONC-2). */
const LOCK_MAX_ATTEMPTS = 8;
const LOCK_RETRY_BACKOFF_MS = 25;
let _lockSleepBuf: Int32Array | null = null;
function lockBackoff(): void {
  // Small jittered backoff between steal attempts (yields the thread via Atomics.wait).
  if (_lockSleepBuf === null) _lockSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  const jitter = Math.floor(Math.random() * LOCK_RETRY_BACKOFF_MS);
  Atomics.wait(_lockSleepBuf, 0, 0, LOCK_RETRY_BACKOFF_MS + jitter);
}

/**
 * Parse the holder PID from a legacy plain-token lockfile body (the first `-`-delimited segment).
 * Returns null when the body has no numeric leading segment (e.g. JSON content, or legacy no-pid).
 */
function lockHolderPid(body: string): number | null {
  const seg = body.split('-')[0];
  if (!/^\d+$/.test(seg)) return null;
  const pid = Number(seg);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Parsed view of a lockfile body. `hostname` is null for a legacy lock (no hostname was recorded
 * before finding 1) — a null hostname is treated as SAME-host (conservative, backward compatible:
 * legacy locks were always same-machine since the lock predates cross-host concerns). `startTime`
 * is the holder process's recorded start-time (finding 1, process-start-time liveness); null for a
 * legacy lock or one whose body did not record it — a null recorded start-time cannot be matched, so
 * liveness cannot be verified and the holder is treated as NOT verified-live (steal-eligible).
 */
interface ParsedLock { pid: number | null; hostname: string | null; startTime: string | null; ts: number | null; }

/**
 * Parse a lockfile body into { pid, hostname, startTime, ts }. The new format (finding 1) is JSON
 * `{ token, pid, hostname, startTime, ts }`; a legacy body is a plain `pid-ts-seq` token (or
 * non-numeric junk). Never throws — unparseable content yields all-null.
 *
 * Finding 1 (HIGH) — lock-steal TOCTOU: `ts` is the body's OWN recorded timestamp. The age decision
 * is bound to `now - ts` (a FRESH replacement body carries a FRESH ts → small age → not stolen), NOT
 * to the file `mtime` (which a stale-old `mtime` on a freshly-replaced body would mis-report). `ts` is
 * also the per-body identity re-checked immediately before the atomic rename-steal. A legacy/no-`ts`
 * body yields ts:null and the caller falls back to the file `mtime` age.
 */
function parseLockBody(body: string): ParsedLock {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed as Record<string, unknown>;
        const pidVal = p['pid'];
        const pid = typeof pidVal === 'number' && Number.isInteger(pidVal) && pidVal > 0 ? pidVal : null;
        const hostVal = p['hostname'];
        const hostname = typeof hostVal === 'string' && hostVal ? hostVal : null;
        const stVal = p['startTime'];
        const startTime = typeof stVal === 'string' && stVal ? stVal : null;
        const tsVal = p['ts'];
        const ts = typeof tsVal === 'number' && Number.isFinite(tsVal) ? tsVal : null;
        return { pid, hostname, startTime, ts };
      }
    } catch { /* fall through to legacy parse */ }
  }
  // Legacy plain-token body: hostname/startTime/ts were never recorded → null (treated as same-host,
  // unverifiable liveness, mtime-age fallback).
  return { pid: lockHolderPid(trimmed), hostname: null, startTime: null, ts: null };
}

/**
 * Finding 1 (HIGH) — future/implausible `ts` deadlock. Derive the lock AGE (ms) from the body's own
 * `ts` when that ts is TRUSTWORTHY, else fall back to the file `mtime`. A `ts` is distrusted when it is
 * in the FUTURE (now - ts < 0 — a planted body or a clock-skewed/back-stepped writer) or implausibly
 * far in the future (small forward skew is tolerated, but a `ts` more than the deadman ahead of now is
 * nonsense). A trusted future `ts` would keep `age = now - ts <= LOCK_STALE_MS` forever, so the lock
 * would never become stale/deadman/steal-eligible → permanent block. Falling back to `mtime` keeps
 * stale/deadman recovery working (a future mtime is far less likely, and the deadman still bounds it).
 * A null `ts` (legacy/garbage/no-ts body) also uses the `mtime` age.
 */
function lockAgeMs(ts: number | null, mtimeMs: number): number {
  if (ts !== null) {
    const age = Date.now() - ts;
    // Trust the body ts ONLY when it is not in the future and not implausibly far ahead. A small
    // forward clock skew (age slightly negative) is rejected too — any future ts is distrusted.
    if (age >= 0 && age <= Number.MAX_SAFE_INTEGER) return age;
  }
  // MEDIUM finding: if mtime is ALSO in the future (planted lock, clock stepped backward after write),
  // `Date.now() - mtimeMs` is negative → age <= LOCK_STALE_MS forever → permanent deadlock. A mtime
  // MORE than LOCK_STALE_MS / 2 in the future is untrustworthy (planted or a significant clock step);
  // return MAX_SAFE_INTEGER so the lock routes into the normal steal decision tree (verified-live
  // same-host holders are still protected there — that check is age-independent). A small negative
  // (sub-second jitter from filesystem timestamp precision) is clamped to 0 (treat as brand-new / fresh)
  // rather than MAX_SAFE_INTEGER, so a lock written and immediately stat'd is never mis-stolen.
  const mtimeAge = Date.now() - mtimeMs;
  if (mtimeAge >= 0) return mtimeAge;
  // mtimeAge is negative → mtime is in the future. Small jitter (within LOCK_STALE_MS / 2, i.e. 30s)
  // → clamp to 0 (fresh, conservative). Large future (> 30s) → untrustworthy → MAX_SAFE_INTEGER.
  return mtimeAge >= -(LOCK_STALE_MS / 2) ? 0 : Number.MAX_SAFE_INTEGER;
}

/** Is the parsed lock from THIS host? A null (legacy) hostname is treated as same-host. */
function isSameHost(parsed: ParsedLock): boolean {
  return parsed.hostname === null || parsed.hostname === os.hostname();
}

/**
 * Best-effort process start-time for `pid`, as an OPAQUE platform-specific string used ONLY for
 * equality comparison (never parsed as a date). The pair (pid, startTime) uniquely identifies a
 * process instance: even if a crashed holder's pid is REUSED by an unrelated process, the new
 * process's start-time differs, so a recorded start-time that no longer matches proves pid-reuse.
 *
 * Platform handling (all bounded — the shell-outs only run on the rare STEAL-decision path, never the
 * happy path):
 *   - Linux: read `/proc/<pid>/stat` field 22 (starttime, in clock ticks since boot). No shell-out.
 *     Field 2 (comm) may contain spaces/parens, so we split AFTER the last ')' to index reliably.
 *   - macOS/other POSIX: `ps -p <pid> -o lstart=` via the bounded execTool seam (process start
 *     wall-clock; stable for a given live process).
 *   - Windows: PowerShell `(Get-Process -Id <pid>).StartTime.Ticks` via the bounded execTool seam.
 * Returns null on ANY error / unobtainable value — a null observed start-time means liveness cannot
 * be VERIFIED (so the holder is treated as not-verified-live → steal-eligible past the deadman).
 */
function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      // Field 22 is `starttime`. comm (field 2) is wrapped in parens and may itself contain spaces
      // and ')'; everything after the LAST ')' is space-delimited and stable to index.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen === -1) return null;
      const rest = stat.slice(rparen + 1).trim().split(/\s+/);
      // After comm, fields are state(0) ppid(1) ... starttime is field 22 overall → index 19 of rest.
      const starttime = rest[19];
      return typeof starttime === 'string' && /^\d+$/.test(starttime) ? starttime : null;
    }
    if (process.platform === 'win32') {
      const res = execTool(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.Ticks`],
        { timeout: 5_000 },
      );
      if (res.exitCode !== 0 || res.error) return null;
      const out = res.stdout.trim();
      return /^\d+$/.test(out) ? out : null;
    }
    // macOS and other POSIX: ps lstart is the process's start wall-clock (stable per live process).
    const res = execTool('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000 });
    if (res.exitCode !== 0 || res.error) return null;
    const out = res.stdout.trim();
    return out ? out : null;
  } catch {
    return null;
  }
}

/**
 * THIS process's start-time, captured ONCE at module load so we never re-shell on every lock write
 * (the happy path stamps it from this cached value). Best-effort — null if unobtainable here.
 */
const _selfStartTime: string | null = getProcessStartTime(process.pid);

/**
 * Serialize the lockfile body (finding 1): JSON carrying the owner token, pid, hostname, this
 * process's cached start-time, and a timestamp. startTime lets a later acquirer verify the recorded
 * holder is still the SAME process instance (defeats pid-reuse) without ever re-shelling here.
 */
function lockFileBody(token: string): string {
  return JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), startTime: _selfStartTime, ts: Date.now() });
}

/**
 * Test seams (finding 1): the steal-decision path goes through these indirections so unit tests can
 * mock liveness + process start-time DETERMINISTICALLY (without depending on real OS pids beyond the
 * current process). The defaults are the real implementations. `_setLockProbes`/`_resetLockProbes`
 * are exported for tests ONLY — they are not part of the CLI surface.
 */
const _lockProbes: {
  isPidAlive: (pid: number) => boolean;
  getProcessStartTime: (pid: number) => string | null;
} = { isPidAlive: _realIsPidAlive, getProcessStartTime };

/** Is `pid` a live process? `process.kill(pid, 0)` succeeds for a live (signalable) process. */
function _realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    // EPERM means the process exists but we cannot signal it (still ALIVE). ESRCH means it's gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isPidAlive(pid: number): boolean {
  return _lockProbes.isPidAlive(pid);
}

/**
 * Finding 2 (HIGH): parse the lockfile body via the SHARED fd-based bounded reader. The body is
 * untrusted: a FIFO/device/symlink-to-device `.lock` (or a swapped/grown file) would block or read
 * unbounded under a path-`stat`+`readFileSync`; an oversized/garbage body is a memory DoS. The
 * shared reader (open → fstat → require regular file → size cap → read exactly size) returns null for
 * a non-regular/oversized/IO body (it throws → we swallow), routing the holder to the deadman policy
 * (no verifiable pid/host/startTime → steal only after the deadman). A normal small body is read and
 * parsed. Never throws.
 */
function readParsedLockBounded(lockPath: string): ParsedLock {
  const allNull: ParsedLock = { pid: null, hostname: null, startTime: null, ts: null };
  try {
    const body = ledgerMod.readSmallRegularFile(lockPath, LOCK_MAX_BODY_BYTES);
    if (body === null) return allNull; // vanished/missing — cannot verify anything.
    return parseLockBody(body);
  } catch {
    // Non-regular (FIFO/device/dir), oversized, or unreadable untrusted body → unparseable.
    return allNull;
  }
}

/**
 * Finding 1 (HIGH): the per-body IDENTITY used to confirm, immediately before the atomic rename-steal,
 * that the lock A decided to steal is STILL the same body instance (B did not replace it). Binds
 * (dev, ino) from a fresh stat AND the body's own `ts` (when JSON). A null on any field means we could
 * not read it (vanished/non-regular/oversized) — the caller treats that as "changed" and retries
 * rather than stealing. Never throws.
 */
interface LockIdentity { dev: number | null; ino: number | null; ts: number | null; }
function lockIdentity(lockPath: string): LockIdentity {
  let dev: number | null = null;
  let ino: number | null = null;
  try {
    const st = fs.statSync(lockPath);
    dev = typeof st.dev === 'number' ? st.dev : null;
    ino = typeof st.ino === 'number' ? st.ino : null;
  } catch {
    return { dev: null, ino: null, ts: null }; // vanished/unstatable — treat as changed.
  }
  // ts comes from the (bounded) body; null for a legacy/no-ts body — then only dev/ino gate the steal.
  const ts = readParsedLockBounded(lockPath).ts;
  return { dev, ino, ts };
}

/**
 * Two lock identities refer to the SAME body instance only when dev AND ino match AND the `ts` is
 * unchanged. A null dev/ino on EITHER side (unreadable/vanished) is treated as a CHANGE (fail-safe:
 * do not steal). A null `ts` on BOTH sides (legacy bodies) does not block the match — dev/ino carry it.
 *
 * Finding 3 (LOW): if the DECISION body (a) had a non-null JSON `ts`, the recheck body (b) MUST carry
 * the SAME non-null `ts`. A recheck `ts` that is now null/absent (the body was rewritten to no-ts or
 * garbage on the same inode) is NOT the same instance — treating it as "same" would contradict the
 * "ts re-confirmed before steal" invariant and let A steal a body it can no longer identify. So a
 * disappearing ts (a.ts !== null && b.ts === null) is a CHANGE → do not steal, retry.
 */
function sameLockInstance(a: LockIdentity, b: LockIdentity): boolean {
  if (a.dev === null || a.ino === null || b.dev === null || b.ino === null) return false;
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  // If the decision body recorded a ts, it must STILL be present AND unchanged on recheck. A fresh
  // replacement body carries a fresh ts (mismatch); a no-ts/garbage rewrite drops it (now null) —
  // either way the body changed under us → not the same instance.
  if (a.ts !== null && a.ts !== b.ts) return false;
  return true;
}

/**
 * Is the recorded SAME-host holder VERIFIED-LIVE (finding 1, process-start-time)? True ONLY when ALL
 * hold: the pid signals alive AND the lock recorded a non-null start-time AND the pid's CURRENT
 * observed start-time matches that recorded value. Any failure — dead pid, no recorded start-time,
 * unobtainable current start-time, or a MISMATCH (= pid-reuse: the pid is alive but belongs to a
 * different process instance now) — means NOT verified-live, so the holder may be stolen. This is the
 * crux that defeats pid-reuse WITHOUT ever stealing a genuinely-live holder.
 */
function holderVerifiedLive(parsed: ParsedLock): boolean {
  if (parsed.pid === null) return false;
  if (!isPidAlive(parsed.pid)) return false;
  if (parsed.startTime === null) return false;
  const observed = _lockProbes.getProcessStartTime(parsed.pid);
  if (observed === null) return false;
  return observed === parsed.startTime;
}

/**
 * Acquire an exclusive capability-mutation lock (a single lockfile created with O_EXCL), stamping
 * a JSON body that records a unique owner token, our PID, our HOSTNAME, our process START-TIME, and a
 * timestamp. Returns a LockHandle on success, or null if another LIVE operation holds it.
 *
 * Steal protocol (finding 1 — process-start-time liveness; never deadlocks AND never steals a
 * verified-live SAME-host holder). The age is bound to the BODY instance A acts on — `age = now -
 * body.ts` for a JSON body (a fresh replacement body carries a fresh ts), falling back to `now -
 * mtime` for a legacy/no-`ts` body — and the (dev, ino, ts) identity is re-confirmed immediately
 * before the rename so A can never steal a fresh lock B swapped in mid-decision (lock-steal TOCTOU):
 *   - age <= LOCK_STALE_MS                         → FRESH: never stolen (genuinely held → blocked).
 *   - age >  LOCK_STALE_MS:
 *       · SAME host: compute live = pid alive AND recorded startTime present AND observed
 *         startTime === recorded startTime. If VERIFIED-LIVE → NEVER steal (blocked) — even past the
 *         deadman; a provably-live holder is sacrosanct. If NOT verified-live (pid dead, start-time
 *         mismatch = pid-reuse, or start-time unobtainable) → STEAL (fast local recovery).
 *       · DIFFERENT host, or no parseable pid (legacy/oversized/garbage body) → liveness cannot be
 *         verified at all → steal ONLY after age > LOCK_DEADMAN_MS (the deadman fallback). Under the
 *         deadman such a lock is left in place (blocked).
 *
 * Why this is the convergent design: an age-only rule lost-updates a live holder; a pid-liveness rule
 * deadlocks forever on pid-reuse (a reused pid looks alive); a deadman rule can steal a live holder
 * before the deadman. The (pid, start-time) pair uniquely identifies a process INSTANCE, so a reused
 * pid is detected as a start-time MISMATCH and stolen, while a verified-live holder is never stolen.
 *
 * The steal itself is atomic (rename-then-recreate, so only ONE racing process can rename the
 * inode), and the whole thing is a BOUNDED iterative loop (CONC-2/DOS-1) — no unbounded recursion.
 */
function acquireLock(runtimeDir: string): LockHandle | null {
  const root = capabilitiesRoot(runtimeDir);
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best-effort */ }
  const lockPath = path.join(root, '.lock');

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    const token = newLockToken();
    try {
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create — fails if held
      // Finding 3 (LOW): once the exclusive create SUCCEEDS, a writeSync/closeSync failure must NOT
      // leave the empty `.lock` behind — an orphan body self-blocks every later acquirer until the
      // deadman. On any write/close error, best-effort unlink the file we just created and return null.
      // Finding 2 (MEDIUM): use fs.writeFileSync(fd, body) — its internal write-all loop flushes the
      // WHOLE buffer (no short-write), unlike a bare fs.writeSync(fd, …) which may write fewer bytes
      // and leave a malformed body whose token releaseLock can never match (orphan until the deadman).
      // Mirrors the writeLedger short-write fix.
      try {
        fs.writeFileSync(fd, lockFileBody(token));
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw writeErr;
      }
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw closeErr;
      }
      // Finding 4 (LOW): capture the lock inode's (dev, ino) so releaseLock can confirm, immediately
      // before rmSync, that the path still holds OUR inode (not a successor's) — minimizing the
      // check-then-unlink window. Best-effort: a null dev/ino just falls back to the token check.
      let dev: number | null = null;
      let ino: number | null = null;
      try {
        const lst = fs.statSync(lockPath);
        dev = typeof lst.dev === 'number' ? lst.dev : null;
        ino = typeof lst.ino === 'number' ? lst.ino : null;
      } catch { /* best-effort — release falls back to the token check alone */ }
      return { path: lockPath, token, dev, ino };
    } catch (err) {
      // EEXIST → held (fall through to the steal decision). Any other error here is either the
      // create failing for a real reason OR a write/close failure we already cleaned up → bail out.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    // Held — decide whether to steal.
    let st: fs.Stats;
    try {
      st = fs.statSync(lockPath);
    } catch {
      // Lock vanished between open and stat — retry the create immediately.
      continue;
    }

    // Finding 1 (HIGH) — bind the age decision to the SAME body instance A acts on. Parse the
    // (bounded) body ONCE; derive age from the body's own `ts` (now - ts) for a JSON body so a FRESH
    // replacement body (fresh ts) is correctly seen as fresh even if the file `mtime` is stale-old.
    // A legacy/garbage/no-`ts` body — AND a FUTURE/implausible `ts` (see lockAgeMs) — falls back to
    // the file `mtime` age so a planted/clock-skewed future ts can never deadlock the lock forever.
    const parsed = readParsedLockBounded(lockPath);
    const age = lockAgeMs(parsed.ts, st.mtimeMs);
    if (age <= LOCK_STALE_MS) return null; // genuinely held (fresh) — blocked.

    // Capture the identity (dev/ino + body ts) of the EXACT body the steal decision is made against,
    // so we can confirm it is UNCHANGED immediately before the rename-steal (finding 1).
    const decisionIdentity: LockIdentity = {
      dev: typeof st.dev === 'number' ? st.dev : null,
      ino: typeof st.ino === 'number' ? st.ino : null,
      ts: parsed.ts,
    };

    if (isSameHost(parsed) && parsed.pid !== null) {
      // SAME host with a parseable pid → we CAN verify liveness via the (pid, start-time) pair.
      // A VERIFIED-LIVE holder is NEVER stolen — even past the deadman. Otherwise (dead pid,
      // start-time mismatch = pid-reuse, or start-time unobtainable) → steal (fast local recovery).
      if (holderVerifiedLive(parsed)) return null; // provably-live same-host holder — blocked.
      // else fall through to the atomic steal.
    } else {
      // DIFFERENT host, or no parseable pid (legacy / oversized / garbage body) → liveness cannot be
      // verified locally. Only the deadman can reclaim it; under the deadman, leave it (blocked).
      if (age <= LOCK_DEADMAN_MS) return null;
      // else (age > deadman) → fall through to the atomic steal.
    }

    // Finding 1 (HIGH): re-stat + re-read the body IMMEDIATELY before the rename and confirm it is the
    // SAME instance (dev/ino unchanged AND, for a JSON body, ts unchanged). If B stole+recreated a
    // FRESH lock between A's decision and now, the identity differs → do NOT steal B's fresh lock;
    // RETRY the bounded loop instead. The rename itself remains the atomic single-winner.
    if (!sameLockInstance(decisionIdentity, lockIdentity(lockPath))) {
      if (attempt + 1 < LOCK_MAX_ATTEMPTS) lockBackoff();
      continue; // the body changed under us — re-evaluate from scratch rather than steal a replacement.
    }

    // Steal atomically (only one racer can rename the inode).
    const stolen = `${lockPath}.stale-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lockPath, stolen); } catch { return null; } // another process won the steal
    try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
    // Loop and retry the create (bounded — no recursion, CONC-2). Brief backoff to de-sync racers.
    if (attempt + 1 < LOCK_MAX_ATTEMPTS) lockBackoff();
  }
  return null; // attempt budget exhausted (pathological contention) — never throws/recurses.
}

/**
 * Release a lock only if it still carries our owner token (PRIMARY discriminator) — and, as a best-
 * effort SECONDARY check, if its inode still matches the (dev, ino) we captured at acquire (finding 4),
 * so the common path never deletes a lock that was stale-stolen out from under us.
 *
 * The TOKEN re-check is what actually protects a successor: a real successor wrote a DIFFERENT owner
 * token, so we read a non-matching token and refuse to delete — this holds on every filesystem. The
 * dev/ino recheck is only a best-effort secondary guard: it may be DEFEATED by inode reuse on some
 * filesystems (e.g. Linux ext4/overlay reusing the freed inode after a successor's unlink+recreate at
 * the same path), so correctness does NOT depend on it. We keep it as harmless extra hardening (it can
 * catch a same-token reuse edge), but the token check is the load-bearing invariant.
 *
 * Residual (finding 4 — minimized, honestly stated): a check-then-unlink window remains between the
 * final token+inode recheck and the rmSync. This is the IRREDUCIBLE final-instruction window of any
 * path-based lock without native OS advisory locking (flock), which GSD avoids (no native deps). The
 * token+inode recheck shrinks the window to that last instruction: a successor must replace BOTH the
 * token and the inode within it to be wrongly deleted, and that is only REACHABLE when a holder is
 * BOTH stale (>LOCK_STALE_MS) AND still alive to call release — a live process frozen >60s mid sub-
 * second fs critical section (a crashed holder never calls release; a normal holder finishes in ms).
 * A rename-claim variant was tried but merely moves the same window (the restore step can clobber a
 * third acquirer — Codex R6). This lock is same-user, same-machine DEFENSE-IN-DEPTH; it is NOT the
 * trust barrier (that is consent + integrity + reversibility, see the trust-model doc), and the
 * residual crosses no privilege boundary — the same disposition accepted for safeRmUnder's parent TOCTOU.
 */
function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  try {
    // Finding 2 (HIGH): the lock body is untrusted — read it via the shared fd-based bounded reader
    // (regular-file + size cap). A FIFO/device/oversized/non-regular body at handle.path cannot be
    // ours (our writes are tiny regular-file JSON), so it is simply not released by us (left for the
    // deadman / its real owner) — and a FIFO can never block release. Null means gone/non-regular →
    // nothing of ours to release.
    let body: string | null;
    try {
      body = ledgerMod.readSmallRegularFile(handle.path, LOCK_MAX_BODY_BYTES);
    } catch {
      return; // non-regular / oversized / unreadable → not ours; do not read or delete.
    }
    if (body === null) return; // gone / missing — nothing of ours to release.
    // The body is now JSON `{ token, pid, hostname, startTime, ts }` (finding 1); release only if the
    // recorded token is still OURS. A legacy plain-token body (whole body === token) is also honored
    // so an in-flight handle written by an older build can still be released.
    if (lockBodyToken(body) !== handle.token && body !== handle.token) return; // not our token (PRIMARY).
    // Finding 4 (LOW): best-effort SECONDARY guard — re-stat the path IMMEDIATELY before rmSync and, if
    // we captured an inode at acquire, confirm it is STILL ours (the dev/ino captured at acquire). A
    // successor recreated at the same path MAY have a different inode → then do NOT delete it. This is
    // only a window-minimizer, NOT the correctness invariant: inode reuse on some filesystems (Linux
    // ext4/overlay after a successor's unlink+recreate) can make the inode match again, so the TOKEN
    // check above is the load-bearing protection. When we captured no inode (best-effort null), the
    // token check alone gated the delete.
    if (handle.dev !== null && handle.ino !== null) {
      let cur: fs.Stats;
      try {
        cur = fs.statSync(handle.path);
      } catch {
        return; // vanished/unstatable between read and rmSync → nothing of ours to release.
      }
      if (cur.dev !== handle.dev || cur.ino !== handle.ino) return; // successor inode — not ours.
    }
    fs.rmSync(handle.path, { force: true });
  } catch { /* already gone / stale-stolen / unreadable — nothing of ours to release */ }
}

/** Extract the owner token from a lockfile body (JSON `token` field), or null if not JSON/absent. */
function lockBodyToken(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as Record<string, unknown>)['token'];
      return typeof t === 'string' ? t : null;
    }
  } catch { /* not JSON */ }
  return null;
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

/**
 * Resolve a shared-config file path RELATIVE to runtimeDir, confined to the scope root by realpath
 * (mirrors safeRmUnder). Rejects absolute paths, `..`, and any relFile whose existing parent
 * directory is a symlink escaping runtimeDir — so `--shared-file evil/x.json`, where `evil` is a
 * pre-planted symlink pointing outside the scope, can never write outside it. Returns the safe
 * absolute path, or null when the path is unsafe.
 */
function confinedSharedFile(runtimeDir: string, relFile: unknown): string | null {
  if (typeof relFile !== 'string' || !relFile || path.isAbsolute(relFile) || relFile.split(/[/\\]/).includes('..')) {
    return null;
  }
  let realRoot: string;
  try { realRoot = fs.realpathSync(runtimeDir); } catch { return null; }
  const target = path.resolve(realRoot, relFile);
  const parentDir = path.dirname(target);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // Parent does not exist yet (created inside the scope on write): a non-existent path cannot be a
    // symlink escaping the root, so a lexical containment check is sufficient.
    if (parentDir !== realRoot && !parentDir.startsWith(realRoot + path.sep)) return null;
    return target;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;
  return path.join(realParent, path.basename(target));
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
  // Both finalDir and the backup share this parent; fsyncing it makes each rename durable (DUR-3).
  const parent = path.dirname(finalDir);
  if (fs.existsSync(finalDir)) {
    const backupDir = backupName
      ? path.join(parent, backupName)
      // CONC-3: a random nonce in the unnamed-branch backup name prevents same-ms cross-process collision.
      : path.join(parent, newBackupName(path.basename(finalDir)));
    fs.renameSync(finalDir, backupDir);
    // DUR-3: fsync the parent dir so the old→backup rename is durable BEFORE the second rename —
    // a crash here must not lose the backup (the only recovery path for reconcile).
    fsyncDir(parent);
    try {
      fs.renameSync(stagingDir, finalDir);
    } catch (err) {
      try { fs.renameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
      throw err;
    }
    // DUR-3: fsync the parent dir again so the staging→final rename is durable too.
    fsyncDir(parent);
    return { backupDir };
  }
  fs.mkdirSync(parent, { recursive: true });
  fs.renameSync(stagingDir, finalDir);
  fsyncDir(parent); // DUR-3: durable fresh-install promotion.
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
    const file = confinedSharedFile(runtimeDir, relFile);
    if (file === null) continue; // unsafe path (absolute / .. / symlink escaping the scope root)
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
        // Marker isolation for the map-keyed mcpServers shape: only (re)write an entry we already own
        // or a brand-new name. A collision with an UNOWNED entry (the user's, or another capability's)
        // is SKIPPED so user config is never clobbered — hooks are arrays and append, but mcpServers is
        // keyed by name, so a blind overwrite would silently destroy the existing server config.
        const existing = mcpObj[name];
        const ownedByUs = typeof existing === 'object' && existing !== null
          && (existing as Record<string, unknown>)[CAP_MARKER] === capId;
        if (existing !== undefined && !ownedByUs) continue;
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
    const file = confinedSharedFile(runtimeDir, relFile);
    if (file === null) continue; // unsafe path (absolute / .. / symlink escaping the scope root)
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

/**
 * Is `id` a first-party capability id (present in the committed registry)? First-party always wins,
 * so an overlay reusing one of these ids — even a non-reserved name like "ui" — must be refused at
 * install (the loader would skip it at load anyway; rejecting here avoids writing an inert, shadowing
 * bundle). Fail-open to `false` if the registry cannot be read (the reserved-prefix gate still applies).
 */
function isFirstPartyCapabilityId(id: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./capability-registry.cjs') as { capabilities?: Record<string, unknown> };
    return !!(reg && reg.capabilities && Object.prototype.hasOwnProperty.call(reg.capabilities, id));
  } catch {
    return false;
  }
}

/**
 * Finding 5(b): bound the --shared-file COUNT against the same generous DoS cap the ledger applies
 * to `_pending.sharedFiles`. Returns an error string when over-cap (so the caller can fail fast
 * BEFORE source resolution / staging / shared-config writes), or null when within bounds.
 */
function checkSharedFileCount(sharedFiles: string[] | undefined): string | null {
  if (!Array.isArray(sharedFiles)) return null;
  if (sharedFiles.length > ledgerMod.MAX_SHARED_FILES) {
    return `too many --shared-file entries: ${sharedFiles.length} exceeds the maximum of ` +
      `${ledgerMod.MAX_SHARED_FILES}. A capability does not need this many shared-config files; ` +
      `reduce the --shared-file count.`;
  }
  return null;
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

  // Finding 5(b) (MEDIUM): bound the --shared-file COUNT EARLY — BEFORE source resolution, staging,
  // or any shared-config write — so an over-cap install fails fast with a clear count error instead
  // of writing files + leaving a `_pending` for reconcile to clean up. The same generous DoS cap as
  // the ledger's `_pending.sharedFiles` validation.
  const sharedCountError = checkSharedFileCount(sharedFiles);
  if (sharedCountError) return { status: 'blocked', blockReasons: [sharedCountError] };

  // Finding 1 (HIGH): strict ledger PREFLIGHT — BEFORE source resolution, staging, trust, or
  // consent. On a corrupt-but-present ledger this must block IMMEDIATELY with a corruption
  // reason. The previous order called _resolve first (creating .gsd/capabilities/.staging) and
  // only strict-read later, so a corrupt ledger could surface as `aborted` (consent) for an
  // executable install without --yes BEFORE the corruption was ever reported, and would leave a
  // staging dir behind. A non-throwing read here is a READ-ONLY operation: it touches no lock and
  // creates no directory. The later read (re-read under lock before commit) is kept for race-safety.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
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
    if (opts.expectedId && resolved.id !== opts.expectedId) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`source resolved to capability id "${resolved.id}" but "${opts.expectedId}" was expected; refusing`] };
    }
    // ROOT FIX 3: reject unsafe capability ids before any promotion or ledger write.
    // A .gsd/capabilities/constructor (or __proto__, prototype) bundle must never be promoted —
    // the resolved id is untrusted data from the bundle's capability.json.
    if (ledgerMod.isUnsafeCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`capability id "${resolved.id}" is unsafe (prototype-pollution key or invalid kebab-case); refusing to install`] };
    }
    if (isFirstPartyCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`"${resolved.id}" is a first-party capability id and cannot be overridden by a third-party overlay`] };
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
    // readLedgerStrict: returns null when MISSING (fresh first install), throws CorruptLedgerError
    // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
    // corrupt-but-present ledger fails closed rather than silently treating it as "no prior entry".
    let existingLedger: LedgerFile | null;
    try {
      existingLedger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }
    const prior = existingLedger && Object.prototype.hasOwnProperty.call(existingLedger.entries, resolved.id)
      ? existingLedger.entries[resolved.id]
      : null;
    const hadDir = fs.existsSync(finalDir);
    const priorSharedFiles = prior && Array.isArray(prior.sharedEdits) ? prior.sharedEdits.map((e) => e.file) : [];
    const candidateFiles = Array.from(new Set([...priorSharedFiles, ...files]));
    // CONC-3: nonce'd backup name prevents same-ms cross-process collision.
    const backupName = hadDir ? newBackupName(resolved.id) : null;

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
    // recordInstall calls readLedgerStrict internally and can throw CorruptLedgerError if the
    // ledger is corrupt. Catch it here so the function always returns a typed result, never throws.
    // DOS-4: pass the already-strict-read `existingLedger` as the base so recordInstall skips a
    // redundant strict re-read (we hold the lock, so the on-disk ledger cannot change underneath it).
    try {
      ledgerMod.recordInstall(runtimeDir, {
        ...pendingBase,
        _pending: { kind: isUpgradeLike ? 'upgrade' : 'install', backupName, sharedFiles: candidateFiles },
      }, { baseLedger: existingLedger });
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }

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

  // Finding 5(b) (MEDIUM): bound the --shared-file COUNT EARLY — BEFORE source resolution/staging.
  const sharedCountError = checkSharedFileCount(sharedFiles);
  if (sharedCountError) return { status: 'blocked', blockReasons: [sharedCountError] };

  // Finding 1 (HIGH): strict ledger PREFLIGHT — BEFORE source resolution, staging, trust, or
  // re-consent. On a corrupt-but-present ledger this must block IMMEDIATELY with a corruption
  // reason, never fetch/stage the new bundle, and never surface a downstream not_installed/consent
  // result that masks the corruption. Read-only — takes no lock, creates no directory. The later
  // read (re-read under lock before commit) is kept for race-safety.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', blockReasons: [(err as Error).message] };
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
    if (opts.expectedId && resolved.id !== opts.expectedId) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`source for "${opts.expectedId}" now resolves to a different capability id "${resolved.id}"; refusing to upgrade`] };
    }
    // ROOT FIX 3: reject unsafe capability ids before any ledger read or promotion.
    if (ledgerMod.isUnsafeCapabilityId(resolved.id)) {
      return { status: 'blocked', id: resolved.id, blockReasons: [`capability id "${resolved.id}" is unsafe (prototype-pollution key or invalid kebab-case); refusing to upgrade`] };
    }
    // readLedgerStrict: returns null when MISSING (not installed), throws CorruptLedgerError
    // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
    // corrupt-but-present ledger fails closed rather than silently reporting not_installed.
    let existing: LedgerFile | null;
    try {
      existing = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }
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
    // Wrap in try/catch so a disk failure (EPERM, ENOSPC, …) at the intent-write stage
    // returns a blocked result rather than a raw stack trace (finding 4).
    const backupName = newBackupName(resolved.id); // CONC-3: nonce'd, collision-resistant.
    try {
      ledgerMod.recordInstall(runtimeDir, { ...prior, _pending: { kind: 'upgrade', backupName, sharedFiles: candidateFiles } });
    } catch (err) {
      return { status: 'blocked', id: resolved.id, blockReasons: [(err as Error).message] };
    }

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
  // Finding 2 (HIGH): READ-ONLY corruption preflight BEFORE acquireLock. acquireLock creates
  // .gsd/capabilities and a .lock file; doing it before detecting corruption pollutes the scope
  // (and takes a lock) on a ledger we will refuse anyway. A strict read takes no lock and creates
  // no directory, so on a corrupt/IO-error ledger we return blocked with NO lock and NO dir created.
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    return { status: 'blocked', id, blockReasons: [(err as Error).message] };
  }
  const lock = acquireLock(runtimeDir);
  try {
    if (!lock) return { status: 'blocked', id, blockReasons: ['another capability operation is in progress'] };
    // Re-read under the lock to close the race (the ledger could have gone corrupt between the
    // preflight and acquiring the lock). readLedgerStrict: returns null when MISSING (not
    // installed), throws CorruptLedgerError when the file exists but is corrupt — fail-closed.
    let ledger: LedgerFile | null;
    try {
      ledger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      return { status: 'blocked', id, blockReasons: [(err as Error).message] };
    }
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
    // Finding 3 (HIGH): commit from the ALREADY-read in-memory ledger (the one we strict-read
    // at the top of this function), NOT via removeEntry's non-strict re-read. If the ledger
    // goes corrupt between the strict pre-read and the commit, removeEntry would return false
    // (it re-reads non-strictly → null → returns false) while removeCapability still returns
    // 'removed', leaving a dangling reference in the corrupt file for a capability whose files
    // are already gone. Writing from the in-memory snapshot is atomic and coherent.
    //
    // If the write fails (EPERM, EBUSY, EXDEV, …) after the files are already deleted, we
    // return a typed 'blocked' result with recovery info rather than letting an unhandled
    // throw propagate as a CLI stack trace. The ledger would still reference files that no
    // longer exist — the user can re-run `gsd capability remove <id>` to retry the commit (the
    // next install/update/remove also runs the reconcile sweep automatically). There is no
    // standalone `reconcile` CLI subcommand (UX-4).
    try {
      if (ledger !== null) {
        delete ledger.entries[id];
        ledger.updatedAt = new Date().toISOString();
        ledgerMod.writeLedger(runtimeDir, ledger);
      }
    } catch (err) {
      return {
        status: 'blocked',
        id,
        blockReasons: [
          `Capability files were deleted but the ledger commit failed: ${(err as Error).message}. ` +
          `To recover: run 'gsd capability remove ${id}' again, or manually inspect and restore ` +
          `the ledger file to remove the stale entry for "${id}".`,
        ],
      };
    }

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
  /** Non-fatal warnings encountered during reconciliation (e.g. a corrupt-present ledger). */
  warnings: string[];
}

/**
 * Backup-dir name shape; the id segment is kebab-case so no traversal is possible. The trailing
 * `-<hex>` nonce (CONC-3) is OPTIONAL so legacy backups written before the nonce was added still
 * match (backward compatible).
 */
const BACKUP_NAME_RE = /^[a-z][a-z0-9-]*\.upgrading-\d+-\d+(-[0-9a-f]+)?$/;

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
  const report: ReconcileReport = { rolledBack: [], rolledForward: [], orphansRemoved: [], ledger: null, warnings: [] };
  const root = capabilitiesRoot(runtimeDir);

  // Finding 2 (HIGH): READ-ONLY corruption preflight BEFORE acquireLock. acquireLock creates
  // .gsd/capabilities and a .lock file; doing it before detecting corruption pollutes the scope
  // (and takes a lock) on a ledger we will refuse to mutate anyway. A strict read takes no lock and
  // creates no directory, so on a corrupt/IO-error/broken-symlink ledger we WARN and return WITHOUT
  // any filesystem mutation and WITHOUT a lock or directory created. (The in-lock re-read below
  // still fires to close the race if the ledger goes corrupt after this preflight.)
  try {
    ledgerMod.readLedgerStrict(runtimeDir);
  } catch (err) {
    report.warnings.push(
      `Capability ledger file exists but could not be read: ${(err as Error).message}`,
    );
    return report; // no lock taken, no directory created, no filesystem mutation (finding 2)
  }

  const lock = acquireLock(runtimeDir);
  if (!lock) return report; // another op is in flight and will reconcile itself.
  try {
    // --- Step 1: resolve uncommitted operations flagged by the intent. ---
    let ledger = ledgerMod.readLedger(runtimeDir);
    // Detect corrupt-present or IO-error ledger: readLedger returns null but the file exists.
    // Finding 1 (CRITICAL): when the ledger file is present but unreadable/unparseable (or is a
    // broken symlink), RETURN IMMEDIATELY with the warning — perform NO filesystem mutations (no
    // backup sweep, no staging cleanup, no rmSync/rename). Continuing into step 2 would delete
    // `.upgrading-*` backups that may be the only recovery path for the user.
    //
    // ROOT FIX 4: use lstatSync (not existsSync) — existsSync follows the symlink and returns
    // false for a broken/dangling symlink, making reconcile treat a dangling ledger pointer as
    // "no ledger yet" and proceed to sweep backups. lstatSync checks the directory ENTRY itself,
    // so a broken symlink is detected and treated as an IO problem requiring user intervention.
    if (ledger === null) {
      const ledgerFilePath = path.join(runtimeDir, '.gsd-capabilities.json');
      let ledgerEntryExists = false;
      try {
        fs.lstatSync(ledgerFilePath);
        ledgerEntryExists = true;
      } catch (lstatErr) {
        // ENOENT means genuinely absent — no ledger, no entry, fresh start is fine.
        // Any other error (EACCES, EPERM, …) means an IO problem — also treat as "exists but broken".
        if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          ledgerEntryExists = true; // IO problem accessing the entry — treat as corrupt/broken.
        }
      }
      if (ledgerEntryExists) {
        report.warnings.push(`Capability ledger file exists but could not be parsed: ${ledgerFilePath}`);
        return report; // MUST return here — no mutations when ledger is corrupt/broken (finding 1)
      }
    }
    if (ledger) {
      // DOS-2: accumulate ALL step-1 ledger mutations in this in-memory copy and write ONCE at the
      // end of step 1, instead of a full read+write per pending entry (O(N) reads/writes → O(1)).
      // We already hold the lock and the ledger has passed the corruption preflight, so writing the
      // validated in-memory copy is coherent. `ledgerDirty` gates whether the single write runs.
      const workingLedger = ledger;
      let ledgerDirty = false;
      for (const id of Object.keys(workingLedger.entries)) {
        // W-6: a per-entry mutation can now throw (the strip/restore IO, or a future strict write).
        // One bad entry must NOT abort the whole reconcile — wrap it, warn, and continue.
        try {
          // Reject a tampered ledger key: a non-kebab id (e.g. one containing `../`) must never reach
          // capDir()/safeRmUnder() (Codex R3 M5). Leave it in place for ledger.reconcile to report.
          if (!KEBAB_ID_RE.test(id)) continue;
          const entry = workingLedger.entries[id];
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
            delete workingLedger.entries[id]; // DOS-2: in-memory drop; single write at end of step 1.
            ledgerDirty = true;
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
              // DUR-6: NEVER rmSync(finalDir) before restoring — a crash between the rm and the
              // rename would leave BOTH the new dir AND the backup gone (the old `rmSync` then
              // `rename` ordering). Instead, move the uncommitted new dir ASIDE (atomic rename), then
              // rename the backup over the now-free finalDir, then drop the aside copy. (`rename`
              // cannot atomically replace a non-empty directory on POSIX, so a single rename-over is
              // not an option.) At every instant at least one intact copy of the old bundle exists:
              //   - crash after step (a): backup still present + `_pending` still references it → retry.
              //   - crash after step (b): old bundle live at finalDir; only the aside copy leaks → swept.
              const discard = `${finalDir}.discard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
              if (fs.existsSync(finalDir)) fs.renameSync(finalDir, discard); // (a) set the new dir aside
              fs.renameSync(backupDir, finalDir);                            // (b) restore the old bundle
              fsyncDir(root);                                                // make the restore durable
              try { fs.rmSync(discard, { recursive: true, force: true }); } catch { /* swept later */ }
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
            delete workingLedger.entries[id]; // DOS-2: in-memory drop.
            ledgerDirty = true;
            report.rolledBack.push(id);
            continue;
          }

          if (!restored) continue; // keep `_pending` so recovery is retried, never silently committed.

          const refreshed = resyncCapabilitySharedEdits({ runtimeDir, capId: id, sharedFiles: candidateFiles });
          const cleared: LedgerEntry = { ...entry, sharedEdits: refreshed };
          delete cleared._pending;
          workingLedger.entries[id] = cleared; // DOS-2: in-memory update; single write at end.
          ledgerDirty = true;
          report.rolledBack.push(id);
        } catch (entryErr) {
          // W-6: surface the failed entry as a warning and keep going with the rest.
          report.warnings.push(
            `Reconcile could not roll back capability "${id}": ${(entryErr as Error).message}`,
          );
        }
      }
      // DOS-2: write the accumulated step-1 mutations exactly ONCE.
      if (ledgerDirty) {
        workingLedger.updatedAt = new Date().toISOString();
        try {
          ledgerMod.writeLedger(runtimeDir, workingLedger);
        } catch (writeErr) {
          report.warnings.push(
            `Reconcile could not persist rolled-back ledger state: ${(writeErr as Error).message}`,
          );
        }
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
      // DUR-6: sweep `.discard-*` dirs left by an interrupted upgrade-rollback (the uncommitted new
      // bundle that was moved aside before the backup was renamed back in). They never carry a live
      // intent, so they are always safe to drop here.
      if (/\.discard-\d+-\d+-[0-9a-f]+$/.test(name)) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); report.orphansRemoved.push(name); } catch { /* best-effort */ }
        continue;
      }
      // Match both the legacy `<id>.upgrading-<pid>-<ts>` and the nonce'd `<id>.upgrading-<pid>-<ts>-<hex>`.
      const m = /^(.+)\.upgrading-\d+-\d+(?:-[0-9a-f]+)?$/.exec(name);
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

    // W-3 / DUR-5: sweep STALE ledger temp orphans (`.gsd-capabilities.json.tmp.<pid>-<nonce>`) from
    // the runtime dir. A double-IO-error (or Windows AV lock) during writeLedger's cleanup-unlink can
    // leave a temp behind; without this sweep they accumulate forever. Spare recently-created ones,
    // which may belong to an in-flight write in another process. Best-effort.
    try {
      const now = Date.now();
      const tmpPrefix = `${ledgerMod.LEDGER_FILE_NAME}.tmp.`;
      for (const f of fs.readdirSync(runtimeDir)) {
        if (!f.startsWith(tmpPrefix)) continue;
        const p = path.join(runtimeDir, f);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs <= LEDGER_TMP_ORPHAN_MS) continue; // too fresh — could be a live write
          fs.rmSync(p, { force: true });
          report.orphansRemoved.push(f);
        } catch { /* best-effort */ }
      }
    } catch { /* runtimeDir unreadable — nothing to sweep */ }

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
  // Exported for cross-process-lock unit tests (CONC-1/CONC-2/finding-1). Not part of the public CLI
  // surface. `_setLockProbes`/`_resetLockProbes` let tests inject deterministic isPidAlive /
  // getProcessStartTime so the start-time liveness branches are exercised without real OS pids.
  acquireLock,
  releaseLock,
  getProcessStartTime,
  _setLockProbes(probes: Partial<{ isPidAlive: (pid: number) => boolean; getProcessStartTime: (pid: number) => string | null }>): void {
    if (typeof probes.isPidAlive === 'function') _lockProbes.isPidAlive = probes.isPidAlive;
    if (typeof probes.getProcessStartTime === 'function') _lockProbes.getProcessStartTime = probes.getProcessStartTime;
  },
  _resetLockProbes(): void {
    _lockProbes.isPidAlive = _realIsPidAlive;
    _lockProbes.getProcessStartTime = getProcessStartTime;
  },
};

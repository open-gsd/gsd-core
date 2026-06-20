/**
 * capability-source.cts — Capability source resolver (ADR-1244 Phase 3, Decision D3).
 *
 * One seam `resolveCapabilitySource(spec, opts)` with an adapter per source kind.
 * Each adapter: fetch → verify integrity/SHA → check engines.gsd → return a STAGED,
 * VALIDATED bundle.
 *
 * SECURITY CONTRACT:
 *   - Install NEVER executes capability code. Copy/extract only.
 *   - All subprocesses routed through shell-command-projection.cjs seam (windowsHide,
 *     argv arrays, no shell string interpolation).
 *   - Integrity verified BEFORE extraction when provided.
 *   - engines.gsd pre-checked before staging.
 *   - Full validator suite run on manifest before finalizing.
 *   - Staging atomicity: stage under .staging/<id>-<pid>-<ts>/, renameSync on success,
 *     rmSync on any failure.
 *   - No raw spawnSync / execSync / shell strings.
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 *
 * Exports: resolveCapabilitySource, parseSpec, _setCapabilitySourceHttpGet,
 *          _setHttpsGetImpl, _readManifestBounded, MAX_RESPONSE_BYTES,
 *          MANIFEST_MAX_BYTES, MAX_STAGED_BUNDLE_BYTES, MAX_STAGED_BUNDLE_ENTRIES
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellSeam = require('./shell-command-projection.cjs') as {
  execGit: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execNpm: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execTool: (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const capValidator = require('./capability-validator.cjs') as ValidatorModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs') as {
  semverSatisfies: (version: unknown, range: unknown) => boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ledgerMod = require('./capability-ledger.cjs') as {
  /** Shared fd-based bounded reader: content, null for ENOENT, or THROWS (non-regular/oversized/IO). */
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

interface ValidatorModule {
  validateCapability: (cap: unknown, id: string) => string[];
  materializeHookFragments: (cap: unknown, capDir: string) => string[];
  validateAgainstContract: (cap: unknown, capId: string) => string[];
  validateConsumesGlobal: (capMap: Map<string, unknown>) => string[];
  validateCrossCapability: (capMap: Map<string, unknown>, centralKeys: Set<string>) => string[];
}

/** Parsed spec discriminant. */
type SpecKind = 'registry' | 'git' | 'npm' | 'tarball' | 'local';

interface ParsedSpec {
  kind: SpecKind;
  /** The original raw spec string. */
  raw: string;
  /** Resolved URL / path / package-spec, depending on kind. */
  target: string;
  /** Optional ref (git only). */
  ref?: string;
}

/** Tar-only exec signature (program is always 'tar', injected for testability). */
type TarExecFn = (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;

/** Options accepted by resolveCapabilitySource. */
interface ResolveOptions {
  /** Running GSD version. Defaults to package.json version, fail-closed to '0.0.0'. */
  hostVersion?: string;
  /** Override the GSD home directory (where .gsd/capabilities/ lives). */
  gsdHome?: string;
  /** Expected integrity string (`sha512-<base64>`). When provided, integrity is verified
   *  before any bytes are committed to the final location. */
  integrity?: string;
  /**
   * When false, stop after validation and return the staging dir WITHOUT promoting it to the
   * final capabilities location. The caller then owns the atomic stage-then-swap + ledger
   * commit ordering (ADR-1244 Phase 4 / D6 upgrade path). Defaults to true (promote in place),
   * preserving the original install behavior.
   */
  promote?: boolean;
  /**
   * When true, SKIP the resolver's `engines.gsd` hard-throw during staging. The caller becomes
   * responsible for the engines gate. Used by capability-lifecycle so its own `checkEngines` can
   * gate the install AND surface a `compatVersions` downgrade hint (the resolver throw would
   * pre-empt that). Staging remains copy-only and is never promoted by the lifecycle when the
   * engines check fails, so nothing incompatible is ever activated. Defaults to false (throw).
   */
  skipEnginesGate?: boolean;
  /** Injectable exec overrides for tests — keys match the shell-seam functions. */
  execOverrides?: {
    git?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    npm?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    tar?: TarExecFn;
  };
}

/** Resolved + staged bundle descriptor. */
interface ResolveResult {
  id: string;
  version: string;
  stagedDir: string;
  /** sha512-<base64> digest of the staged capability.json, or null for local/git sources. */
  integrity: string | null;
  /** The original spec string. */
  source: string;
}

/** Injectable HTTP response shape. */
interface HttpResponse {
  statusCode: number;
  body: Buffer;
}

type HttpGetFn = (url: string) => Promise<HttpResponse>;

/**
 * DOS-1 (#1461): GENEROUS but BOUNDED cap on a fetched capability source response. `realHttpsGet`
 * previously accumulated `res.on('data')` chunks with NO ceiling, so a hostile or accidental
 * oversized tarball (e.g. an HTTP endpoint streaming gigabytes) would buffer unbounded into memory
 * and OOM the process. A real capability bundle is a few hundred KiB of declarative JSON + small
 * artifacts; 64 MiB is far more than any legitimate bundle yet still a hard ceiling. Enforced two
 * ways: (1) a `content-length` header over the cap is rejected BEFORE buffering any body; (2) the
 * cumulative streamed byte count is tracked across `data` events and the request is destroyed +
 * rejected the instant it exceeds the cap (covers chunked / missing-content-length responses).
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * #1461 finding 2 (HIGH): GENEROUS but BOUNDED cap on an UNTRUSTED `capability.json` read during
 * resolve/staging. Every untrusted manifest (tarball / npm / git / local staging) MUST be read via
 * the SHARED bounded reader (`readSmallRegularFile`: open → fstat → require-regular-file → size-cap →
 * read-exactly-size), NOT a raw `fs.readFileSync`. A raw read of an oversized extracted-or-local
 * `capability.json` reads unbounded into memory (OOM), and a FIFO/device/non-regular manifest BLOCKS
 * the resolver forever. A legitimate manifest is a few KiB of declarative JSON; 8 MiB is far more than
 * any real capability.json yet a hard ceiling. The reader returns null for a genuinely-missing file
 * (ENOENT) and THROWS for non-regular/oversized/IO — both are mapped to a clear "manifest not
 * found / refused" rejection (fail-closed: the source never resolves).
 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * #1461 finding 1 (HIGH): ONE uniform aggregate byte-budget over the STAGED bundle directory. The HTTP
 * fetch is capped (MAX_RESPONSE_BYTES), but `copyDirRecursive` / `fs.copyFileSync`, `git clone`,
 * `npm pack`, and `tar -x` were only TIMEOUT-bounded — so a huge local source tree, a giant git repo, a
 * large npm package, or a gzip/tar bomb that expands far beyond the compressed download cap could fill
 * disk during staging. This single budget, enforced at the common staging chokepoint (stageValidated,
 * AFTER the source is copied into staging and BEFORE validation/promotion), uniformly bounds the RESULT
 * of every adapter: it sums the regular-file bytes of the staged dir via a BOUNDED streaming walk and
 * fails closed if the total exceeds the cap. 128 MiB is generous for a real capability bundle (a few
 * hundred KiB of declarative JSON + small artifacts) yet hard-bounds a bomb.
 *
 * RESIDUAL (#1461 finding 4): this bounds the staged RESULT — it rejects an oversized install BEFORE
 * promotion, but a transient disk-fill DURING extraction/clone (before the post-staging walk runs) is a
 * residual a fully-airtight bound would need a streaming byte-quota DURING extraction/clone (e.g. a
 * cgroup/disk-quota or a custom streaming extractor) to close. This is a stated, proportionate limit:
 * this resolver path is USER-INITIATED `install` only (the cloned-repo / loader overlay path does NOT
 * invoke the resolver and is bounded separately by capability-consent's bundleContentHash caps), and
 * staging happens under a temp/.staging dir that is rmSync'd on any failure.
 */
const MAX_STAGED_BUNDLE_BYTES = 128 * 1024 * 1024;

/**
 * #1461 finding 1: a cumulative ENTRY-count ceiling for the staged-dir budget walk so the enumeration
 * ITSELF is bounded (a hostile bundle with millions of tiny files / a very deep tree cannot force
 * unbounded readdir work before the byte cap trips). 100k entries is far more than any real bundle.
 */
const MAX_STAGED_BUNDLE_ENTRIES = 100_000;

/**
 * The low-level `https.get`-shaped transport. Extracted as an overridable module-level reference so
 * a test can inject a fake response stream (chunked / oversized / content-length-tagged) to exercise
 * the MAX_RESPONSE_BYTES enforcement in realHttpsGet WITHOUT real network I/O. Defaults to the real
 * node:https get. (The higher-level `_httpGet` seam below short-circuits realHttpsGet entirely and is
 * used by the integrity tests; this seam is specifically for the streaming/size-cap path.)
 */
type HttpsGetImpl = typeof https.get;
let _httpsGetImpl: HttpsGetImpl = https.get;

/** Test seam: override the low-level https.get transport used by realHttpsGet. Pass null to restore. */
function _setHttpsGetImpl(fn: HttpsGetImpl | null): void {
  _httpsGetImpl = fn ?? https.get;
}

// ---------------------------------------------------------------------------
// Injectable HTTP transport (test seam)
// ---------------------------------------------------------------------------

function realHttpsGet(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = _httpsGetImpl(
      url,
      { headers: { 'User-Agent': 'gsd-core-capability-source/1.0' } },
      (res) => {
        // DOS-1: reject early if the server ADVERTISES a body over the cap — no bytes buffered.
        const contentLength = Number(res.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          req.destroy();
          res.destroy?.();
          reject(
            new Error(
              `response exceeds ${MAX_RESPONSE_BYTES} bytes (content-length ${contentLength}) fetching ${url}`
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;
        res.on('data', (c: Buffer) => {
          if (aborted) return;
          received += c.length;
          // DOS-1: enforce the ceiling on the ACTUAL streamed bytes (covers chunked / lying or
          // absent content-length). Destroy the request/response and reject — never keep buffering.
          if (received > MAX_RESPONSE_BYTES) {
            aborted = true;
            req.destroy();
            res.destroy?.();
            reject(new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes fetching ${url}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? 0} fetching ${url}`));
            return;
          }
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`timeout after 30000ms fetching ${url}`));
    });
    req.on('error', reject);
  });
}

let _httpGet: HttpGetFn = realHttpsGet;

/**
 * Test seam: replace the HTTP transport. Pass null to restore the real transport.
 */
function _setCapabilitySourceHttpGet(fn: HttpGetFn | null): void {
  _httpGet = fn ?? realHttpsGet;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the running GSD version; fail-closed to '0.0.0'. */
function readHostVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json') as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Compute sha512-<base64> integrity over a buffer. */
function computeIntegrity(buf: Buffer): string {
  const digest = crypto.createHash('sha512').update(buf).digest('base64');
  return `sha512-${digest}`;
}

/** Verify buf against an `sha512-<base64>` integrity string. Throws on mismatch. */
function verifyIntegrity(buf: Buffer, expected: string): void {
  const prefix = 'sha512-';
  if (!expected.startsWith(prefix)) {
    throw new Error(`Unsupported integrity algorithm (expected sha512-<base64>): ${expected}`);
  }
  const expectedBase64 = expected.slice(prefix.length);
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== expectedBase64) {
    throw new Error(
      `Integrity mismatch: expected sha512-${expectedBase64} but got sha512-${actual}`
    );
  }
}

/**
 * #1461 finding 2 (HIGH): read an UNTRUSTED `capability.json` (extracted or local) via the SHARED
 * bounded reader and parse it as a JSON object, failing CLOSED on every untrusted-input condition.
 * Replaces the raw `fs.readFileSync(manifestPath,'utf8')` at each resolve/staging site so an oversized
 * manifest cannot read unbounded (OOM) and a FIFO/device/non-regular manifest cannot BLOCK forever.
 *   - ENOENT (reader returns null) → throw `<notFoundMessage>` (genuinely missing).
 *   - non-regular / oversized / IO (reader THROWS)  → throw `<notFoundMessage>: <reason>` (refused).
 *   - not valid JSON  → throw the caller's invalid-JSON message.
 *   - not a JSON object  → throw the caller's not-an-object message.
 */
function readManifestBounded(
  manifestPath: string,
  notFoundMessage: string,
): Record<string, unknown> {
  let raw: string | null;
  try {
    raw = ledgerMod.readSmallRegularFile(manifestPath, MANIFEST_MAX_BYTES);
  } catch (err) {
    // Non-regular (FIFO/device/dir), oversized, or IO error — fail closed with a clear message.
    throw new Error(`${notFoundMessage}: ${(err as Error).message}`);
  }
  if (raw === null) {
    throw new Error(notFoundMessage); // genuinely missing (ENOENT).
  }
  let cap: unknown;
  try {
    cap = JSON.parse(raw);
  } catch {
    throw new Error('capability.json is not valid JSON');
  }
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    throw new Error('capability.json must be a JSON object');
  }
  return cap as Record<string, unknown>;
}

/**
 * #1460 CS-1: read a locally-produced `npm pack` `.tgz` as RAW BYTES via a bounded fd read so a
 * supplied `--integrity` can be verified over the tarball (same SRI sha512 domain as the tarball
 * adapter) before extraction/staging. `readSmallRegularFile` decodes utf8 (corrupting binary), so
 * this reads the Buffer directly while keeping the same fail-closed discipline: open → fstat →
 * require a regular file (a FIFO/device cannot BLOCK or be misread) → size-cap (MAX_RESPONSE_BYTES,
 * the same ceiling the HTTP fetch enforces) → read exactly fstat.size bytes.
 */
function readPackTarball(tgzPath: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(tgzPath, 'r');
  } catch (err) {
    throw new Error(`Cannot read npm pack tarball: ${tgzPath}: ${(err as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Refusing to read non-regular npm pack tarball: ${tgzPath}`);
    }
    if (st.size > MAX_RESPONSE_BYTES) {
      throw new Error(`npm pack tarball exceeds ${MAX_RESPONSE_BYTES} bytes: ${tgzPath}`);
    }
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return read === st.size ? buf : buf.subarray(0, read);
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

/**
 * Reject spec/id values containing path separators or `..`.
 * Throws if the id is unsafe.
 */
function assertSafeId(id: string): void {
  if (!id || /[/\\]/.test(id) || id.includes('..')) {
    throw new Error(
      `Capability id "${id}" is invalid: must be kebab-case with no path separators or ".."`
    );
  }
}

// Shell-injection metacharacters + whitespace/control. execNpm runs under a shell
// on Windows (the npm shim), so an npm: spec must not carry any of these — they are
// never valid in a real npm package spec (scope/name@version|tag|^range|~range).
const SHELL_METACHAR_RE = /[;&|$`()<>!"'\\%\s]/;

/** Reject an npm package spec that could break out of the (Windows) shell. */
function assertSafeNpmSpec(pkgSpec: string): void {
  if (SHELL_METACHAR_RE.test(pkgSpec)) {
    throw new Error(`Unsafe npm package spec (shell metacharacters not allowed): "${pkgSpec}"`);
  }
}

/**
 * Allowlist git transports. Git's `ext::`/`fd::` remote helpers are external-command
 * bridges (arbitrary code execution if protocol.*.allow is permissive), and `file://`
 * enables local-path tricks — only network transports are permitted.
 */
function assertSafeGitUrl(url: string): void {
  if (!/^(https?|ssh|git):\/\//i.test(url)) {
    throw new Error(
      `Unsupported git transport for "${url}": only https://, ssh://, and git:// are allowed`
    );
  }
}

/**
 * Copy a directory tree recursively into destDir — STREAMING and BUDGETED.
 *
 * SECURITY: symlinks are REJECTED (fail closed). A fetched bundle could otherwise
 * smuggle a symlink (e.g. `id_rsa -> ~/.ssh/id_rsa`) that fs.copyFileSync would
 * FOLLOW, copying an arbitrary host file's bytes into the staged capability dir.
 * Dirent.isSymbolicLink() reflects the entry itself (lstat semantics), so this
 * catches both file and directory symlinks before any copy.
 *
 * #1461 finding 1 (HIGH, ROUND 2): the copy ITSELF is bounded. The former
 * `fs.readdirSync(src, { withFileTypes: true })` materialized the ENTIRE directory-entry
 * array into memory BEFORE any budget could run — and copyDirRecursive runs at staging time
 * BEFORE the post-copy assertStagedBundleWithinBudget walk. So a hostile local/git/npm/tar
 * source whose tree has a directory holding millions of tiny files (fetch < 64 MiB, but a
 * colossal dirent array) OOMs the process during the COPY, before the post-copy budget can
 * fail closed. We now STREAM each directory via fs.opendirSync + dir.readSync() (one entry at
 * a time, never the whole array) and thread CUMULATIVE counters across the recursion — total
 * entries (cap MAX_STAGED_BUNDLE_ENTRIES) and total regular-file bytes (cap
 * MAX_STAGED_BUNDLE_BYTES) — throwing the MOMENT either is exceeded, DURING the copy, before
 * reading/copying the rest. The shared mutable `budget` object mirrors bundleContentHash's
 * cumulative walk in capability-consent. The throw propagates to stageValidated's catch, which
 * rmSync's the staging dir (fail closed, no partial bundle promoted).
 */
function copyDirRecursive(
  src: string,
  dest: string,
  budget: { entries: number; bytes: number } = { entries: 0, bytes: 0 },
): void {
  fs.mkdirSync(dest, { recursive: true });
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(src);
  } catch (err) {
    throw new Error(`Cannot read source directory "${src}": ${(err as Error).message}`);
  }
  try {
    for (;;) {
      let entry: fs.Dirent | null;
      try {
        entry = dir.readSync();
      } catch (err) {
        throw new Error(`Cannot read source directory "${src}": ${(err as Error).message}`);
      }
      if (entry === null) break;

      // BOUND THE ENUMERATION ITSELF: count this entry and fail closed BEFORE it is processed,
      // so a huge directory (or deep tree) is never read in full into memory first.
      budget.entries++;
      if (budget.entries > MAX_STAGED_BUNDLE_ENTRIES) {
        throw new Error(
          `Refusing to stage bundle: entry count exceeds the maximum of ${MAX_STAGED_BUNDLE_ENTRIES}`
        );
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to stage symlink in capability bundle: ${entry.name}`);
      } else if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath, budget);
      } else if (entry.isFile()) {
        // Cumulative byte budget: lstat the entry (NOT stat — a symlink is already rejected above,
        // but lstat is the authoritative size of the regular file being copied) and fail closed the
        // MOMENT the running total crosses the cap, BEFORE copying the oversized file's bytes.
        let st: fs.Stats;
        try {
          st = fs.lstatSync(srcPath);
        } catch (err) {
          throw new Error(`Cannot lstat source entry "${srcPath}": ${(err as Error).message}`);
        }
        budget.bytes += st.size;
        if (budget.bytes > MAX_STAGED_BUNDLE_BYTES) {
          throw new Error(
            `Refusing to stage bundle: total staged size exceeds the maximum of ` +
            `${MAX_STAGED_BUNDLE_BYTES} bytes (possible oversized source tree, git repo, npm package, or tar bomb)`
          );
        }
        fs.copyFileSync(srcPath, destPath);
      }
      // Non-regular entries (sockets, fifos, devices) are silently skipped.
    }
  } finally {
    try { dir.closeSync(); } catch { /* best-effort: no fd leak per opened Dir */ }
  }
}

/**
 * #1461 finding 1 (HIGH): sum the total regular-file bytes under `stagedDir` via a BOUNDED streaming
 * walk and fail closed if the total exceeds MAX_STAGED_BUNDLE_BYTES. This is the SINGLE uniform bound on
 * the RESULT of staging for EVERY adapter (local copy / git clone / npm pack / tar extraction) — placed
 * at the common chokepoint in stageValidated AFTER copyDirRecursive and BEFORE validation/promotion.
 *
 * Bounded like capability-consent.bundleContentHash's enumeration: each level is STREAMED via
 * fs.opendirSync + dir.readSync() with a CUMULATIVE entry counter (`count.n`) that throws the moment it
 * exceeds MAX_STAGED_BUNDLE_ENTRIES — BEFORE the rest of a huge/deep level is read — so a hostile bundle
 * with millions of tiny files or a very deep tree cannot force unbounded readdir/memory work before the
 * byte cap trips. Per-entry: lstat (NOT stat) so a symlink is detected as itself; symlinks and other
 * non-regular entries are REJECTED (fail closed — copyDirRecursive already refuses symlinks at copy time,
 * but a fresh lstat here is the authoritative check on what actually landed in staging). Regular-file
 * st.size is accumulated and the walk throws the moment the running total crosses the cap.
 */
function assertStagedBundleWithinBudget(stagedDir: string): void {
  const total = { bytes: 0 };
  const count = { n: 0 };
  const walk = (absDir: string): void => {
    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(absDir);
    } catch (err) {
      throw new Error(`Cannot read staged directory "${absDir}": ${(err as Error).message}`);
    }
    const levelEntries: fs.Dirent[] = [];
    try {
      for (;;) {
        let ent: fs.Dirent | null;
        try {
          ent = dir.readSync();
        } catch (err) {
          throw new Error(`Cannot read staged directory "${absDir}": ${(err as Error).message}`);
        }
        if (ent === null) break;
        // BOUND THE ENUMERATION ITSELF: fail closed before this entry is retained, so a huge directory
        // (or deep tree) cannot be loaded in full first.
        count.n++;
        if (count.n > MAX_STAGED_BUNDLE_ENTRIES) {
          throw new Error(
            `Refusing to stage bundle: entry count exceeds the maximum of ${MAX_STAGED_BUNDLE_ENTRIES}`
          );
        }
        levelEntries.push(ent);
      }
    } finally {
      try { dir.closeSync(); } catch { /* best-effort */ }
    }
    for (const ent of levelEntries) {
      const abs = path.join(absDir, ent.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        throw new Error(`Cannot lstat staged entry "${abs}": ${(err as Error).message}`);
      }
      if (st.isSymbolicLink()) {
        // Defense in depth: copyDirRecursive already refuses symlinks, but the budget walk is the
        // authoritative re-check on what actually landed in staging.
        throw new Error(`Refusing to stage symlink in capability bundle: ${abs}`);
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) {
        // Sockets / FIFOs / devices are not part of a real capability bundle.
        throw new Error(`Refusing to stage non-regular file in capability bundle: ${abs}`);
      }
      total.bytes += st.size;
      if (total.bytes > MAX_STAGED_BUNDLE_BYTES) {
        throw new Error(
          `Refusing to stage bundle: total staged size exceeds the maximum of ` +
          `${MAX_STAGED_BUNDLE_BYTES} bytes (possible oversized source tree, git repo, npm package, or tar bomb)`
        );
      }
    }
  };
  walk(stagedDir);
}

/**
 * Defense-in-depth against tar-slip: list the archive members and reject any with
 * an absolute path or a `..` segment BEFORE extraction (system tar mostly guards
 * this, but the hard contract is "traversal rejected", so we verify explicitly).
 * Symlink members that survive extraction are caught later by copyDirRecursive.
 *
 * #1461 finding 2 (MED): the former per-member declared-size parse (parseTarMemberSize) was REMOVED.
 * It scanned the verbose listing for a date-looking token and treated the previous token as the size,
 * but on BSD `tar -tv` the owner/group columns PRECEDE the size, so a member owner/group like "Jan"
 * mis-anchored the scan → fail-OPEN (a bomb's real size column skipped). The staged-dir aggregate
 * budget (assertStagedBundleWithinBudget, #1461 finding 1) is now the real, non-spoofable bound on the
 * extracted RESULT, so the fragile header parse is redundant. This function keeps only the NAME and
 * TYPE guards (traversal / symlink / hardlink), which are unambiguous and not size-dependent.
 */
function assertSafeTarMembers(execTar: TarExecFn, tgzPath: string): void {
  // (1) Member NAMES — reject path traversal (absolute / "..").
  const listing = execTar('tar', ['-tzf', tgzPath], { timeout: 60_000 });
  if (listing.exitCode !== 0) {
    throw new Error(`tar listing failed (exit ${listing.exitCode}): ${listing.stderr}`);
  }
  for (const line of listing.stdout.split('\n')) {
    const member = line.trim();
    if (!member) continue;
    if (member.startsWith('/') || path.isAbsolute(member) || member.split(/[/\\]/).includes('..')) {
      throw new Error(`Refusing to extract tarball with unsafe member path: "${member}"`);
    }
  }
  // (2) Member TYPES — reject symlink/hardlink members BEFORE extraction. A symlink
  // member with a safe name is created during `tar -x` and a later member can be
  // written THROUGH it to escape the extract dir (the post-extraction copy guard is
  // too late). The verbose listing marks links: leading 'l'/'h' in the mode column
  // and a " -> " / " link to " suffix (GNU + bsd tar).
  const verbose = execTar('tar', ['-tvzf', tgzPath], { timeout: 60_000 });
  if (verbose.exitCode !== 0) {
    throw new Error(`tar verbose listing failed (exit ${verbose.exitCode}): ${verbose.stderr}`);
  }
  for (const line of verbose.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes(' -> ') || line.includes(' link to ') || /^\s*[lh]/.test(line)) {
      throw new Error('Refusing to extract tarball containing a symlink or hardlink member');
    }
  }
}

/**
 * Validate the fetched capability manifest and stage it atomically.
 *
 * Runs the full validation suite (validateCapability → materializeHookFragments →
 * validateAgainstContract → validateConsumesGlobal → validateCrossCapability).
 * On success, renames the staging dir to the final dir and returns the result.
 * On any failure, removes the staging dir and throws.
 */
function stageValidated(opts: {
  sourceDir: string;
  id: string;
  gsdHome: string;
  hostVersion: string;
  source: string;
  integrity: string | null;
  promote?: boolean;
  skipEnginesGate?: boolean;
}): ResolveResult {
  const { sourceDir, id, gsdHome, hostVersion, source, integrity } = opts;
  const promote = opts.promote !== false;

  // Safety: validate id before using it in a path.
  assertSafeId(id);

  const capabilitiesRoot = path.join(gsdHome, '.gsd', 'capabilities');
  const stagingRoot = path.join(capabilitiesRoot, '.staging');
  const stagingDir = path.join(stagingRoot, `${id}-${process.pid}-${Date.now()}`);
  const finalDir = path.join(capabilitiesRoot, id);

  // Reject a source-ROOT that is itself a symlink (copyDirRecursive guards interior
  // entries, but readdirSync would follow a symlinked root).
  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    throw new Error(`Refusing to stage a symlinked source directory: ${sourceDir}`);
  }

  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // Copy source into staging — STREAMING + BUDGETED (#1461 finding 1, ROUND 2). copyDirRecursive now
    // enforces BOTH the entry-count and aggregate-byte budget DURING the copy (per-entry, via opendirSync
    // + readSync, never readdirSync of the whole array), so a hostile source with millions of tiny files
    // or an oversized artifact fails closed IN-PROCESS before the whole directory is materialized — it can
    // no longer OOM the process before a post-copy walk runs. The catch below rmSync's the staging dir on
    // throw, so an over-budget bundle never lands at the final location.
    copyDirRecursive(sourceDir, stagingDir);

    // #1461 finding 1 (HIGH): belt-and-suspenders aggregate byte-budget re-verification on what ACTUALLY
    // landed in staging. copyDirRecursive (above) is now the PRIMARY in-process bound — it fails closed
    // DURING the copy — so this post-copy walk is no longer the sole guard, but it is kept as a cheap
    // authoritative re-lstat of the staged RESULT at the common chokepoint AFTER staging and BEFORE
    // validation/promotion: it re-checks the entry/byte caps and re-rejects any symlink / non-regular
    // entry on the real staged tree (every staging path here flows through copyDirRecursive — there is no
    // in-place-dir staging path — so the copy already bounds it; this is defense in depth).
    //
    // RESIDUAL (#1461 finding 4): the copy and this walk bound the staged RESULT (rejects an oversized
    // install before promotion); a transient disk-fill DURING extraction/clone (system tar/git/npm write
    // to a temp dir BEFORE copyDirRecursive streams it into staging) is a residual a fully-airtight bound
    // would need a streaming byte-quota DURING extraction/clone to close. Proportionate: this resolver
    // path is USER-INITIATED `install` only (the cloned-repo / loader overlay path does NOT invoke the
    // resolver and is bounded separately), and the temp/.staging dirs are removed on any failure.
    assertStagedBundleWithinBudget(stagingDir);

    // Read and parse the capability manifest via the SHARED bounded reader (#1461 finding 2): an
    // oversized/non-regular staged capability.json is refused (fail-closed) rather than read unbounded.
    const manifestPath = path.join(stagingDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in staged directory: ${stagingDir}`,
    );

    // engines.gsd pre-check — reject before staging finalizes (unless the caller owns the gate).
    const engines = cap['engines'];
    if (!opts.skipEnginesGate && engines && typeof engines === 'object' && !Array.isArray(engines)) {
      const gsdRange = (engines as Record<string, unknown>)['gsd'];
      if (typeof gsdRange === 'string' && gsdRange) {
        if (!semverMod.semverSatisfies(hostVersion, gsdRange)) {
          throw new Error(
            `Capability requires engines.gsd "${gsdRange}" but running GSD is ${hostVersion}`
          );
        }
      }
    }

    // Structural validation (validateCapability enforces id===folderId).
    const validationErrs = capValidator.validateCapability(cap, id);
    if (validationErrs.length > 0) {
      throw new Error(`Capability validation failed: ${validationErrs.join('; ')}`);
    }

    // Materialize hook fragments (returns errors, does not throw).
    const fragErrs = capValidator.materializeHookFragments(structuredClone(cap), stagingDir);
    if (fragErrs.length > 0) {
      throw new Error(`Hook fragment validation failed: ${fragErrs.join('; ')}`);
    }

    // Cross-capability validations (contract, consumes, cross-capability).
    const capMap = new Map<string, unknown>([[id, cap]]);
    const centralKeys = new Set<string>();
    const crossErrs = [
      ...capValidator.validateAgainstContract(cap, id),
      ...capValidator.validateConsumesGlobal(capMap),
      ...capValidator.validateCrossCapability(capMap, centralKeys),
    ];
    if (crossErrs.length > 0) {
      throw new Error(`Cross-capability validation failed: ${crossErrs.join('; ')}`);
    }

    // When promote === false the caller owns the swap (ADR-1244 Phase 4 upgrade path):
    // return the validated staging dir as-is, leaving it on disk for the caller to rename.
    if (!promote) {
      const version = typeof cap['version'] === 'string' ? cap['version'] : '';
      return { id, version, stagedDir: stagingDir, integrity, source };
    }

    // All validation passed — promote staging to final.
    // Replacement is move-aside-then-rename (not rm-then-rename): rename the old
    // bundle aside (atomic), move the new one in, restore the old one if the second
    // rename fails. This avoids leaving the capability missing on a failed swap.
    // (The fully-atomic stage-then-swap with the ledger as commit point — for upgrades —
    // lives in capability-lifecycle.cjs and uses promote:false above.)
    if (fs.existsSync(finalDir)) {
      const backupDir = `${finalDir}.old-${process.pid}-${Date.now()}`;
      fs.renameSync(finalDir, backupDir);
      try {
        fs.renameSync(stagingDir, finalDir);
      } catch (err) {
        try { fs.renameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
        throw err;
      }
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    } else {
      fs.renameSync(stagingDir, finalDir);
    }

    const version = typeof cap['version'] === 'string' ? cap['version'] : '';

    return { id, version, stagedDir: finalDir, integrity, source };
  } catch (err) {
    // Atomicity: always clean up the staging dir on failure.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/**
 * Detect the source kind from a raw spec string.
 *
 * Kind detection rules (first match wins):
 *   local:    starts with `./ | ../ | /` (absolute path)
 *   npm:      starts with `npm:` prefix
 *   tarball:  `https://…` ending in `.tgz` or `.tar.gz`
 *   git:      `https://…git`, URL with `#<ref>`, or starts with `git+`
 *   registry: `<name>@<registry>` form (no URL scheme)
 */
function parseSpec(spec: string): ParsedSpec {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('Capability spec must be a non-empty string');
  }
  const s = spec.trim();

  // local: relative or absolute path
  if (s.startsWith('./') || s.startsWith('../') || path.isAbsolute(s)) {
    return { kind: 'local', raw: spec, target: s };
  }

  // npm: explicit `npm:` prefix
  if (s.startsWith('npm:')) {
    const pkgSpec = s.slice('npm:'.length);
    if (!pkgSpec) throw new Error(`Invalid npm spec: "${spec}" — package spec is empty after "npm:"`);
    assertSafeNpmSpec(pkgSpec);
    return { kind: 'npm', raw: spec, target: pkgSpec };
  }

  // tarball: https URL ending in .tgz or .tar.gz
  if (/^https?:\/\/.+\.t(gz|ar\.gz)$/i.test(s)) {
    return { kind: 'tarball', raw: spec, target: s };
  }

  // git: git+ prefix, https URL ending in .git, or URL with #<ref>
  if (
    s.startsWith('git+') ||
    /^https?:\/\/.+\.git$/i.test(s) ||
    (/^https?:\/\//.test(s) && s.includes('#'))
  ) {
    let url = s.startsWith('git+') ? s.slice('git+'.length) : s;
    let ref: string | undefined;
    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1) {
      ref = url.slice(hashIdx + 1);
      url = url.slice(0, hashIdx);
    }
    assertSafeGitUrl(url);
    if (ref !== undefined && (SHELL_METACHAR_RE.test(ref) || ref.startsWith('-'))) {
      // Leading '-' would be parsed as a git option, not a ref.
      throw new Error(`Unsafe git ref (shell metacharacters or leading dash not allowed): "${ref}"`);
    }
    return { kind: 'git', raw: spec, target: url, ...(ref !== undefined ? { ref } : {}) };
  }

  // registry: <name>@<version-or-registry> — no URL scheme
  if (/^[a-zA-Z0-9@/_-]/.test(s) && !s.startsWith('http')) {
    return { kind: 'registry', raw: spec, target: s };
  }

  throw new Error(`Cannot determine source kind for capability spec: "${spec}"`);
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------

function resolveLocal(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  // #1460 CS-1: a local path is a directory tree, not a single downloadable artifact, so there is
  // no stable byte stream to verify a sha512 SRI pin against. A supplied `--integrity` is therefore
  // REJECTED with an actionable error rather than being silently dropped (the prior behaviour staged
  // with integrity:null, so the user believed content was pinned when it was not).
  if (opts.integrity) {
    throw new Error('integrity pinning is not supported for local sources');
  }

  const absPath = path.resolve(parsed.target);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Local capability path does not exist: ${absPath}`);
  }
  // Read id from capability.json to know the staging dest — via the SHARED bounded reader (#1461
  // finding 2): an oversized/non-regular local capability.json is refused, never read unbounded.
  const manifestPath = path.join(absPath, 'capability.json');
  const cap = readManifestBounded(
    manifestPath,
    `Cannot read capability.json from local path: ${manifestPath}`,
  );
  const id = typeof cap['id'] === 'string' ? cap['id'] : '';
  if (!id) throw new Error('capability.json missing "id" field');

  return stageValidated({ sourceDir: absPath, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
}

function resolveGit(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execGit = opts.execOverrides?.git ?? shellSeam.execGit;

  // #1460 CS-1: a git working tree has no single downloadable artifact to verify a sha512 SRI pin
  // against (a clone is a directory tree, and the digest would vary with pack/checkout details). A
  // supplied `--integrity` is therefore REJECTED with an actionable error rather than silently
  // dropped (the prior behaviour staged with integrity:null). Pin a git source by COMMIT instead.
  if (opts.integrity) {
    throw new Error('integrity pinning is not supported for git sources; pin the commit with #sha:<commit>');
  }

  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-git-'));
  try {
    // Clone (copy only — no hooks execute on clone, no npm install).
    const cloneResult = execGit(['clone', '--depth', '1', '--', parsed.target, cloneDir], { timeout: 60_000 });
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`);
    }

    // Optional ref checkout. The ref is a commit-ish (tag/branch/sha), NOT a path,
    // so it goes BEFORE the `--` pathspec terminator (a leading-dash ref is rejected
    // at parse time, so it cannot be misread as an option here).
    if (parsed.ref) {
      const checkoutResult = execGit(['-C', cloneDir, 'checkout', parsed.ref, '--'], { timeout: 60_000 });
      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `git checkout "${parsed.ref}" failed (exit ${checkoutResult.exitCode}): ${checkoutResult.stderr}`
        );
      }
    }

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): a cloned repo's
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(cloneDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in cloned repo: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir: cloneDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function resolveNpm(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execNpm = opts.execOverrides?.npm ?? shellSeam.execNpm;
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  const tmpPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-pack-'));
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-ext-'));

  try {
    // npm pack — creates a tarball. CRITICAL: `npm pack` runs prepack/prepare
    // lifecycle scripts by default, which would EXECUTE fetched code — so we pass
    // --ignore-scripts to guarantee copy-only. NEVER npm install.
    const packResult = execNpm(
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmpPackDir, '--', parsed.target],
      { timeout: 60_000 }
    );
    if (packResult.exitCode !== 0) {
      throw new Error(`npm pack failed (exit ${packResult.exitCode}): ${packResult.stderr}`);
    }

    // Locate the produced .tgz.
    const tarballs = fs.readdirSync(tmpPackDir).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      throw new Error(`npm pack produced no .tgz in ${tmpPackDir}`);
    }
    const tgzPath = path.join(tmpPackDir, tarballs[0]);

    // #1460 CS-1: a supplied `--integrity` is verified over the `.tgz` BYTES (same SRI sha512
    // domain as the tarball adapter) BEFORE anything is staged or promoted — never silently
    // dropped. The recorded integrity is always the computed digest of the produced tarball.
    // `npm pack --ignore-scripts` (above) ran no capability code, so reading these bytes is
    // copy-only. A mismatch throws here, before assertSafeTarMembers / extraction / staging.
    const tgzBytes = readPackTarball(tgzPath);
    const computedIntegrity = computeIntegrity(tgzBytes);
    if (opts.integrity) {
      verifyIntegrity(tgzBytes, opts.integrity);
    }

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    // Extract — copy only, no scripts. npm tarballs nest under package/.
    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // npm tarballs nest under package/; fall back to root.
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): an extracted
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(sourceDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found after npm pack extraction from: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: computedIntegrity, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(tmpPackDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function resolveTarball(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): Promise<ResolveResult> {
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  // Fetch buffer — always reject non-200 (realHttpsGet enforces this).
  const resp = await _httpGet(parsed.target);

  // Integrity check BEFORE any bytes touch disk (if provided).
  const computedIntegrity = computeIntegrity(resp.body);
  if (opts.integrity) {
    verifyIntegrity(resp.body, opts.integrity);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-tar-'));
  const tgzPath = path.join(extractDir, '_download.tgz');

  try {
    fs.writeFileSync(tgzPath, resp.body);

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // Locate capability.json — root or package/ (npm tarball shape).
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json via the SHARED bounded reader (#1461 finding 2): an extracted
    // oversized/non-regular capability.json is refused, never read unbounded.
    const manifestPath = path.join(sourceDir, 'capability.json');
    const cap = readManifestBounded(
      manifestPath,
      `capability.json not found in tarball from: ${parsed.target}`,
    );
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: computedIntegrity, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a capability spec, validate it, and stage it into the GSD capabilities dir.
 *
 * @param spec  - Source spec string. Kind auto-detected via parseSpec.
 * @param opts  - Optional overrides for hostVersion, gsdHome, integrity, exec/http seams.
 * @returns     - Resolved bundle descriptor with stagedDir path.
 */
async function resolveCapabilitySource(spec: string, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const parsed = parseSpec(spec);

  const hostVersion = opts.hostVersion ?? readHostVersion();
  const gsdHome = opts.gsdHome ?? process.env['GSD_HOME'] ?? os.homedir();

  switch (parsed.kind) {
    case 'local':
      return resolveLocal(parsed, opts, gsdHome, hostVersion);
    case 'git':
      return resolveGit(parsed, opts, gsdHome, hostVersion);
    case 'npm':
      return resolveNpm(parsed, opts, gsdHome, hostVersion);
    case 'tarball':
      return resolveTarball(parsed, opts, gsdHome, hostVersion);
    case 'registry':
      throw new Error(
        'registry source kind is not yet implemented (no first-party registry endpoint)'
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = parsed.kind;
      throw new Error(`Unknown source kind: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  resolveCapabilitySource,
  parseSpec,
  _setCapabilitySourceHttpGet,
  _setHttpsGetImpl,
  // #1461 finding 3 test seam: the exact bounded reader stageValidated uses on the COPIED manifest, so
  // a test can exercise the staged re-read directly (not just the local pre-read that shadows it).
  _readManifestBounded: readManifestBounded,
  MAX_RESPONSE_BYTES,
  MANIFEST_MAX_BYTES,
  MAX_STAGED_BUNDLE_BYTES,
  MAX_STAGED_BUNDLE_ENTRIES,
};

/**
 * Install manifest per-file hash ownership (#5683).
 *
 * `gsd-file-manifest.json` records `sha256(file bytes)` per installed file,
 * keyed by path relative to the runtime config dir. `effort sync --apply`
 * rewrites installed agents, so it re-records exactly those files here.
 * `bin/install.js` fileHash delegates to this module: one hash function.
 */

import {
  readFileSync, writeFileSync, unlinkSync, statSync, openSync, closeSync, fchmodSync, fstatSync, readSync,
  constants as fsConstants,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { retryRenameSync } from './shell-command-projection.cjs';

const MANIFEST_NAME = 'gsd-file-manifest.json';

/** SHA256 (lowercase hex) of a file's bytes — the manifest's per-file hash. */
export function fileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** A file the sync rewrote, with its on-disk hash captured BEFORE the rewrite (null when unreadable). */
export interface RewrittenFile {
  path: string;
  preHash: string | null;
  /**
   * Manifest key, when it is not `path` relative to the config dir: a skill
   * under a skills root outside the config dir (Codex `~/.agents/skills`) is
   * recorded under the runtime's skills manifest prefix (#6331).
   */
  key?: string;
}

/** Read size for tryFileHash's chunked hash. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * fileHash that returns null instead of throwing, for a pre-rewrite hash. A
 * manifest key can name a FIFO, whose blocking read never returns (#6331), so
 * the open is non-blocking, the type is checked on the descriptor, and only a
 * regular file is read: exactly the size fstat reported, in chunks, with no
 * size cap, so it matches the installer's fileHash. It returns null when the
 * size, mtime or ctime (ns) changed during the read, or the path no longer
 * names the file read. A same-size rewrite inside one timestamp tick of the
 * filesystem changes none of them, which no stat comparison can detect.
 *
 * The open follows a leaf symlink on purpose: the key resolver already refuses
 * a symlinked component unless the user opted into symlinked destinations,
 * where one is legitimate, and a swap after its check needs write access to
 * the config dir, which could edit the manifest directly.
 */
export function tryFileHash(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    const size = Number(st.size);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(size, HASH_CHUNK_BYTES)));
    let left = size;
    while (left > 0) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, left), null);
      if (n === 0) return null; // the file shrank while it was read: no partial hash
      hash.update(buf.subarray(0, n));
      left -= n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) return null;
    const named = statSync(filePath, { bigint: true }); // follows a leaf symlink, as the open did
    if (named.dev !== st.dev || named.ino !== st.ino) return null; // replaced while it was read
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Update ONLY the manifest entries for `rewritten` files (under `configDir`),
 * and only those that were GSD-owned before the rewrite: `preHash` equal to the
 * recorded manifest entry. A file the user had already edited keeps its stale
 * entry so the next install still detects it and backs it up.
 * Returns false without writing when the manifest is absent, unparseable or
 * not the documented shape, or changed on disk (recordManifestFileHashesResult
 * says which); publishes via tmp + rename, keeping the manifest's
 * file mode. The installer writes the manifest without a lock, so there is no
 * lock to share. Conflict detection is best effort: when the manifest changed
 * on disk since it was read (a concurrent install), nothing is written. An
 * install that writes between that check and the rename can still be
 * overwritten; only a lock both writers take would close that window.
 */
export function recordManifestFileHashes(configDir: string, rewritten: readonly RewrittenFile[]): boolean {
  return recordManifestFileHashesResult(configDir, rewritten) === 'written';
}

/**
 * Why a record did or did not write (#6331): `written`; `unchanged` (no entry
 * GSD still owned changed); `unavailable` (the manifest is absent, unparseable,
 * not the documented shape, or the write failed); `conflict` (the manifest
 * changed on disk after it was read, so nothing was written). A caller that
 * reports to the user names a `conflict`, since its re-staged files stay
 * unrecorded until the next re-stage or install.
 */
export type ManifestRecordResult = 'written' | 'unchanged' | 'unavailable' | 'conflict';

/** recordManifestFileHashes, returning why it did or did not write. */
export function recordManifestFileHashesResult(configDir: string, rewritten: readonly RewrittenFile[]): ManifestRecordResult {
  if (rewritten.length === 0) return 'unchanged';
  const manifestPath = join(configDir, MANIFEST_NAME);
  let manifest: Record<string, unknown>;
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unavailable';
    manifest = parsed as Record<string, unknown>;
  } catch {
    return 'unavailable';
  }
  const files = manifest['files'];
  if (!files || typeof files !== 'object' || Array.isArray(files)) return 'unavailable';

  const entries = files as Record<string, string>;
  let changed = false;
  for (const { path: absPath, preHash, key } of rewritten) {
    const rel = key ?? relative(configDir, absPath).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (preHash === null || entries[rel] !== preHash) continue;
    const hash = tryFileHash(absPath);
    if (hash === null) continue; // unreadable or not a regular file: leave its entry as recorded
    entries[rel] = hash;
    changed = true;
  }
  if (!changed) return 'unchanged';

  // An unpredictable name, created exclusively: nothing planted at a guessable
  // path (a symlink, a directory) can redirect or block the write.
  let tmpPath = '';
  let created = false; // only a tmp file this call created is ever removed
  try {
    tmpPath = `${manifestPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
    const mode = statSync(manifestPath).mode & 0o7777;
    const fd = openSync(tmpPath, 'wx', mode);
    created = true;
    try {
      writeFileSync(fd, JSON.stringify(manifest, null, 2));
      fchmodSync(fd, mode); // the umask may have narrowed the create mode
    } finally {
      closeSync(fd);
    }
    // #6331: best effort; a concurrent install rewrote the manifest after it was read.
    if (readFileSync(manifestPath, 'utf8') !== raw) {
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
      return 'conflict';
    }
    retryRenameSync(tmpPath, manifestPath);
    return 'written';
  } catch {
    if (created) {
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
    }
    return 'unavailable';
  }
}

/**
 * Install manifest per-file hash ownership (#5683).
 *
 * `gsd-file-manifest.json` records `sha256(file bytes)` per installed file,
 * keyed by path relative to the runtime config dir. `effort sync --apply`
 * rewrites installed agents, so it re-records exactly those files here.
 * `bin/install.js` fileHash delegates to this module: one hash function.
 */

import { readFileSync, writeFileSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
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

/** fileHash that returns null instead of throwing — for capturing a pre-rewrite hash. */
export function tryFileHash(filePath: string): string | null {
  try { return fileHash(filePath); } catch { return null; }
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
    try {
      entries[rel] = fileHash(absPath);
      changed = true;
    } catch { /* unreadable file: leave its entry as recorded */ }
  }
  if (!changed) return 'unchanged';

  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  try {
    const mode = statSync(manifestPath).mode & 0o7777;
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { mode });
    chmodSync(tmpPath, mode); // the umask may have narrowed the create mode
    // #6331: best effort; a concurrent install rewrote the manifest after it was read.
    if (readFileSync(manifestPath, 'utf8') !== raw) {
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
      return 'conflict';
    }
    retryRenameSync(tmpPath, manifestPath);
    return 'written';
  } catch {
    try { unlinkSync(tmpPath); } catch { /* already gone or never created */ }
    return 'unavailable';
  }
}

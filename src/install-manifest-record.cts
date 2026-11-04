/**
 * Install manifest per-file hash ownership (#5683).
 *
 * `gsd-file-manifest.json` records `sha256(file bytes)` per installed file,
 * keyed by path relative to the runtime config dir. `effort sync --apply`
 * rewrites installed agents, so it re-records exactly those files here.
 * `bin/install.js` fileHash delegates to this module: one hash function.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { retryRenameSync } from './shell-command-projection.cjs';

const MANIFEST_NAME = 'gsd-file-manifest.json';

/** SHA256 (lowercase hex) of a file's bytes — the manifest's per-file hash. */
export function fileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Update ONLY the manifest entries for `absPaths` (files under `configDir`).
 * Skips silently (returns false) when the manifest is absent, unparseable or
 * not the documented shape; publishes via tmp + rename.
 */
export function recordManifestFileHashes(configDir: string, absPaths: readonly string[]): boolean {
  if (absPaths.length === 0) return false;
  const manifestPath = join(configDir, MANIFEST_NAME);
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    manifest = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  const files = manifest['files'];
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;

  const entries = files as Record<string, string>;
  let changed = false;
  for (const absPath of absPaths) {
    const rel = relative(configDir, absPath).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      entries[rel] = fileHash(absPath);
      changed = true;
    } catch { /* unreadable file: leave its entry as recorded */ }
  }
  if (!changed) return false;

  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
    retryRenameSync(tmpPath, manifestPath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* already gone or never created */ }
    return false;
  }
}

/**
 * Installer migration 004: remove stale gsd-pristine/get-shit-done/ snapshot // gsd-allow-legacy-name
 * files after the get-shit-done → gsd-core rename (#604, #934).
 *
 * Background: migration 003 removed legacy runtime files from
 * get-shit-done/ but did not touch gsd-pristine/get-shit-done/, the // gsd-allow-legacy-name
 * parallel directory that holds pristine snapshots captured before the rename.
 * These snapshot files are GSD-managed (written by the installer, never by the
 * user) and reference stale get-shit-done/... key paths that no longer exist // gsd-allow-legacy-name
 * in the active layout. When verify-reapply-patches.cjs looks up a backup entry
 * keyed under gsd-core/... it finds no matching gsd-pristine/ snapshot, falls
 * to over-broad mode, and reports false FAIL_INSTALLED_MISSING / // gsd-allow-legacy-name
 * FAIL_USER_LINES_MISSING for every backed-up pre-rename file (#934).
 *
 * Fix: walk gsd-pristine/get-shit-done/ and emit remove-managed for each file. // gsd-allow-legacy-name
 * These files are always GSD-written snapshots — users never place their own
 * files inside gsd-pristine/ — so the classification override
 * (managed-pristine) is safe: there is no user content to protect.
 *
 * Checksum safety: migration 003's body is left untouched.  Adding this
 * separate migration avoids modifying 003's checksum, which would break
 * upgrade state for any user who already applied 003 (root cause of #670).
 *
 * Per-file approach: the migration framework has no recursive directory-removal
 * primitive — all actions operate on individual files. Empty directory shells
 * left after removal can be cleaned up manually; this is the intentional ADR-0008
 * limitation.
 */

import fs from 'node:fs';
import path from 'node:path';

interface MigrationAction {
  type: string;
  relPath: string;
  reason: string;
  ownershipEvidence: string;
  classification?: string;
}

interface MigrationPlanContext {
  configDir: string;
  classifyArtifact(relPath: string): { classification: string; [key: string]: unknown };
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  scopes: string[];
  destructive: boolean;
  plan(ctx: MigrationPlanContext): MigrationAction[];
}

function walkPristineFiles(root: string, relDir: string, baseResolved: string, results: string[]): void {
  const dir = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory absent or unreadable — nothing to do
  }
  for (const entry of entries) {
    // Do not follow symlinks — skip to avoid out-of-tree traversal.
    if (entry.isSymbolicLink()) continue;
    const relPath = path.posix.join(relDir, entry.name);
    // Bounds check: ensure the resolved path stays under configDir.
    const resolved = path.resolve(root, relPath);
    if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      walkPristineFiles(root, relPath, baseResolved, results);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
}

const REASON = 'stale pristine snapshot from legacy get-shit-done/ dir, orphaned by rename migration 003 (#604, #934)'; // gsd-allow-legacy-name

const migration: InstallerMigration = {
  id: '2026-06-09-prune-stale-pristine-get-shit-done', // gsd-allow-legacy-name
  title: 'Remove stale gsd-pristine/get-shit-done/ snapshot files (#934)', // gsd-allow-legacy-name
  description:
    'Migration 003 removed runtime files from get-shit-done/ but left the matching pristine snapshot ' + // gsd-allow-legacy-name
    'directory gsd-pristine/get-shit-done/ intact. Those snapshots reference stale key paths and cause ' + // gsd-allow-legacy-name
    'verify-reapply-patches false positives (#934). Remove all files under gsd-pristine/get-shit-done/ ' + // gsd-allow-legacy-name
    'as they are GSD-managed snapshots, never user content.',
  introducedIn: '1.4.3',
  scopes: ['global', 'local'],
  destructive: true,
  plan(ctx: MigrationPlanContext): MigrationAction[] {
    const pristineGsdRoot = path.join(ctx.configDir, 'gsd-pristine', 'get-shit-done'); // gsd-allow-legacy-name

    // Idempotency: if the stale pristine subdir doesn't exist, nothing to do.
    if (!fs.existsSync(pristineGsdRoot)) return [];

    // Safety: reject symlinks in ANY ancestor component of the path we will walk
    // to prevent following a symlink out of configDir.  Check both gsd-pristine/
    // and gsd-pristine/get-shit-done/ — either being a symlink could redirect
    // the walk to an out-of-tree location.
    const pristineParent = path.join(ctx.configDir, 'gsd-pristine');
    try {
      if (fs.lstatSync(pristineParent).isSymbolicLink()) return [];
    } catch {
      return [];
    }
    try {
      if (fs.lstatSync(pristineGsdRoot).isSymbolicLink()) return []; // gsd-allow-legacy-name
    } catch {
      return [];
    }

    const baseResolved = path.resolve(ctx.configDir);
    const relPaths: string[] = [];
    walkPristineFiles(ctx.configDir, path.posix.join('gsd-pristine', 'get-shit-done'), baseResolved, relPaths); // gsd-allow-legacy-name

    const actions: MigrationAction[] = [];
    for (const relPath of relPaths) {
      // Bounds-check each relPath before emitting any action.
      const resolved = path.resolve(ctx.configDir, relPath);
      if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) continue;

      // These files are GSD-managed pristine snapshots — the installer writes
      // them during install/upgrade; users never place personal files inside
      // gsd-pristine/.  Pass classification: 'managed-pristine' explicitly so
      // the framework does not downgrade remove-managed to preserve-user when
      // the manifest has no entry (these paths were never in the manifest since
      // they live under gsd-pristine/, not the tracked runtime dir).
      actions.push({
        type: 'remove-managed',
        relPath,
        reason: REASON,
        ownershipEvidence:
          'GSD-written pristine snapshot under gsd-pristine/get-shit-done/; ' + // gsd-allow-legacy-name
          'installer is the sole author of gsd-pristine/ contents; no user content lives here',
        classification: 'managed-pristine',
      });
    }

    return actions;
  },
};

export = migration;

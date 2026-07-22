/**
 * Installer migration 005: baseline pre-existing OpenCode commands/ (plural)
 * files during the first-time installer migration baseline scan (#2329
 * follow-up).
 *
 * Background: #2329 moved OpenCode's slash-command install target from the
 * legacy singular `command/` alias to the documented plural `commands/`
 * convention. The first-time baseline scan migration
 * (2026-05-11-first-time-baseline-scan, 000-first-time-baseline.cts) is a
 * SHIPPED migration body — docs/installer-migrations.md#state-files requires
 * shipped migration bodies stay immutable so an already-applied migration's
 * checksum never drifts for a user who ran it before this fix (issue #670).
 * Its RUNTIME_SURFACES.opencode list still only names the legacy `command`
 * directory, so the baseline scan never classified pre-existing files under
 * `commands/` before this fix.
 *
 * Consequence proven by probe (see tests/installer-migrations.test.cjs): a
 * pre-existing, unmanifested file at `commands/gsd-<name>.md` that predates
 * any GSD install is silently destroyed by ordinary OpenCode command
 * materialization (which unconditionally removes every `gsd-*.md` file under
 * its destination before writing the fresh set) with a clean exit code — no
 * report, no backup, no prompt. The identical scenario under the
 * already-covered legacy `command/` surface instead halts the install with a
 * blocked `prompt-user` action, exactly as designed. This migration closes
 * that gap for `commands/` without editing 000's shipped body.
 *
 * This is a NEW fix-forward migration id (per
 * docs/installer-migrations.md#state-files) rather than an edit to 000: an
 * already-applied migration never re-runs, so editing 000 would only protect
 * fresh installs and leave every machine that already applied 000
 * permanently unprotected for `commands/`. A new id runs for both
 * populations (installs that never ran a baseline scan AND installs that
 * already applied the original 000 scan) and drifts no checksum.
 *
 * Scope: OpenCode only. Kilo shares the same combined-family install path,
 * but its command directory descriptor is still the singular `command/`
 * (already covered by 000's RUNTIME_SURFACES.kilo), so this migration must
 * never touch Kilo installs — enforced by the `runtimes: ['opencode']`
 * scoping below.
 *
 * Classification mirrors 000-first-time-baseline.cts exactly (record-baseline
 * for manifest-proven files, prompt-user for stale-GSD-looking unmanifested
 * files, baseline-preserve-user for everything else) — this migration only
 * widens the surface scanned, not the classification policy.
 */

import fs from 'node:fs';
import path from 'node:path';

const SURFACE = 'commands';

interface ClassifiedArtifact {
  classification: string;
  originalHash?: string | null;
  currentHash?: string | null;
  [key: string]: unknown;
}

interface BaselineAction {
  type: string;
  relPath: string;
  reason: string;
  classification?: string;
  originalHash?: string | null;
  currentHash?: string | null;
  prompt?: string;
  choices?: string[];
}

interface PlanContext {
  configDir: string;
  baselineScan?: boolean;
  classifyArtifact: (relPath: string) => ClassifiedArtifact;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  runtimes: string[];
  scopes: string[];
  destructive: boolean;
  plan: (ctx: PlanContext) => BaselineAction[];
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function walkFiles(root: string, relDir: string, files: Set<string>): void {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, relPath, files);
    } else if (entry.isFile()) {
      files.add(normalizeRelPath(relPath));
    }
  }
}

function scanCommandsSurface(configDir: string): string[] {
  const relPaths = new Set<string>();
  const fullPath = path.join(configDir, SURFACE);
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    walkFiles(configDir, SURFACE, relPaths);
  } else if (stat.isFile()) {
    relPaths.add(SURFACE);
  }
  return [...relPaths];
}

function isStaleGsdLookingPath(relPath: string): boolean {
  return /^gsd[-_]/.test(path.posix.basename(relPath));
}

function baselineActionRank(action: BaselineAction): number {
  if (action.type === 'record-baseline') return 0;
  if (action.type === 'baseline-preserve-user') return 1;
  return 2;
}

const migration: InstallerMigration = {
  id: '2026-07-17-opencode-baseline-commands-dir',
  title: "Baseline OpenCode's commands/ directory in the first-time scan (#2329 follow-up)",
  description:
    "Classify pre-existing files under OpenCode's commands/ (plural) directory during the first-time installer " +
    'migration baseline scan. #2329 moved OpenCode command materialization from the legacy command/ alias to ' +
    "commands/, but the shipped 000-first-time-baseline.cts RUNTIME_SURFACES.opencode list is immutable and still " +
    'only names command/; this fix-forward migration widens the scanned surface without editing the shipped body.',
  introducedIn: '1.7.0',
  runtimes: ['opencode'],
  scopes: ['global', 'local'],
  destructive: false,
  plan: ({ configDir, baselineScan, classifyArtifact }: PlanContext): BaselineAction[] => {
    if (!baselineScan) return [];

    const actions: BaselineAction[] = [];
    for (const relPath of scanCommandsSurface(configDir)) {
      const artifact = classifyArtifact(relPath);
      if (artifact.classification === 'managed-pristine' || artifact.classification === 'managed-modified') {
        actions.push({
          type: 'record-baseline',
          relPath,
          reason: 'existing manifest-managed OpenCode commands/ file included in first-time migration baseline',
        });
        continue;
      }

      const currentHash = artifact.currentHash ?? null;
      if (isStaleGsdLookingPath(relPath)) {
        actions.push({
          type: 'prompt-user',
          relPath,
          reason: 'GSD-looking file is not proven manifest-managed and needs explicit user choice',
          classification: 'stale-gsd-looking',
          originalHash: artifact.originalHash ?? null,
          currentHash,
          prompt: 'Choose whether to remove this stale-looking GSD artifact or keep it as user-owned.',
          choices: ['keep', 'remove'],
        });
        continue;
      }

      actions.push({
        type: 'baseline-preserve-user',
        relPath,
        reason: 'unknown OpenCode commands/ file preserved by first-time migration baseline',
        classification: artifact.classification,
        originalHash: artifact.originalHash ?? null,
        currentHash,
      });
    }

    return actions.sort(
      (left, right) =>
        baselineActionRank(left) - baselineActionRank(right) || left.relPath.localeCompare(right.relPath)
    );
  },
};

export = migration;

/**
 * Installer migration: remove manifest-managed legacy orphan hook files
 * (ADR-457 build-at-publish: the hand-written
 * bin/lib/installer-migrations/001-legacy-orphan-files.cjs collapsed to a
 * TypeScript source of truth). Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

type ArtifactClassification = string;

interface ClassifiedArtifact {
  classification: ArtifactClassification;
  [key: string]: unknown;
}

type ActionType = 'remove-managed' | 'backup-and-remove';

interface MigrationAction {
  type: ActionType;
  relPath: string;
  reason: string;
  ownershipEvidence: string;
}

interface MigrationPlanContext {
  classifyArtifact(relPath: string): ClassifiedArtifact;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  scopes: string[];
  destructive: boolean;
  plan: (ctx: MigrationPlanContext) => MigrationAction[];
}

const LEGACY_ORPHAN_FILES: ReadonlyArray<string> = [
  'hooks/gsd-notify.sh',
  'hooks/statusline.js',
];

const migration: InstallerMigration = {
  id: '2026-05-11-legacy-orphan-files',
  title: 'Remove manifest-managed legacy orphan hook files',
  description: 'Remove legacy orphan hook files that are still manifest-managed.',
  introducedIn: '1.50.0',
  scopes: ['global', 'local'],
  destructive: true,
  // Retired generated hook files are removed only with manifest-managed
  // evidence. This follows docs/installer-migrations.md#ownership and avoids
  // relying on whether a runtime currently registers host hook config in the
  // runtime contract registry.
  plan: (ctx: MigrationPlanContext): MigrationAction[] => {
    const actions: MigrationAction[] = [];
    for (const relPath of LEGACY_ORPHAN_FILES) {
      const artifact = ctx.classifyArtifact(relPath);
      if (artifact.classification === 'managed-pristine') {
        actions.push({
          type: 'remove-managed',
          relPath,
          reason: 'legacy orphan hook file retired by installer migration',
          ownershipEvidence: 'legacy hook path is manifest-managed in gsd-file-manifest.json',
        });
      } else if (artifact.classification === 'managed-modified') {
        actions.push({
          type: 'backup-and-remove',
          relPath,
          reason: 'legacy orphan hook file retired by installer migration',
          ownershipEvidence: 'legacy hook path is manifest-managed in gsd-file-manifest.json',
        });
      }
    }
    return actions;
  },
};

export = migration;

'use strict';

const fs = require('fs');
const path = require('path');
const { ROADMAP_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeCjsCommandFamily } = require('./cjs-command-router-adapter.cjs');
const roadmapUpgrade = require('./roadmap-upgrade.cjs');
const { planningDir } = require('./planning-workspace.cjs');
const { loadConfig } = require('./core.cjs');

/**
 * Check each phase entry in a milestone-prefixed ROADMAP.md for W021 violations.
 *
 * W021: a phase whose ID integer prefix does not match its enclosing milestone's
 * major version number.
 *
 * Sentinel milestones (0 = pre-milestone, 999 = backlog) are exempt.
 *
 * @param {string} content - ROADMAP.md content
 * @returns {Array<{code:'W021', message:string}>}
 */
function checkW021(content) {
  const warnings = [];

  // Sentinel milestone integers exempt from W021
  const SENTINELS = new Set([0, 999]);
  const MIGRATION_CMD = 'gsd-tools roadmap upgrade --convention milestone-prefixed';

  // Milestone section heading: ## [GSD] v2.0 — Label  OR  ## v2.0: Label  OR  ## Roadmap v2.0
  //   OR  ## ✅ v2.0  OR  ## 🚧 v2.0  (emoji-prefixed variants used by roadmap templates)
  // Capture the major integer.
  const MILESTONE_RE = /^#{1,3}\s+(?:\[[^\]]+\]\s+|Roadmap\s+|[✅🚧]\s*)?v(\d+)\.\d+(?:\s|:|\s*—)/iu;

  // Migrated phase heading: ### Phase M-NN: Name  (M-NN or unpadded M-N form)
  // \d+ on the sub-segment tolerates unpadded forms like Phase 2-1: as well as Phase 2-01:
  const PHASE_RE = /^#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+(\d+)-(\d+)(?:-\d+)*\s*:/i;

  let currentMilestoneMajor = null;
  const lines = content.split('\n');

  for (const line of lines) {
    const milestoneMatch = line.match(MILESTONE_RE);
    if (milestoneMatch) {
      currentMilestoneMajor = parseInt(milestoneMatch[1], 10);
      continue;
    }

    const phaseMatch = line.match(PHASE_RE);
    if (phaseMatch) {
      const phaseMajor = parseInt(phaseMatch[1], 10);
      if (SENTINELS.has(phaseMajor)) continue; // exempt

      if (currentMilestoneMajor !== null && phaseMajor !== currentMilestoneMajor) {
        const phaseId = `${phaseMatch[1]}-${phaseMatch[2]}`;
        warnings.push({
          code: 'W021',
          message:
            `Phase ID prefix mismatch: phase "${phaseId}" is listed under v${currentMilestoneMajor}.x ` +
            `but its prefix (${phaseMajor}) does not match. ` +
            `Run \`${MIGRATION_CMD}\` to fix.`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Manifest-backed roadmap subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 */
function routeRoadmapCommand({ roadmap, args, cwd, raw, error }) {
  routeCjsCommandFamily({
    args,
    subcommands: ROADMAP_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand, available) => `Unknown roadmap subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'get-phase': () => roadmap.cmdRoadmapGetPhase(cwd, args[2], raw),
      analyze: () => roadmap.cmdRoadmapAnalyze(cwd, raw),
      'update-plan-progress': () => roadmap.cmdRoadmapUpdatePlanProgress(cwd, args[2], raw),
      'annotate-dependencies': () => roadmap.cmdRoadmapAnnotateDependencies(cwd, args[2], raw),
      'validate': () => {
        const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
        let roadmapContent = '';
        try {
          roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
        } catch {
          // ROADMAP.md missing — return empty warnings
        }

        // W021 only fires when phase_id_convention is explicitly 'milestone-prefixed'.
        // Authoritative source: .planning/config.json (set by the upgrade command).
        // Fallback: ROADMAP.md frontmatter (for projects that set the field there directly).
        let convention;
        try {
          const cfg = loadConfig(cwd);
          convention = cfg.phase_id_convention;
        } catch {
          convention = undefined;
        }
        if (convention === undefined || convention === null) {
          // Fallback: read from ROADMAP.md frontmatter
          const fmMatch = roadmapContent.match(/^---\r?\n([\s\S]+?)\r?\n---/);
          if (fmMatch) {
            const kvMatch = fmMatch[1].match(/^phase_id_convention:\s*(.*)$/m);
            if (kvMatch) {
              const val = kvMatch[1].trim();
              if (val !== 'null' && val !== '') {
                convention = val.replace(/^["']|["']$/g, '');
              }
            }
          }
        }
        const warnings = (convention === 'milestone-prefixed')
          ? checkW021(roadmapContent)
          : [];

        const result = { warnings };
        if (raw) process.stdout.write(JSON.stringify(result));
        else process.stdout.write(JSON.stringify(result, null, 2));
      },
      'upgrade': () => {
        const dryRun = !args.includes('--apply');
        const convention = args.find((a, i) => args[i-1] === '--convention') || 'milestone-prefixed';
        if (convention !== 'milestone-prefixed') {
          process.stderr.write('Only --convention milestone-prefixed is supported\n');
          process.exit(1);
        }
        const plan = roadmapUpgrade.computeMigrationPlan(cwd);
        roadmapUpgrade.applyMigration(cwd, plan, { dryRun });
      },
    },
  });
}

module.exports = {
  routeRoadmapCommand,
};

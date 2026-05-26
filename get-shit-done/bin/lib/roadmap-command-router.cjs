'use strict';

const { ROADMAP_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeCjsCommandFamily } = require('./cjs-command-router-adapter.cjs');

/**
 * Manifest-backed roadmap subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 6: all roadmap.* subcommands have SDK equivalents and are dispatched
 * via executeForCjs (the sync bridge). CJS fallback retained when:
 * - GSD_WORKSTREAM is active (workstream-scoped requests fall through to CJS).
 * - SDK is unavailable (build not present).
 *
 * CJS-only subcommands: none.
 * SDK-only (unsupported in CJS router): none.
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
    },
  });
}

module.exports = {
  routeRoadmapCommand,
};

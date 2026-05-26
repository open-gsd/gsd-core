'use strict';

const { VERIFY_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeCjsCommandFamily } = require('./cjs-command-router-adapter.cjs');

/**
 * Manifest-backed verify subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 6: all verify.* subcommands have SDK equivalents and are dispatched
 * via executeForCjs (the sync bridge). CJS fallback retained when:
 * - GSD_WORKSTREAM is active (workstream-scoped requests fall through to CJS).
 * - SDK is unavailable (build not present).
 *
 * CJS-only subcommands: none.
 * SDK-only (unsupported in CJS router): none.
 */
function routeVerifyCommand({ verify, args, cwd, raw, error }) {
  routeCjsCommandFamily({
    args,
    subcommands: VERIFY_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand, available) => `Unknown verify subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'plan-structure': () => verify.cmdVerifyPlanStructure(cwd, args[2], raw),
      'phase-completeness': () => verify.cmdVerifyPhaseCompleteness(cwd, args[2], raw),
      references: () => verify.cmdVerifyReferences(cwd, args[2], raw),
      commits: () => verify.cmdVerifyCommits(cwd, args.slice(2), raw),
      artifacts: () => verify.cmdVerifyArtifacts(cwd, args[2], raw),
      'key-links': () => verify.cmdVerifyKeyLinks(cwd, args[2], raw),
      'schema-drift': () => {
        const rest = args.slice(2);
        const skipFlag = rest.includes('--skip');
        const phaseArg = rest.find((arg) => !arg.startsWith('-'));
        verify.cmdVerifySchemaDrift(cwd, phaseArg, skipFlag, raw);
      },
      // verify codebase-drift dispatches direct to CJS — drift is out-of-seam
      // per ADR/PRD 3524 §3 / L160 (CJS-only by design). Routing through
      // sdkHandler would re-enter the SDK bridge, and Phase 6's removed
      // verifyCodebaseDrift stub used to execFileSync back to the CLI,
      // creating an infinite spawn loop.
      'codebase-drift': () => verify.cmdVerifyCodebaseDrift(cwd, raw),
    },
  });
}

module.exports = {
  routeVerifyCommand,
};

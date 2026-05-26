'use strict';

const { VERIFY_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeCjsCommandFamily } = require('./cjs-command-router-adapter.cjs');

/**
 * Manifest-backed verify subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
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
      // recursive dispatch would re-enter this router path.
      'codebase-drift': () => verify.cmdVerifyCodebaseDrift(cwd, raw),
    },
  });
}

module.exports = {
  routeVerifyCommand,
};

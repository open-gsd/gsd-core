'use strict';

const { INIT_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeCjsCommandFamily } = require('./cjs-command-router-adapter.cjs');
const { parseNamedArgs } = require('./command-arg-projection.cjs');

/**
 * Manifest-backed init subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 6: all init.* subcommands have SDK equivalents and are dispatched
 * via executeForCjs (the sync bridge). CJS fallback retained when:
 * - GSD_WORKSTREAM is active (workstream-scoped requests fall through to CJS).
 * - SDK is unavailable (build not present).
 *
 * CJS-only subcommands: none.
 * SDK-only (unsupported in CJS router): none.
 */
function routeInitCommand({ init, args, cwd, raw, error }) {
  routeCjsCommandFamily({
    args,
    subcommands: INIT_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand, available) => `Unknown init workflow: ${_subcommand}\nAvailable: ${available.join(', ')}`,
    handlers: {
      'execute-phase': () => {
        const { validate: epValidate, tdd: epTdd } = parseNamedArgs(args, [], ['validate', 'tdd']);
        init.cmdInitExecutePhase(cwd, args[2], raw, { validate: epValidate, tdd: epTdd });
      },
      'plan-phase': () => {
        const { validate: ppValidate, tdd: ppTdd } = parseNamedArgs(args, [], ['validate', 'tdd']);
        init.cmdInitPlanPhase(cwd, args[2], raw, { validate: ppValidate, tdd: ppTdd });
      },
      'new-project': () => init.cmdInitNewProject(cwd, raw),
      'new-milestone': () => init.cmdInitNewMilestone(cwd, raw),
      quick: () => init.cmdInitQuick(cwd, args.slice(2).join(' '), raw),
      'ingest-docs': () => init.cmdInitIngestDocs(cwd, raw),
      resume: () => init.cmdInitResume(cwd, raw),
      'verify-work': () => init.cmdInitVerifyWork(cwd, args[2], raw),
      'phase-op': () => init.cmdInitPhaseOp(cwd, args[2], raw),
      todos: () => init.cmdInitTodos(cwd, args[2], raw),
      'milestone-op': () => init.cmdInitMilestoneOp(cwd, raw),
      'map-codebase': () => init.cmdInitMapCodebase(cwd, raw),
      progress: () => init.cmdInitProgress(cwd, raw),
      // Keep manager on CJS for now so runtime-specific command rendering
      // (e.g. $gsd-* for codex) stays consistent with runtime-slash helpers.
      manager: () => init.cmdInitManager(cwd, raw),
      'new-workspace': () => init.cmdInitNewWorkspace(cwd, raw),
      'list-workspaces': () => init.cmdInitListWorkspaces(cwd, raw),
      'remove-workspace': () => init.cmdInitRemoveWorkspace(cwd, args[2], raw),
    },
  });
}

module.exports = {
  routeInitCommand,
};

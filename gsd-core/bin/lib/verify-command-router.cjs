"use strict";
/**
 * Manifest-backed verify subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/verify-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkCommandRouter = require("./check-command-router.cjs");
const { routeCheckCommand } = checkCommandRouter;
// ─── Implementation ───────────────────────────────────────────────────────────
function routeVerifyCommand({ verify, args, cwd, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.VERIFY_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_subcommand, available) => `Unknown verify subcommand. Available: ${available.join(', ')}`,
        handlers: {
            'plan-structure': () => {
                const rest = args.slice(2);
                const replay = rest.includes('--replay');
                const positional = rest.filter((a) => a !== '--replay');
                verify.cmdVerifyPlanStructure(cwd, positional[0], raw, { replay });
            },
            'phase-completeness': () => verify.cmdVerifyPhaseCompleteness(cwd, args[2], raw),
            references: () => verify.cmdVerifyReferences(cwd, args[2], raw),
            commits: () => verify.cmdVerifyCommits(cwd, args.slice(2), raw),
            artifacts: () => verify.cmdVerifyArtifacts(cwd, args[2], raw),
            'key-links': () => verify.cmdVerifyKeyLinks(cwd, args[2], raw),
            // The three drift verbs are the `drift` capability's gates (#5219, ADR-5057 §4): each is one gate
            // module (src/gate-{schema,codebase,context}-drift.cts) that the check router formats; this
            // surface hands them to it. `--skip` is this surface's bypass of the schema gate (it reads no
            // GSD_SKIP_SCHEMA_CHECK), carried to the gate as the env flag the check router reads.
            'schema-drift': () => {
                const rest = args.slice(2);
                const skipFlag = rest.includes('--skip');
                const phaseArg = rest.find((arg) => !arg.startsWith('-')) ?? '';
                routeCheckCommand({
                    args: ['check', 'verify-schema-drift', phaseArg],
                    cwd,
                    raw,
                    env: skipFlag ? { GSD_SKIP_SCHEMA_CHECK: 'true' } : {},
                });
            },
            // verify codebase-drift and context-drift are the same gate modules `check verify-<name>`
            // runs (#5219, ADR-5057 §4): this surface hands them to the check router, which formats them.
            'codebase-drift': () => routeCheckCommand({ args: ['check', 'verify-codebase-drift'], cwd, raw }),
            'context-drift': () => routeCheckCommand({ args: ['check', 'verify-context-drift', args[2] ?? ''], cwd, raw }),
        },
    });
}
module.exports = {
    routeVerifyCommand,
};

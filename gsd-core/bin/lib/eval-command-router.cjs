"use strict";
/**
 * Manifest-backed eval subcommand router (#10).
 */
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
function routeEvalCommand({ evalMod, args, cwd, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.EVAL_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_s, available) => `Unknown eval subcommand. Available: ${available.join(', ')}`,
        handlers: {
            score: () => evalMod.cmdEvalScore(cwd, args, raw),
        },
    });
}
module.exports = { routeEvalCommand };

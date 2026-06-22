/**
 * Manifest-backed eval subcommand router (#10).
 */

import { EVAL_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

interface EvalModule {
  cmdEvalScore(cwd: string, args: string[], raw: boolean): void;
}

interface RouteEvalCommandOptions {
  evalMod: EvalModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

function routeEvalCommand({ evalMod, args, cwd, raw, error }: RouteEvalCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: EVAL_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown eval subcommand. Available: ${available.join(', ')}`,
    handlers: {
      score: () => evalMod.cmdEvalScore(cwd, args, raw),
    },
  });
}

export = { routeEvalCommand };

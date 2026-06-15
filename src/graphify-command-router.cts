'use strict';
/**
 * Graphify command router — CLI subcommand dispatcher for `gsd-tools graphify`.
 *
 * ADR-959 (phase 4d-impl-2) pilot: first real capability command cutover.
 * Extracted from the hardcoded `case 'graphify':` arm in gsd-tools.cjs.
 * Behaviour is preserved byte-for-behaviour from the prior inline case;
 * the dispatch path now flows: default → dispatchCapabilityCommand →
 * require(graphify-command-router.cjs) → routeGraphifyCommand.
 *
 * Router signature: { args, cwd, raw, error } — identical to the 12 existing
 * host routers. No new handler/arg convention; the capability registry
 * discovers this router by name.
 *
 * Arg indexing (preserved exactly from the original case):
 *   args[0] = 'graphify'  (family — matched by dispatchCapabilityCommand)
 *   args[1] = subcommand  (query | status | diff | build)
 *   args[2] = term (query) | 'snapshot' (build snapshot)
 *   args.indexOf('--budget') + 1 = budget value
 *
 * Test seam: pass `_graphify` in the options object to inject a recording mock
 * instead of the real graphify module. The `_`-prefix follows the repo's
 * established seam convention (see other routers). Production callers omit it.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import graphify = require('./graphify.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');

const { output, ERROR_REASON } = io;

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphifyModule {
  graphifyQuery(cwd: string, term: string, opts: { budget: number | null }): unknown;
  graphifyStatus(cwd: string): unknown;
  graphifyDiff(cwd: string): unknown;
  graphifyBuild(cwd: string): unknown;
  writeSnapshot(cwd: string): unknown;
}

interface RouteGraphifyCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock graphify module. Defaults to the real module. */
  _graphify?: GraphifyModule;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeGraphifyCommand({ args, cwd, raw, error, _graphify }: RouteGraphifyCommandOptions): void {
  const subcommand = args[1];
  const g: GraphifyModule = _graphify ?? graphify;

  if (subcommand === 'query') {
    const term = args[2];
    if (!term) {
      error('Usage: gsd-tools graphify query <term>', ERROR_REASON.USAGE);
      return;
    }
    const budgetIdx = args.indexOf('--budget');
    let budget: number | null = null;
    if (budgetIdx !== -1) {
      const rawBudget = args[budgetIdx + 1];
      if (rawBudget === undefined || Number.isNaN(parseInt(rawBudget, 10))) {
        error('Usage: gsd-tools graphify query <term> [--budget <N>]', ERROR_REASON.USAGE);
        return;
      }
      budget = parseInt(rawBudget, 10);
    }
    output(g.graphifyQuery(cwd, term, { budget }), raw);
  } else if (subcommand === 'status') {
    output(g.graphifyStatus(cwd), raw);
  } else if (subcommand === 'diff') {
    output(g.graphifyDiff(cwd), raw);
  } else if (subcommand === 'build') {
    if (args[2] === 'snapshot') {
      output(g.writeSnapshot(cwd), raw);
    } else {
      output(g.graphifyBuild(cwd), raw);
    }
  } else {
    error(
      'Unknown graphify subcommand. Available: build, query, status, diff',
      ERROR_REASON.SDK_UNKNOWN_COMMAND,
    );
  }
}

export = {
  routeGraphifyCommand,
};

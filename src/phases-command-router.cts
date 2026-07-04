/**
 * Manifest-backed phases subcommand router.
 * Keeps gsd-tools.cjs thin while preserving current CJS semantics.
 *
 * Unsupported in this router (treated as unknown):
 * - archive: `phases archive` is excluded (#2684) — it is an internal
 *   subcommand that milestone.complete forwards to, not a public surface.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/phases-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { PHASES_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhaseListOptions {
  type: string | null;
  phase: string | null;
  includeArchived: boolean;
}

interface PhaseModule {
  cmdPhasesList(cwd: string, options: PhaseListOptions, raw: boolean): void;
}

interface MilestoneModule {
  cmdPhasesClear(cwd: string, raw: boolean, args: string[]): void;
}

interface RoutePhasesCommandOptions {
  phase: PhaseModule;
  milestone: MilestoneModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routePhasesCommand({ phase, milestone, args, cwd, raw, error }: RoutePhasesCommandOptions): void {
  routeCjsCommandFamily({
    args,
    // #2684: `phases archive` is deliberately excluded — it is an internal
    // subcommand that milestone.complete forwards to, not a public surface.
    subcommands: PHASES_SUBCOMMANDS.filter((s) => s !== 'archive'),
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown phases subcommand. Available: ${available.join(', ')}`,
    handlers: {
      list: () => {
        const typeIndex = args.indexOf('--type');
        const phaseIndex = args.indexOf('--phase');
        const options: PhaseListOptions = {
          type: typeIndex !== -1 ? args[typeIndex + 1] : null,
          phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
          includeArchived: args.includes('--include-archived'),
        };
        phase.cmdPhasesList(cwd, options, raw);
      },
      clear: () => milestone.cmdPhasesClear(cwd, raw, args.slice(2)),
    },
  });
}

export = {
  routePhasesCommand,
};

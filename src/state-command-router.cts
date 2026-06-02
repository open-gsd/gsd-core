/**
 * Manifest-backed state subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 5.1: handlers that have SDK equivalents are dispatched via
 * executeForCjs (the sync bridge). CJS fallback is retained for:
 * - complete-phase: no SDK counterpart.
 * - Any command when GSD_WORKSTREAM is active (GSDTransport forces subprocess
 *   for workstream requests; subprocess is disabled in the sync bridge worker).
 * - Any command when the SDK is not available (build not present).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { STATE_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeHubCommandFamily, cjsFallbackHandler } = cjsCommandRouterAdapter;
import { parseNamedArgs } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

// Handler type matching cjs-command-router-adapter's internal Handler type.
type Handler = () => unknown;

// Helper: cast cjsFallbackHandler result (always the last arg, a Handler) to Handler.
function fallback(...projectionArgs: unknown[]): Handler {
  return cjsFallbackHandler(...projectionArgs) as Handler;
}

// Helper: extract string-only named arg value (value flags never return boolean).
function strArg(opts: Record<string, string | boolean | null>, key: string): string | null | undefined {
  const v = opts[key];
  if (typeof v === 'boolean') return undefined;
  return v;
}

interface StateModule {
  cmdStateLoad(cwd: string, raw: boolean): void;
  cmdStateJson(cwd: string, raw: boolean): void;
  cmdStateGet(cwd: string, field: string | undefined, raw: boolean): void;
  cmdStateUpdate(cwd: string, field: string | undefined, value: string | undefined): void;
  cmdStatePatch(cwd: string, patches: Record<string, string>, raw: boolean): void;
  cmdStateAdvancePlan(cwd: string, raw: boolean): void;
  cmdStateRecordMetric(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateUpdateProgress(cwd: string, raw: boolean): void;
  cmdStateAddDecision(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateAddBlocker(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateResolveBlocker(cwd: string, text: string | null | undefined, raw: boolean): void;
  cmdStateRecordSession(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateBeginPhase(cwd: string, phase: string | null | undefined, name: string | null | undefined, plans: number | null, raw: boolean): void;
  cmdSignalWaiting(cwd: string, type: string | null | undefined, question: string | null | undefined, options: string | null | undefined, phase: string | null | undefined, raw: boolean): void;
  cmdSignalResume(cwd: string, raw: boolean): void;
  cmdStatePlannedPhase(cwd: string, phase: string | null | undefined, plans: number | null, raw: boolean): void;
  cmdStateValidate(cwd: string, raw: boolean): void;
  cmdStateSync(cwd: string, opts: { verify: string | boolean | null | undefined }, raw: boolean): void;
  cmdStatePrune(cwd: string, opts: { keepRecent: string; dryRun: boolean }, raw: boolean): void;
  cmdStateCompletePhase(cwd: string, raw: boolean, phase: string | null | undefined): void;
  cmdStateMilestoneSwitch(cwd: string, milestone: string | null | undefined, name: string | null | undefined, raw: boolean): void;
}

interface RouteStateCommandOptions {
  state: StateModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeStateCommand({ state, args, cwd, raw, error }: RouteStateCommandOptions): void {
  const parsePlans = (plans: string | null | undefined): number | null => {
    const parsedPlans = plans == null ? null : Number.parseInt(plans, 10);
    if (plans != null && Number.isNaN(parsedPlans)) {
      error('Invalid --plans value. Expected an integer.');
      return null;
    }
    return parsedPlans;
  };

  routeHubCommandFamily({
    family: 'state',
    args,
    subcommands: ['load', 'complete-phase', ...STATE_SUBCOMMANDS.filter((s) => s !== 'load')],
    defaultSubcommand: 'load',
    unsupported: {
      'add-roadmap-evolution': 'state add-roadmap-evolution is SDK-only. Use: gsd-tools query state.add-roadmap-evolution ...',
    },
    error,
    cwd,
    raw,
    unknownMessage: (subcommand: string, available: string[]) => `Unknown state subcommand: "${subcommand}". Available: ${available.join(', ')}`,
    handlers: {
      load: fallback(
        'state.load',
        [],
        args.slice(1),
        null,
        () => state.cmdStateLoad(cwd, raw),
      ),
      json: fallback(
        'state.json',
        [],
        args.slice(1),
        null,
        () => state.cmdStateJson(cwd, raw),
      ),
      get: fallback(
        'state.get',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateGet(cwd, args[2], raw),
      ),
      update: fallback(
        'state.update',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateUpdate(cwd, args[2], args[3]),
      ),
      patch: fallback(
        'state.patch',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const patches: Record<string, string> = {};
          if (args.length === 3 && typeof args[2] === 'string' && args[2].trim().startsWith('{')) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(args[2]);
            } catch (err) {
              error(`state patch: invalid JSON object: ${(err as Error).message}`);
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              error('state patch: JSON input must be an object of field/value pairs.');
              return;
            }
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (key && value !== undefined) {
                // eslint-disable-next-line @typescript-eslint/no-base-to-string
                patches[key] = String(value);
              }
            }
          } else {
            for (let i = 2; i < args.length; i += 2) {
              const key = args[i].replace(/^--/, '');
              const value = args[i + 1];
              if (key && value !== undefined) {
                patches[key] = value;
              }
            }
          }
          state.cmdStatePatch(cwd, patches, raw);
        },
      ),
      'advance-plan': fallback(
        'state.advance-plan',
        [],
        args.slice(1),
        null,
        () => state.cmdStateAdvancePlan(cwd, raw),
      ),
      'record-metric': fallback(
        'state.record-metric',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['phase', 'plan', 'duration', 'tasks', 'files']);
          state.cmdStateRecordMetric(cwd, {
            phase: strArg(a, 'phase'),
            plan: strArg(a, 'plan'),
            duration: strArg(a, 'duration'),
            tasks: strArg(a, 'tasks'),
            files: strArg(a, 'files'),
          }, raw);
        },
      ),
      'update-progress': fallback(
        'state.update-progress',
        [],
        args.slice(1),
        null,
        () => state.cmdStateUpdateProgress(cwd, raw),
      ),
      'add-decision': fallback(
        'state.add-decision',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['phase', 'summary', 'summary-file', 'rationale', 'rationale-file']);
          state.cmdStateAddDecision(cwd, {
            phase: strArg(a, 'phase'),
            summary: strArg(a, 'summary'),
            summary_file: strArg(a, 'summary-file'),
            rationale: strArg(a, 'rationale') || '',
            rationale_file: strArg(a, 'rationale-file'),
          }, raw);
        },
      ),
      'add-blocker': fallback(
        'state.add-blocker',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['text', 'text-file']);
          state.cmdStateAddBlocker(cwd, { text: strArg(a, 'text'), text_file: strArg(a, 'text-file') }, raw);
        },
      ),
      'resolve-blocker': fallback(
        'state.resolve-blocker',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateResolveBlocker(cwd, strArg(parseNamedArgs(args, ['text']), 'text'), raw),
      ),
      'record-session': fallback(
        'state.record-session',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['stopped-at', 'resume-file']);
          // Pass resume_file as-is (undefined when --resume-file was not provided) so
          // cmdStateRecordSession can distinguish "caller explicitly passed a value" from
          // "option was not supplied" and apply the template-default-only replacement guard.
          state.cmdStateRecordSession(cwd, { stopped_at: strArg(a, 'stopped-at'), resume_file: strArg(a, 'resume-file') }, raw);
        },
      ),
      'begin-phase': fallback(
        'state.begin-phase',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['phase', 'name', 'plans']);
          state.cmdStateBeginPhase(cwd, strArg(a, 'phase'), strArg(a, 'name'), parsePlans(strArg(a, 'plans')), raw);
        },
      ),
      'signal-waiting': fallback(
        'state.signal-waiting',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['type', 'question', 'options', 'phase']);
          state.cmdSignalWaiting(cwd, strArg(a, 'type'), strArg(a, 'question'), strArg(a, 'options'), strArg(a, 'phase'), raw);
        },
      ),
      'signal-resume': fallback(
        'state.signal-resume',
        [],
        args.slice(1),
        null,
        () => state.cmdSignalResume(cwd, raw),
      ),
      'planned-phase': fallback(
        'state.planned-phase',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['phase', 'name', 'plans']);
          state.cmdStatePlannedPhase(cwd, strArg(a, 'phase'), parsePlans(strArg(a, 'plans')), raw);
        },
      ),
      validate: fallback(
        'state.validate',
        [],
        args.slice(1),
        null,
        () => state.cmdStateValidate(cwd, raw),
      ),
      sync: fallback(
        'state.sync',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, [], ['verify']);
          state.cmdStateSync(cwd, { verify: a['verify'] }, raw);
        },
      ),
      prune: fallback(
        'state.prune',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['keep-recent'], ['dry-run']);
          state.cmdStatePrune(cwd, { keepRecent: strArg(a, 'keep-recent') || '3', dryRun: a['dry-run'] === true }, raw);
        },
      ),
      // complete-phase: CJS-only — no SDK counterpart.
      'complete-phase': () => {
        const a = parseNamedArgs(args, ['phase']);
        state.cmdStateCompletePhase(cwd, raw, strArg(a, 'phase') || args[2]);
      },
      'milestone-switch': fallback(
        'state.milestone-switch',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const a = parseNamedArgs(args, ['milestone', 'name']);
          state.cmdStateMilestoneSwitch(cwd, strArg(a, 'milestone'), strArg(a, 'name'), raw);
        },
      ),
    },
  });
}

export = {
  routeStateCommand,
};

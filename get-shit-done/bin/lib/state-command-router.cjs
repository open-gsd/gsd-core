'use strict';

const { STATE_SUBCOMMANDS } = require('./command-aliases.cjs');
const { routeHubCommandFamily, cjsFallbackHandler } = require('./cjs-command-router-adapter.cjs');
const { parseNamedArgs } = require('./command-arg-projection.cjs');

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
 */
function routeStateCommand({ state, args, cwd, raw, error }) {
  const parsePlans = (plans) => {
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
      'add-roadmap-evolution': 'state add-roadmap-evolution is not implemented in the current gsd-tools runtime. Use a supported roadmap/state command or update the roadmap through the documented gsd-tools flow.',
    },
    error,
    cwd,
    raw,
    unknownMessage: (subcommand, available) => `Unknown state subcommand: "${subcommand}". Available: ${available.join(', ')}`,
    handlers: {
      load: cjsFallbackHandler(
        'state.load',
        [],
        args.slice(1),
        null,
        () => state.cmdStateLoad(cwd, raw),
      ),
      json: cjsFallbackHandler(
        'state.json',
        [],
        args.slice(1),
        null,
        () => state.cmdStateJson(cwd, raw),
      ),
      get: cjsFallbackHandler(
        'state.get',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateGet(cwd, args[2], raw),
      ),
      update: cjsFallbackHandler(
        'state.update',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateUpdate(cwd, args[2], args[3]),
      ),
      patch: cjsFallbackHandler(
        'state.patch',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const patches = {};
          if (args.length === 3 && typeof args[2] === 'string' && args[2].trim().startsWith('{')) {
            let parsed;
            try {
              parsed = JSON.parse(args[2]);
            } catch (err) {
              error(`state patch: invalid JSON object: ${err.message}`);
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              error('state patch: JSON input must be an object of field/value pairs.');
            }
            for (const [key, value] of Object.entries(parsed)) {
              if (key && value !== undefined) {
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
      'advance-plan': cjsFallbackHandler(
        'state.advance-plan',
        [],
        args.slice(1),
        null,
        () => state.cmdStateAdvancePlan(cwd, raw),
      ),
      'record-metric': cjsFallbackHandler(
        'state.record-metric',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { phase: p, plan, duration, tasks, files } = parseNamedArgs(args, ['phase', 'plan', 'duration', 'tasks', 'files']);
          state.cmdStateRecordMetric(cwd, { phase: p, plan, duration, tasks, files }, raw);
        },
      ),
      'update-progress': cjsFallbackHandler(
        'state.update-progress',
        [],
        args.slice(1),
        null,
        () => state.cmdStateUpdateProgress(cwd, raw),
      ),
      'add-decision': cjsFallbackHandler(
        'state.add-decision',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { phase: p, summary, 'summary-file': summary_file, rationale, 'rationale-file': rationale_file } = parseNamedArgs(args, ['phase', 'summary', 'summary-file', 'rationale', 'rationale-file']);
          state.cmdStateAddDecision(cwd, { phase: p, summary, summary_file, rationale: rationale || '', rationale_file }, raw);
        },
      ),
      'add-blocker': cjsFallbackHandler(
        'state.add-blocker',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { text, 'text-file': text_file } = parseNamedArgs(args, ['text', 'text-file']);
          state.cmdStateAddBlocker(cwd, { text, text_file }, raw);
        },
      ),
      'resolve-blocker': cjsFallbackHandler(
        'state.resolve-blocker',
        args.slice(2),
        args.slice(1),
        null,
        () => state.cmdStateResolveBlocker(cwd, parseNamedArgs(args, ['text']).text, raw),
      ),
      'record-session': cjsFallbackHandler(
        'state.record-session',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { 'stopped-at': stopped_at, 'resume-file': resume_file } = parseNamedArgs(args, ['stopped-at', 'resume-file']);
          // Pass resume_file as-is (undefined when --resume-file was not provided) so
          // cmdStateRecordSession can distinguish "caller explicitly passed a value" from
          // "option was not supplied" and apply the template-default-only replacement guard.
          state.cmdStateRecordSession(cwd, { stopped_at, resume_file }, raw);
        },
      ),
      'begin-phase': cjsFallbackHandler(
        'state.begin-phase',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { phase: p, name, plans } = parseNamedArgs(args, ['phase', 'name', 'plans']);
          state.cmdStateBeginPhase(cwd, p, name, parsePlans(plans), raw);
        },
      ),
      'signal-waiting': cjsFallbackHandler(
        'state.signal-waiting',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { type, question, options, phase: p } = parseNamedArgs(args, ['type', 'question', 'options', 'phase']);
          state.cmdSignalWaiting(cwd, type, question, options, p, raw);
        },
      ),
      'signal-resume': cjsFallbackHandler(
        'state.signal-resume',
        [],
        args.slice(1),
        null,
        () => state.cmdSignalResume(cwd, raw),
      ),
      'planned-phase': cjsFallbackHandler(
        'state.planned-phase',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { phase: p, plans } = parseNamedArgs(args, ['phase', 'name', 'plans']);
          state.cmdStatePlannedPhase(cwd, p, parsePlans(plans), raw);
        },
      ),
      validate: cjsFallbackHandler(
        'state.validate',
        [],
        args.slice(1),
        null,
        () => state.cmdStateValidate(cwd, raw),
      ),
      sync: cjsFallbackHandler(
        'state.sync',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { verify } = parseNamedArgs(args, [], ['verify']);
          state.cmdStateSync(cwd, { verify }, raw);
        },
      ),
      prune: cjsFallbackHandler(
        'state.prune',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { 'keep-recent': keepRecent, 'dry-run': dryRun } = parseNamedArgs(args, ['keep-recent'], ['dry-run']);
          state.cmdStatePrune(cwd, { keepRecent: keepRecent || '3', dryRun: !!dryRun }, raw);
        },
      ),
      // complete-phase: CJS-only — no SDK counterpart.
      'complete-phase': () => {
        const { phase: p } = parseNamedArgs(args, ['phase']);
        state.cmdStateCompletePhase(cwd, raw, p || args[2]);
      },
      'milestone-switch': cjsFallbackHandler(
        'state.milestone-switch',
        args.slice(2),
        args.slice(1),
        null,
        () => {
          const { milestone, name } = parseNamedArgs(args, ['milestone', 'name']);
          state.cmdStateMilestoneSwitch(cwd, milestone, name, raw);
        },
      ),
    },
  });
}

module.exports = {
  routeStateCommand,
};

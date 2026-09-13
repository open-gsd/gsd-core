/** Strict, coordinate-bound OpenCode V2 quick-batch command router. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import quickBatchV2Module = require('./quick-batch-v2.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import quickBatchModule = require('./quick-batch.cjs');
import { safeJsonParse } from './security.cjs';

type JsonObject = Record<string, unknown>;
type FlagValues = Record<string, string>;
type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };
type FlagParseResult = { ok: true; values: FlagValues } | { ok: false; reason: string };

interface Coordinates {
  parent: string;
  batch: string;
  round: number;
  item: string;
  revision: number;
}

interface CoordinateValues extends Coordinates {
  values: FlagValues;
}

interface QuickBatchV2Module {
  allocateRound(cwd: string, parent: string, batch: string, items: unknown[], options: JsonObject): unknown;
  reconcileActiveRound(cwd: string, parent: string, batch: string): unknown;
  transition(cwd: string, parent: string, batch: string, round: number, item: string, phase: string, event: unknown, revision: number): unknown;
  attestPlugin(cwd: string, parent: string, batch: string, round: number, item: string, revision: number): Promise<unknown>;
  recordVerification(cwd: string, parent: string, batch: string, round: number, item: string, revision: number): unknown;
  mergeAuthorized(cwd: string, parent: string, batch: string, round: number, item: string, revision: number, request: Record<string, string>): unknown;
  teardownAuthorized(cwd: string, parent: string, batch: string, round: number, item: string, revision: number, request: Record<string, string>): unknown;
  completeAuthorized(cwd: string, parent: string, batch: string, round: number, item: string, revision: number, request: Record<string, string>): unknown;
  closeRound(cwd: string, parent: string, batch: string, round: number, options: JsonObject, revision: number): unknown;
  cleanupClosedRound(cwd: string, parent: string, batch: string, round: number): unknown;
}

interface QuickBatchModule {
  applyV2Outcome(cwd: string, batch: string, item: string, outcome: string, reason: string): unknown;
}

interface RouteQuickBatchV2CommandOptions {
  args: string[];
  cwd: string;
  raw?: boolean;
  emit(this: void, result: unknown): void | Promise<void>;
  error(this: void, message: string, reason?: string): void;
  v2?: QuickBatchV2Module;
}

const quickBatchV2 = quickBatchV2Module as unknown as QuickBatchV2Module;
const quickBatch = quickBatchModule as unknown as QuickBatchModule;
const V2_ATTEST_FLAGS = ['--parent-session', '--batch', '--round', '--item', '--expected-revision'] as const;
const COORDINATE_USAGE = '--parent-session <ses> --batch <id> --round <n> --item <id> --expected-revision <n>';
const V2_COMMANDS: ReadonlySet<string> = new Set([
  'v2-allocate',
  'v2-reconcile',
  'v2-transition',
  'v2-attest',
  'v2-verify',
  'v2-merge',
  'v2-teardown',
  'v2-complete',
  'v2-close',
  'v2-cleanup',
  'v2-outcome',
]);

/** True only for supported V2 verbs; unknown `v2-*` still belongs to the Hub. */
function isQuickBatchV2Command(args: string[]): boolean {
  return V2_COMMANDS.has(args[1] ?? '');
}

function parseJsonArg<T>(raw: string | undefined, label: string): ParseResult<T> {
  if (raw === undefined) return { ok: false, reason: `${label} requires a JSON value` };
  const parsed = safeJsonParse(raw, { maxLength: 1048576, label });
  if (!parsed.ok) return { ok: false, reason: `${label} is not valid JSON: ${parsed.error ?? 'unknown parse error'}` };
  return { ok: true, value: parsed.value as T };
}

function parseExactFlagArgs(args: string[], flags: readonly string[]): FlagParseResult {
  const tokens = args.slice(2);
  if (tokens.length !== flags.length * 2) return { ok: false, reason: 'requires every allowed flag exactly once' };

  const values: FlagValues = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flags.includes(flag) || flag.includes('=') || Object.hasOwn(values, flag)) {
      return { ok: false, reason: `rejects unknown, positional, alias, or duplicate argument: ${flag}` };
    }
    if (value === undefined || value.startsWith('--')) return { ok: false, reason: `flag ${flag} requires one value` };
    values[flag] = value;
  }
  return { ok: true, values };
}

function parseStrictFlagArgs(args: string[], required: readonly string[], optional: readonly string[] = []): FlagParseResult {
  const tokens = args.slice(2);
  if (tokens.length % 2 !== 0) return { ok: false, reason: 'requires flag/value pairs only' };

  const allowed = [...required, ...optional];
  const values: FlagValues = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.includes(flag) || flag.includes('=') || Object.hasOwn(values, flag)) {
      return { ok: false, reason: `rejects unknown, positional, alias, or duplicate argument: ${flag}` };
    }
    if (value === undefined || value.startsWith('--')) return { ok: false, reason: `flag ${flag} requires one value` };
    values[flag] = value;
  }
  return required.some((flag) => !Object.hasOwn(values, flag))
    ? { ok: false, reason: 'is missing a required flag' }
    : { ok: true, values };
}

function parseExactCoordinateArgs(args: string[], extras: readonly string[]): ParseResult<CoordinateValues> {
  const parsed = parseExactFlagArgs(args, [...V2_ATTEST_FLAGS, ...extras]);
  if (!parsed.ok) return parsed;

  const { values } = parsed;
  const round = Number(values['--round']);
  const revision = Number(values['--expected-revision']);
  const parent = values['--parent-session'];
  const batch = values['--batch'];
  const item = values['--item'];
  if (!parent || !batch || !item || !Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(revision) || revision < 0) {
    return { ok: false, reason: 'coordinates or revision are invalid' };
  }
  return { ok: true, value: { parent, batch, round, item, revision, values } };
}

function parseV2AttestArgs(args: string[]): ParseResult<Coordinates> {
  const parsed = parseExactCoordinateArgs(args, []);
  if (parsed.ok) {
    const { parent, batch, round, item, revision } = parsed.value;
    return { ok: true, value: { parent, batch, round, item, revision } };
  }
  return args.slice(2).length !== V2_ATTEST_FLAGS.length * 2
    ? { ok: false, reason: 'v2-attest requires each allowed flag exactly once' }
    : parsed;
}

function usageError(error: RouteQuickBatchV2CommandOptions['error'], verb: string, usage: string, parsed: { reason: string }): void {
  error(`Usage: quick-batch ${verb} ${usage}; ${parsed.reason}`, 'usage');
}

function exactRequest(values: FlagValues, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, values[`--${name.replaceAll('_', '-')}`]]));
}

async function tryRouteQuickBatchV2Command(options: RouteQuickBatchV2CommandOptions): Promise<boolean> {
  const { args, cwd, emit, error } = options;
  const v2 = options.v2 ?? quickBatchV2;
  const verb = args[1];
  if (!String(verb).startsWith('v2-')) return false;

  try {
    switch (verb) {
      case 'v2-attest': {
        const parsed = parseV2AttestArgs(args);
        if (!parsed.ok) { usageError(error, verb, COORDINATE_USAGE, parsed); return true; }
        const value = parsed.value;
        await emit(await v2.attestPlugin(cwd, value.parent, value.batch, value.round, value.item, value.revision));
        return true;
      }
      case 'v2-allocate': {
        const parsed = parseStrictFlagArgs(args, ['--parent-session', '--batch', '--items', '--validation-required'], ['--orchestrator-root']);
        const usage = '--parent-session <ses> --batch <id> --items <json> --validation-required <true|false> [--orchestrator-root <path>]';
        if (!parsed.ok) { usageError(error, verb, usage, parsed); return true; }
        const items = parseJsonArg<unknown[]>(parsed.values['--items'], '--items');
        const parent = parsed.values['--parent-session'];
        const batch = parsed.values['--batch'];
        const validationRequired = parsed.values['--validation-required'];
        const root = parsed.values['--orchestrator-root'];
        if (!parent || !batch || !items.ok || root === '' || !['true', 'false'].includes(validationRequired)) {
          error(`Usage: quick-batch ${verb} ${usage}`, 'usage');
          return true;
        }
        await emit(v2.allocateRound(cwd, parent, batch, items.value, { ...(root === undefined ? {} : { orchestrator_root: root }), validation_required: validationRequired === 'true' }));
        return true;
      }
      case 'v2-reconcile': {
        const parsed = parseStrictFlagArgs(args, ['--parent-session', '--batch']);
        if (!parsed.ok || !parsed.values['--parent-session'] || !parsed.values['--batch']) { usageError(error, verb, '--parent-session <ses> --batch <id>', parsed.ok ? { reason: 'coordinates are invalid' } : parsed); return true; }
        await emit(v2.reconcileActiveRound(cwd, parsed.values['--parent-session'], parsed.values['--batch']));
        return true;
      }
      case 'v2-transition': {
        const parsed = parseExactFlagArgs(args, [...V2_ATTEST_FLAGS, '--phase', '--event']);
        if (!parsed.ok) { usageError(error, verb, `${COORDINATE_USAGE} --phase <phase> --event <json>`, parsed); return true; }
        const event = parseJsonArg<unknown>(parsed.values['--event'], '--event');
        const round = Number(parsed.values['--round']);
        const revision = Number(parsed.values['--expected-revision']);
        if (!parsed.values['--parent-session'] || !parsed.values['--batch'] || !parsed.values['--item'] || !parsed.values['--phase'] || !Number.isSafeInteger(round) || !Number.isSafeInteger(revision) || !event.ok) { error(`Usage: quick-batch ${verb} ${COORDINATE_USAGE} --phase <phase> --event <json>`, 'usage'); return true; }
        await emit(v2.transition(cwd, parsed.values['--parent-session'], parsed.values['--batch'], round, parsed.values['--item'], parsed.values['--phase'], event.value, revision));
        return true;
      }
      case 'v2-verify': case 'v2-merge': case 'v2-teardown': case 'v2-complete': {
        const extras = verb === 'v2-verify' ? [] : verb === 'v2-merge' ? ['--manifest-path', '--manifest-agent-id', '--worktree-path', '--branch', '--expected-child-tip', '--expected-target-tip', '--status-digest'] : verb === 'v2-teardown' ? ['--manifest-path', '--manifest-agent-id', '--worktree-path', '--branch', '--merged-child-tip'] : ['--description', '--date', '--commit', '--directory'];
        const parsed = parseExactCoordinateArgs(args, extras);
        if (!parsed.ok) { usageError(error, verb, COORDINATE_USAGE, parsed); return true; }
        const value = parsed.value;
        if (verb === 'v2-verify') await emit(v2.recordVerification(cwd, value.parent, value.batch, value.round, value.item, value.revision));
        else if (verb === 'v2-merge') await emit(v2.mergeAuthorized(cwd, value.parent, value.batch, value.round, value.item, value.revision, exactRequest(value.values, ['manifest_path', 'manifest_agent_id', 'worktree_path', 'branch', 'expected_child_tip', 'expected_target_tip', 'status_digest'])));
        else if (verb === 'v2-teardown') await emit(v2.teardownAuthorized(cwd, value.parent, value.batch, value.round, value.item, value.revision, exactRequest(value.values, ['manifest_path', 'manifest_agent_id', 'worktree_path', 'branch', 'merged_child_tip'])));
        else await emit(v2.completeAuthorized(cwd, value.parent, value.batch, value.round, value.item, value.revision, exactRequest(value.values, ['description', 'date', 'commit', 'directory'])));
        return true;
      }
      case 'v2-close': case 'v2-cleanup': {
        const fields = verb === 'v2-close' ? ['--parent-session', '--batch', '--round', '--expected-revision'] : ['--parent-session', '--batch', '--round'];
        const parsed = parseExactFlagArgs(args, fields);
        if (!parsed.ok) { usageError(error, verb, fields.join(' '), parsed); return true; }
        const round = Number(parsed.values['--round']);
        const revision = Number(parsed.values['--expected-revision']);
        if (!parsed.values['--parent-session'] || !parsed.values['--batch'] || !Number.isSafeInteger(round) || (verb === 'v2-close' && !Number.isSafeInteger(revision))) { error('coordinates are invalid', 'usage'); return true; }
        if (verb === 'v2-close') await emit(v2.closeRound(cwd, parsed.values['--parent-session'], parsed.values['--batch'], round, {}, revision));
        else await emit(v2.cleanupClosedRound(cwd, parsed.values['--parent-session'], parsed.values['--batch'], round));
        return true;
      }
      case 'v2-outcome': {
        const parsed = parseExactFlagArgs(args, ['--batch', '--quick-id', '--outcome', '--reason']);
        const usage = '--batch <id> --quick-id <id> --outcome <passed|gaps_found|merge_failed|human_needed> --reason <text>';
        if (!parsed.ok) { usageError(error, verb, usage, parsed); return true; }
        const batch = parsed.values['--batch']; const item = parsed.values['--quick-id']; const outcome = parsed.values['--outcome'];
        if (!batch || !item || !outcome) { error('coordinates are invalid', 'usage'); return true; }
        await emit(quickBatch.applyV2Outcome(cwd, batch, item, outcome, parsed.values['--reason']));
        return true;
      }
      default: return false;
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : `${verb} failed closed`, 'usage');
    return true;
  }
}

export = {
  isQuickBatchV2Command,
  tryRouteQuickBatchV2Command,
  parseV2AttestArgs,
  parseExactCoordinateArgs,
  parseExactFlagArgs,
};

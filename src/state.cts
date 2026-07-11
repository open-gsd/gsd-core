/**
 * State — STATE.md operations and progression engine
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, extractPhaseToken, parsePhaseFromProse, PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo, getMilestonePhaseFilter, extractCurrentMilestone } = roadmapParserMod;
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningPaths } = planningWorkspace;
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, reconstructFrontmatter } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateTransitionMod = require('./state-transition.cjs');
const { transitionCore, applyStatePreservation, sliceCurrentPositionSection } = stateTransitionMod;
type StateTransitionIntent = stateTransitionMod.StateTransitionIntent;
type StateTransitionDeps = stateTransitionMod.StateTransitionDeps;
type PhaseInventoryRecord = stateTransitionMod.PhaseInventoryRecord;
import {
  computeProgressPercent,
  normalizeProgressNumbers,
  normalizeStateStatus,
  shouldPreserveExistingProgress,
  stateExtractField,
  stateReplaceField,
  KNOWN_TEMPLATE_DEFAULTS,
  stateReplaceFieldIfTemplate,
} from './state-document.cjs';
import { tokenizeHeadings } from './markdown-sectionizer.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

// Local frontmatter type alias matching frontmatter.cts so we can call reconstructFrontmatter
type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

interface StateLockClock {
  now(): number;
  sleep(ms: number): void;
}

interface ReadModifyWriteOptions {
  resync?: boolean;
}

interface StateRecordMetricOptions {
  phase: string;
  plan: string;
  duration: string;
  tasks?: string | number;
  files?: string | number;
}

interface StateAddDecisionOptions {
  phase?: string;
  summary?: string;
  summary_file?: string;
  rationale?: string;
  rationale_file?: string;
}

interface StateAddBlockerOptions {
  text?: string;
  text_file?: string;
}

interface StateAddRoadmapEvolutionOptions {
  phase?: string;
  action?: string;
  after?: string;
  note?: string;
  note_file?: string;
  urgent?: boolean;
}

interface StateRecordSessionOptions {
  stopped_at?: string;
  resume_file?: string | null;
}

interface StateSnapshotSession {
  last_date: string | null;
  stopped_at: string | null;
  resume_file: string | null;
}

interface StatePruneOptions {
  keepRecent?: number | string;
  dryRun?: boolean;
  silent?: boolean;
}

interface StateRebuildOptions {
  dryRun?: boolean;
  verbose?: boolean;
  silent?: boolean;
}

interface StateSyncOptions {
  verify?: boolean;
}

interface PrunedSection {
  section: string;
  count: number;
  lines: string[];
}

const STATE_PROGRESS_RESYNC_FIELDS = new Set([
  'Progress',
  'Total Plans in Phase',
  'Total Phases',
]);

function shouldResyncStateProgress(fields: Iterable<string>): boolean {
  for (const field of fields) {
    if (STATE_PROGRESS_RESYNC_FIELDS.has(field)) {
      return true;
    }
  }
  return false;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

// Cache disk scan results from buildStateFrontmatter per cwd per process (#1967).
// Avoids re-reading N+1 directories on every state write when the phase structure
// hasn't changed within the same gsd-tools invocation.
const _diskScanCache = new Map<string, {
  totalPhases: number;
  completedPhases: number;
  totalPlans: number;
  completedPlans: number;
  milestoneBounded: boolean;
}>();

// Track all lock files held by this process so they can be removed on exit.
// process.on('exit') fires even on process.exit(1), unlike try/finally which is
// skipped when error() calls process.exit(1) inside a locked region (#1916).
const _heldStateLocks = new Set<string>();
process.on('exit', () => {
  for (const lockPath of _heldStateLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------------
// Lock liveness probe (test seam) — audit M1
//
// mtime is a LEAKY proxy for "the holder is still alive": a live-but-slow writer
// whose critical section runs past staleThresholdMs ages out and a waiter would
// steal its lock → two writers in STATE.md's read-modify-write window → lost
// update / corruption (the recurring #500/#905/#1230 family). The real signal —
// process.kill(pid, 0) — is already used by capability-lock.cts. We backport it
// here. The indirection lets unit tests inject a deterministic isPidAlive without
// real pids (mirrors capability-lock's _lockProbes / _setLockProbes seam).
// ---------------------------------------------------------------------------

/** Is `pid` a live process? process.kill(pid, 0) succeeds for a live (signalable) process. */
function _realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    // EPERM = process exists but we cannot signal it (still ALIVE). ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const _stateLockProbes: { isPidAlive: (pid: number) => boolean } = { isPidAlive: _realIsPidAlive };

// ---------------------------------------------------------------------------
// State-lock test hooks (test seam) — audit M8 / M9
//
// Both M8 (scan-before-lock TOCTOU in writeStateMd) and M9 (orphan empty lock +
// fd leak on a recoverable writeSync/closeSync error in acquireStateLock) are
// concurrency / resource-safety issues a single-threaded test cannot otherwise
// observe. These purpose-built hooks make the failure windows deterministic
// (mirrors the M1 _setLockProbes seam above):
//
//   afterAcquire(lockPath)  — fired inside writeStateMd immediately AFTER the lock
//     is acquired. A test can mutate the disk here (simulate a concurrent writer
//     landing in the scan→lock window) to prove the disk scan runs INSIDE the lock.
//   simulateWriteError      — a ONE-SHOT errno string. When set, the next writeSync
//     inside acquireStateLock throws it (and the hook self-clears), forcing the
//     openSync-succeeds-then-write-fails cleanup path without an OS-level fault.
//   onLoopIteration(ctx)    — fired at the TOP of each acquireStateLock retry
//     iteration so a test can snapshot whether an orphan lock is stranded.
//   beforeSteal(ctx)        — fired AFTER the steal decision but BEFORE the identity
//     re-confirm + atomic rename-steal. A test can recreate a fresh lock here to
//     simulate a racer winning the steal in the decision→steal gap, proving the
//     identity re-confirm aborts a double-steal (PR #1532 review window b).
//
// All hooks default to no-ops; real callers are byte-for-behaviour unchanged.
// ---------------------------------------------------------------------------
interface StateLockTestHooks {
  afterAcquire?: (lockPath: string) => void;
  simulateWriteError?: string | null;
  onLoopIteration?: (ctx: { iteration: number }) => void;
  beforeSteal?: (ctx: { lockPath: string }) => void;
}
const _stateLockTestHooks: StateLockTestHooks = {};

/**
 * Consume the one-shot simulateWriteError errno, if set. Returns an Error with the
 * configured `.code` and self-clears so only the NEXT writeSync throws (the retry
 * then succeeds). Returns null when no injection is pending.
 */
function _consumeSimulatedWriteError(): NodeJS.ErrnoException | null {
  const code = _stateLockTestHooks.simulateWriteError;
  if (!code) return null;
  _stateLockTestHooks.simulateWriteError = null; // one-shot
  const e = new Error('simulated writeSync failure (' + code + ')') as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function _stateLockIsPidAlive(pid: number): boolean {
  return _stateLockProbes.isPidAlive(pid);
}

/**
 * Is the holder recorded in the lock body VERIFIED-LIVE? The STATE.md lock body is
 * a bare pid (written at acquire time). Returns true ONLY when the body parses to a
 * positive integer pid AND that pid signals alive. A garbage / non-numeric / legacy
 * body (or a dead pid) is NOT verified-live, so the lock stays stealable — corrupt
 * locks never block forever, and a live holder is never stolen.
 */
function _stateHolderVerifiedLive(lockPath: string): boolean {
  const pid = _stateLockBodyPid(lockPath);
  return pid !== null && _stateLockIsPidAlive(pid);
}

/**
 * Parse the lock body to its recorded pid, or null when the body is empty / non-numeric
 * / unreadable (legacy or mid-creation). Distinguishing a COMPLETE dead-pid body (steal
 * promptly) from an EMPTY/unparseable one (the create→write window — do not steal while
 * fresh) is what `_stateHolderVerifiedLive` alone cannot express, so the steal decision
 * in acquireStateLock reads the pid directly (PR #1532 review, window a).
 */
function _stateLockBodyPid(lockPath: string): number | null {
  let body: string;
  try {
    body = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return null; // unreadable body → cannot verify
  }
  const trimmed = body.trim();
  const pid = parseInt(trimmed, 10);
  if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== trimmed) return null;
  return pid;
}

// Monotonic sequence for unique stale-steal rename targets (no crypto dependency).
let _stateStealSeq = 0;

// Hoisted to module scope — compiled once, not per call (#320). Stateless (/i, used with .match).
const byPhaseTablePattern = /(\|\s*Phase\s*\|\s*Plans\s*\|\s*Total\s*\|\s*Avg\/Plan\s*\|[ \t]*\r?\n\|(?:[- :\t]+\|)+[ \t]*\r?\n)((?:[ \t]*\|[^\n]*\n)*)(?=\r?\n|$)/i;

// ─── ADR-1372 T6: seam-based section splice helper ───────────────────────────

// Shared stop predicates corresponding to the regex lookaheads used in state.cts:
//   STOP_H2_PLUS : (?=\n##|$)            — stops at any heading with level ≥ 2
//   STOP_H2_H3   : (?=\n###?|\n##[^#]|$) — stops at level 2 or 3
//   STOP_H2_ONLY : (?=\n##[^#]|$)        — stops at level 2 only
const STOP_H2_PLUS = (lv: number): boolean => lv >= 2;
const STOP_H2_H3 = (lv: number): boolean => lv === 2 || lv === 3;
const STOP_H2_ONLY = (lv: number): boolean => lv === 2;

function cmdStateLoad(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const planDir = planningPaths(cwd).planning;

  const stateRaw = platformReadSync(path.join(planDir, 'STATE.md')) || '';

  const configExists = fs.existsSync(path.join(planDir, 'config.json'));
  const roadmapExists = fs.existsSync(path.join(planDir, 'ROADMAP.md'));
  const stateExists = stateRaw.length > 0;

  const result = {
    config,
    state_raw: stateRaw,
    state_exists: stateExists,
    roadmap_exists: roadmapExists,
    config_exists: configExists,
  };

  // For --raw, output a condensed key=value format
  if (raw) {
    const c = config as Record<string, string | boolean | undefined>;
    const lines = [
      `model_profile=${c['model_profile']}`,
      `commit_docs=${c['commit_docs']}`,
      `branching_strategy=${c['branching_strategy']}`,
      `phase_branch_template=${c['phase_branch_template']}`,
      `milestone_branch_template=${c['milestone_branch_template']}`,
      `parallelization=${c['parallelization']}`,
      `research=${c['research']}`,
      `plan_checker=${c['plan_checker']}`,
      `verifier=${c['verifier']}`,
      `config_exists=${configExists}`,
      `roadmap_exists=${roadmapExists}`,
      `state_exists=${stateExists}`,
    ];
    process.stdout.write(lines.join('\n'));
    process.exit(0);
  }

  output(result, false, undefined);
}

function cmdStateGet(cwd: string, section: string | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  const content = platformReadSync(statePath);
  if (content === null) {
    error('STATE.md not found');
    return;
  }
  {

    if (!section) {
      output({ content }, raw, content);
      return;
    }

    // Try to find markdown section or field
    const fieldEscaped = escapeRegex(section);

    // Check for **field:** value (bold format)
    const boldPattern = new RegExp(`\\*\\*${fieldEscaped}:\\*\\*\\s*(.*)`, 'i');
    const boldMatch = content.match(boldPattern);
    if (boldMatch) {
      output({ [section]: boldMatch[1].trim() }, raw, boldMatch[1].trim());
      return;
    }

    // Check for field: value (plain format)
    const plainPattern = new RegExp(`^${fieldEscaped}:\\s*(.*)`, 'im');
    const plainMatch = content.match(plainPattern);
    if (plainMatch) {
      output({ [section]: plainMatch[1].trim() }, raw, plainMatch[1].trim());
      return;
    }

    // Check for ## Section
    const sectionPattern = new RegExp(`##\\s*${fieldEscaped}\\s*\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const sectionMatch = content.match(sectionPattern);
    if (sectionMatch) {
      output({ [section]: sectionMatch[1].trim() }, raw, sectionMatch[1].trim());
      return;
    }

    output({ error: `Section or field "${section}" not found` }, raw, '');
  }
}

function readTextArgOrFile(cwd: string, value: string | undefined, filePath: string | undefined, label: string): string | undefined {
  if (!filePath) return value;

  // Path traversal guard: ensure file resolves within project directory
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validatePath } = require('./security.cjs') as { validatePath(filePath: unknown, baseDir: unknown, opts?: { allowAbsolute?: boolean }): { safe: boolean; resolved: string; error?: string } };
  const pathCheck = validatePath(filePath, cwd, { allowAbsolute: true });
  if (!pathCheck.safe) {
    throw new Error(`${label} path rejected: ${pathCheck.error as string}`);
  }

  try {
    return fs.readFileSync(pathCheck.resolved, 'utf-8').trimEnd();
  } catch {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function cmdStatePatch(cwd: string, patches: Record<string, string>, raw: boolean): void {
  // Validate all field names before processing
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validateFieldName } = require('./security.cjs') as { validateFieldName(field: unknown): { valid: boolean; error?: string } };
  for (const field of Object.keys(patches)) {
    const fieldCheck = validateFieldName(field);
    if (!fieldCheck.valid) {
      error(`state patch: ${fieldCheck.error as string}`);
    }
  }

  const statePath = planningPaths(cwd).state;
  try {
    const shouldResync = shouldResyncStateProgress(Object.keys(patches));

    // ADR-1769 Phase 6: dispatches to the STATE.md Transition Module. The
    // per-patch stateReplaceField loop is the pure `patchCore` in
    // src/state-transition.cts. readModifyWriteStateMd still owns the lock, the
    // #1230/#1264 post-sync preservation, AND the #1695 curated-current_phase_name
    // delta (table-driven) that this phase adds. Field-name validation (security)
    // and the resync-progress decision stay in this adapter.
    let results: { updated: string[]; failed: string[] } = { updated: [], failed: [] };
    readModifyWriteStateMd(statePath, (content) => {
      const result = transitionCore(content, { kind: 'patch', patches }, { clock: realClock, progressProvider: () => null });
      results = (result.data as { updated: string[]; failed: string[] }) ?? results;
      return result.content;
    }, cwd, { resync: shouldResync });

    output(results, raw, results.updated.length > 0 ? 'true' : 'false');
  } catch {
    error('STATE.md not found');
  }
}

function cmdStateUpdate(cwd: string, field: string | undefined, value: string | undefined): void {
  if (!field || value === undefined) {
    error('field and value required for state update');
  }

  // Validate field name to prevent regex injection via crafted field names
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method
  const { validateFieldName } = require('./security.cjs') as { validateFieldName(field: unknown): { valid: boolean; error?: string } };
  const fieldCheck = validateFieldName(field);
  if (!fieldCheck.valid) {
    error(`state update: ${fieldCheck.error as string}`);
  }

  const statePath = planningPaths(cwd).state;
  try {
    let updated = false;
    const shouldResync = shouldResyncStateProgress([field as string]);
    // ADR-1769 Phase 7: dispatches to the STATE.md Transition Module. The
    // body-strip/reassemble single-field update is the pure `updateCore` in
    // src/state-transition.cts. readModifyWriteStateMd still owns the lock, the
    // #1230/#1264/#1695 post-sync preservation, and the no-op write guard.
    // Preserve curated progress for body-only updates, but allow fields that
    // directly project into progress.* frontmatter to rebuild after mutation.
    readModifyWriteStateMd(statePath, (content) => {
      const result = transitionCore(
        content,
        { kind: 'update', field: field as string, value: value as string },
        { clock: realClock, progressProvider: () => null },
      );
      updated = (result.data as { updated: boolean } | undefined)?.updated === true;
      return result.content;
    }, cwd, { resync: shouldResync });
    if (updated) {
      output({ updated: true }, false, undefined);
    } else {
      output({ updated: false, reason: `Field "${field as string}" not found in STATE.md` }, false, undefined);
    }
  } catch {
    output({ updated: false, reason: 'STATE.md not found' }, false, undefined);
  }
}

// ─── State Progression Engine ────────────────────────────────────────────────

/**
 * Replace a STATE.md field with fallback field name support.
 * Tries `primary` first, then `fallback` (if provided), returns content unchanged
 * if neither matches. This consolidates the replaceWithFallback pattern that was
 * previously duplicated inline across phase.cjs, milestone.cjs, and state.cjs.
 */
function stateReplaceFieldWithFallback(content: string, primary: string, fallback: string | null | undefined, value: string): string {
  let result = stateReplaceField(content, primary, value);
  if (result) return result;
  if (fallback) {
    result = stateReplaceField(content, fallback, value);
    if (result) return result;
  }
  // Neither pattern matched — field may have been reformatted or removed.
  // Log diagnostic so template drift is detected early rather than silently swallowed.
  process.stderr.write(
    `[gsd-tools] WARNING: STATE.md field "${primary}"${fallback ? ` (fallback: "${fallback}")` : ''} not found — update skipped. ` +
    `This may indicate STATE.md was externally modified or uses an unexpected format.\n`
  );
  return content;
}

function cmdStateAdvancePlan(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  // ADR-1769 Phase 2: dispatches to the STATE.md Transition Module. The
  // ~80-line RMW callback that used to live here (plan parsing, advance vs
  // phase-complete branching, template-default-aware field replacement,
  // Current Position section mutation) is now the pure `advancePlanCore`
  // function in src/state-transition.cts.
  const intent: StateTransitionIntent = { kind: 'advancePlan' };
  const deps: StateTransitionDeps = {
    clock: realClock,
    progressProvider: () => null,
  };

  let resultData: Record<string, unknown> | undefined;
  readModifyWriteStateMd(statePath, (content) => {
    const result = transitionCore(content, intent, deps);
    resultData = result.data;
    return result.content;
  }, cwd);

  if (!resultData || resultData['error']) {
    output({ error: 'Cannot parse Current Plan or Total Plans in Phase from STATE.md' }, raw, undefined);
    return;
  }

  if (resultData['advanced'] === false) {
    output(resultData, raw, 'false');
  } else {
    output(resultData, raw, 'true');
  }
}

function cmdStateRecordMetric(cwd: string, options: StateRecordMetricOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, plan, duration, tasks, files } = options;

  if (!phase || !plan || !duration) {
    output({ error: 'phase, plan, and duration required' }, raw, undefined);
    return;
  }

  let _recorded = false;
  let created = false;
  readModifyWriteStateMd(statePath, (content) => {
    // Find Performance Metrics section and its table
    const metricsPattern = /(##\s*Performance Metrics[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n)([\s\S]*?)(?=\n##|\n$|$)/i; // allow-adhoc-markdown: metrics-table write-path section-collect in state.cts; pending collectSection migration #1372
    const metricsMatch = content.match(metricsPattern);

    const newRow = `| Phase ${phase} P${plan} | ${duration} | ${tasks || '-'} tasks | ${files || '-'} files |`;

    if (metricsMatch) {
      let tableBody = metricsMatch[2].trimEnd();

      if (tableBody.trim() === '' || tableBody.includes('None yet')) {
        tableBody = newRow;
      } else {
        tableBody = tableBody + '\n' + newRow;
      }

      _recorded = true;
      return content.replace(metricsPattern, (_match, header: string) => `${header}${tableBody}\n`);
    }

    // Section absent — DWIM: auto-create canonical ## Performance Metrics scaffold,
    // then append the row. Matches state begin-phase / advance-plan DWIM behavior.
    const scaffold = [
      '',
      '## Performance Metrics',
      '',
      '| Phase | Plan | Duration | Notes |',
      '|-------|------|----------|-------|',
      newRow,
      '',
    ].join('\n');
    _recorded = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees recorded === true; no else branch needed.
  const result: Record<string, unknown> = { recorded: true, phase, plan, duration };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

function cmdStateUpdateProgress(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  // Count summaries across current milestone phases only (outside lock — read-only)
  const phasesDir = planningPaths(cwd).phases;
  let totalPlans = 0;
  let totalSummaries = 0;

  if (fs.existsSync(phasesDir)) {
    const isDirInMilestone = getMilestonePhaseFilter(cwd) as (dir: string) => boolean;
    const phaseDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name)
      .filter(isDirInMilestone);
    for (const dir of phaseDirs) {
      const { planCount, summaryCount } = scanPhasePlans(path.join(phasesDir, dir));
      totalPlans += planCount;
      totalSummaries += summaryCount;
    }
  }

  const percent = totalPlans > 0 ? Math.min(100, Math.round(totalSummaries / totalPlans * 100)) : 0;
  const barWidth = 10;
  const filled = Math.round(percent / 100 * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const progressStr = `[${bar}] ${percent}%`;

  let updated = false;
  const _totalPlans = totalPlans;
  const _totalSummaries = totalSummaries;

  readModifyWriteStateMd(statePath, (content) => {
    // Try **Progress:** bold format first, then plain Progress: format
    const boldProgressPattern = /(\*\*Progress:\*\*\s*).*/i;
    const plainProgressPattern = /^(Progress:\s*).*/im;
    if (boldProgressPattern.test(content)) {
      updated = true;
      return content.replace(boldProgressPattern, (_match, prefix: string) => `${prefix}${progressStr}`);
    } else if (plainProgressPattern.test(content)) {
      updated = true;
      return content.replace(plainProgressPattern, (_match, prefix: string) => `${prefix}${progressStr}`);
    }
    return content;
  }, cwd);

  if (updated) {
    output({ updated: true, percent, completed: _totalSummaries, total: _totalPlans, bar: progressStr }, raw, progressStr);
  } else {
    output({ updated: false, reason: 'Progress field not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateAddDecision(cwd: string, options: StateAddDecisionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, summary, summary_file, rationale, rationale_file } = options;
  let summaryText: string | undefined = undefined;
  let rationaleText = '';

  try {
    summaryText = readTextArgOrFile(cwd, summary, summary_file, 'summary');
    rationaleText = readTextArgOrFile(cwd, rationale || '', rationale_file, 'rationale') || '';
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }

  if (!summaryText) { output({ error: 'summary required' }, raw, undefined); return; }

  const entry = `- [Phase ${phase || '?'}]: ${summaryText}${rationaleText ? ` — ${rationaleText}` : ''}`;
  let _added = false;
  let created = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Decisions section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Decisions|Decisions Made|Accumulated.*Decisions)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const decisionsPred = (lv: number, text: string): boolean =>
      (lv === 2 || lv === 3) && /^(?:Decisions|Decisions Made|Accumulated.*Decisions)$/i.test(text);
    const sectionBody = (() => {
      const hs = tokenizeHeadings(content);
      const i = hs.findIndex(h => decisionsPred(h.level, h.text));
      if (i === -1) return null;
      const h = hs[i];
      const ls = content.split('\n');
      const hl = ls[h.line - 1];
      const bs = h.offset + hl.length + 1;
      let se = content.length;
      for (let j = i + 1; j < hs.length; j++) {
        if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
      }
      return { bodyStart: bs, bodyEnd: se, body: content.slice(bs, se) };
    })();

    if (sectionBody !== null) {
      let newBody = sectionBody.body;
      // Remove placeholders
      newBody = newBody.replace(/None yet\.?\s*\n?/gi, '').replace(/No decisions yet\.?\s*\n?/gi, '');
      newBody = newBody.trimEnd() + '\n' + entry + '\n';
      _added = true;
      return content.slice(0, sectionBody.bodyStart) + newBody + content.slice(sectionBody.bodyEnd);
    }

    // Section absent — DWIM: auto-create canonical ## Decisions scaffold,
    // then append the entry. Matches state begin-phase / advance-plan DWIM behavior.
    const scaffold = [
      '',
      '## Decisions',
      '',
      entry,
      '',
    ].join('\n');
    _added = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees added === true; no else branch needed.
  const result: Record<string, unknown> = { added: true, decision: entry };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

function cmdStateAddBlocker(cwd: string, text: string | StateAddBlockerOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }
  const blockerOptions: StateAddBlockerOptions = typeof text === 'object' && text !== null ? text : { text: text };
  let blockerText: string | undefined = undefined;

  try {
    blockerText = readTextArgOrFile(cwd, blockerOptions.text, blockerOptions.text_file, 'blocker');
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }

  if (!blockerText) { output({ error: 'text required' }, raw, undefined); return; }

  const entry = `- ${blockerText}`;
  let _added = false;
  let created = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Blockers/Concerns section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const blockersPred = (lv: number, text: string): boolean =>
      (lv === 2 || lv === 3) && /^(?:Blockers|Blockers\/Concerns|Concerns)$/i.test(text);
    const sectionSpan = (() => {
      const hs = tokenizeHeadings(content);
      const i = hs.findIndex(h => blockersPred(h.level, h.text));
      if (i === -1) return null;
      const h = hs[i];
      const ls = content.split('\n');
      const hl = ls[h.line - 1];
      const bs = h.offset + hl.length + 1;
      let se = content.length;
      for (let j = i + 1; j < hs.length; j++) {
        if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
      }
      return { bodyStart: bs, bodyEnd: se, body: content.slice(bs, se) };
    })();

    if (sectionSpan !== null) {
      let sectionBody = sectionSpan.body;
      sectionBody = sectionBody.replace(/None\.?\s*\n?/gi, '').replace(/None yet\.?\s*\n?/gi, '');
      sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
      _added = true;
      return content.slice(0, sectionSpan.bodyStart) + sectionBody + content.slice(sectionSpan.bodyEnd);
    }

    // Section absent — DWIM: auto-create canonical ### Blockers scaffold.
    const scaffold = [
      '',
      '### Blockers',
      '',
      entry,
      '',
    ].join('\n');
    _added = true;
    created = true;
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  // Auto-create fallback guarantees added === true; no else branch needed.
  const result: Record<string, unknown> = { added: true, blocker: blockerText };
  if (created) result['created'] = true;
  output(result, raw, 'true');
}

function cmdStateAddRoadmapEvolution(cwd: string, options: StateAddRoadmapEvolutionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const { phase, action, after, note, note_file, urgent } = options;
  let noteText: string | undefined = undefined;
  try {
    noteText = readTextArgOrFile(cwd, note, note_file, 'note');
  } catch (err) {
    output({ added: false, reason: (err as Error).message }, raw, 'false');
    return;
  }
  // Reject missing / empty / whitespace-only notes — an evolution entry with no
  // narrative is meaningless and would corrupt the section with a dangling bullet.
  if (!noteText || !noteText.trim()) { output({ error: 'note required' }, raw, undefined); return; }
  // Flatten line breaks so the entry is always a single Markdown bullet. The
  // dedupe + rendering contract is line-oriented; a multiline --note-file would
  // otherwise spill continuation lines outside the bullet and defeat dedupe.
  // Internal spacing (e.g. dollar columns) is preserved.
  const flatNote = noteText.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  const actionText = (action && action.trim()) || 'changed';
  const afterText = after && after.trim() ? ` after Phase ${after.trim()}` : '';
  const urgentText = urgent ? ' (URGENT)' : '';
  const entry = `- Phase ${phase || '?'} ${actionText}${afterText}: ${flatNote}${urgentText}`;

  let duplicate = false;
  let created = false;
  let subsectionCreated = false;

  // The Roadmap Evolution subsection lives under `## Accumulated Context`. Scope
  // every lookup to that section's body so a `### Roadmap Evolution` heading in an
  // unrelated h2 section (or a fenced example) can never be matched or mutated.
  // The accBody lookahead stops only at the next h2 (`\n##[^#]`), so nested h3
  // subsections stay inside the captured Accumulated Context body.
  // Section boundaries mirror the sibling handlers (add-decision/add-blocker):
  // a trailing CR on a CRLF STATE.md is absorbed by the lazy body and trimmed,
  // so following sections are preserved without data loss (see the CRLF test).
  //
  // ADR-1372 T6: accPattern and subPattern migrated to tokenizeHeadings.
  // accPattern  = /(##\s*Accumulated Context\s*\n)([\s\S]*?)(?=\n##[^#]|$)/i
  //               → stop at level 2 only (STOP_H2_ONLY)
  // subPattern  = /(###\s*Roadmap Evolution\s*\n)([\s\S]*?)(?=\n###?|$)/i
  //               → applied to accBody; stop at level 2 or 3 (STOP_H2_H3)
  readModifyWriteStateMd(statePath, (content) => {
    // Locate ## Accumulated Context and extract its untrimmed body span.
    const accHs = tokenizeHeadings(content);
    const accIdx = accHs.findIndex(h => h.level === 2 && /^accumulated\s+context$/i.test(h.text));

    if (accIdx !== -1) {
      const accH = accHs[accIdx];
      const contentLines = content.split('\n');
      const accHL = contentLines[accH.line - 1];
      const accBodyStart = accH.offset + accHL.length + 1;
      let accBodyEnd = content.length;
      for (let j = accIdx + 1; j < accHs.length; j++) {
        if (STOP_H2_ONLY(accHs[j].level)) { accBodyEnd = accHs[j].offset - 1; break; }
      }
      const accBody = content.slice(accBodyStart, accBodyEnd);

      // Find `### Roadmap Evolution` WITHIN the Accumulated Context body only.
      // tokenizeHeadings is applied to accBody to scope the search.
      // Stop predicate mirrors (?=\n###?|$): level 2 or 3.
      const subHs = tokenizeHeadings(accBody);
      const subIdx = subHs.findIndex(h => h.level === 3 && /^roadmap\s+evolution$/i.test(h.text));

      if (subIdx !== -1) {
        const subH = subHs[subIdx];
        const accLines = accBody.split('\n');
        const subHL = accLines[subH.line - 1];
        const subBodyStart = subH.offset + subHL.length + 1;
        let subBodyEnd = accBody.length;
        for (let j = subIdx + 1; j < subHs.length; j++) {
          if (STOP_H2_H3(subHs[j].level)) { subBodyEnd = subHs[j].offset - 1; break; }
        }
        let subBody = accBody.slice(subBodyStart, subBodyEnd);

        // Dedupe: exact (trimmed) line already present is a no-op replay.
        if (subBody.split('\n').some((line) => line.trim() === entry.trim())) {
          duplicate = true;
          return content;
        }
        subBody = subBody.replace(/None yet\.?\s*\n?/gi, '');
        subBody = subBody.trimEnd() + '\n' + entry + '\n';
        // Splice subBody into accBody, then splice newAccBody into content.
        const newAccBody = accBody.slice(0, subBodyStart) + subBody + accBody.slice(subBodyEnd);
        return content.slice(0, accBodyStart) + newAccBody + content.slice(accBodyEnd);
      }

      // Subsection missing — append it at the end of the Accumulated Context body.
      subsectionCreated = true;
      const trimmedAcc = accBody.trimEnd();
      const block = `${trimmedAcc ? `${trimmedAcc}\n\n` : ''}### Roadmap Evolution\n\n${entry}\n`;
      return content.slice(0, accBodyStart) + block + content.slice(accBodyEnd);
    }

    // No `## Accumulated Context` — DWIM: create both at end of file.
    // Mirrors the add-decision / add-blocker auto-create behavior.
    created = true;
    subsectionCreated = true;
    const scaffold = [
      '',
      '## Accumulated Context',
      '',
      '### Roadmap Evolution',
      '',
      entry,
      '',
    ].join('\n');
    return content.trimEnd() + '\n' + scaffold;
  }, cwd);

  if (duplicate) {
    output({ added: false, reason: 'duplicate', entry }, raw, 'false');
    return;
  }
  const result: Record<string, unknown> = { added: true, entry };
  if (created) result['created'] = true;
  if (subsectionCreated) result['subsection_created'] = true;
  output(result, raw, 'true');
}

function cmdStateResolveBlocker(cwd: string, text: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }
  if (!text) { output({ error: 'text required' }, raw, undefined); return; }

  let resolved = false;

  readModifyWriteStateMd(statePath, (content) => {
    // ADR-1372 T6: find Blockers/Concerns section via tokenizeHeadings; stop at level 2 or 3.
    // Mirrors /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i
    const hs = tokenizeHeadings(content);
    const i = hs.findIndex(h => (h.level === 2 || h.level === 3) && /^(?:Blockers|Blockers\/Concerns|Concerns)$/i.test(h.text));
    if (i === -1) return content;

    const h = hs[i];
    const ls = content.split('\n');
    const hl = ls[h.line - 1];
    const bs = h.offset + hl.length + 1;
    let se = content.length;
    for (let j = i + 1; j < hs.length; j++) {
      if (STOP_H2_H3(hs[j].level)) { se = hs[j].offset - 1; break; }
    }
    const sectionBody = content.slice(bs, se);
    const lines = sectionBody.split('\n');
    const filtered = lines.filter(line => {
      if (!line.startsWith('- ')) return true;
      return !line.toLowerCase().includes(text.toLowerCase());
    });

    let newBody = filtered.join('\n');
    // If section is now empty, add placeholder
    if (!newBody.trim() || !newBody.includes('- ')) {
      newBody = 'None\n';
    }

    resolved = true;
    return content.slice(0, bs) + newBody + content.slice(se);
  }, cwd);

  if (resolved) {
    output({ resolved: true, blocker: text }, raw, 'true');
  } else {
    output({ resolved: false, reason: 'Blockers section not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateRecordSession(cwd: string, options: StateRecordSessionOptions, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw, undefined); return; }

  const now = realClock.nowIso();
  const updated: string[] = [];
  let sessionCreated = false;

  readModifyWriteStateMd(statePath, (content) => {
    // Update Last session / Last Date
    let result = stateReplaceField(content, 'Last session', now);
    if (result) { content = result; updated.push('Last session'); }
    result = stateReplaceField(content, 'Last Date', now);
    if (result) { content = result; updated.push('Last Date'); }

    // Update Stopped at
    if (options.stopped_at) {
      result = stateReplaceField(content, 'Stopped At', options.stopped_at);
      if (!result) result = stateReplaceField(content, 'Stopped at', options.stopped_at);
      if (result) { content = result; updated.push('Stopped At'); }
    }

    // Update Resume File — only when the caller explicitly passed a value OR the
    // existing value is a known template default.  An executor-authored path must
    // not be silently replaced with 'None' just because --resume-file was omitted
    // (Knuth invariant: handler-owns-transition-between-known-template-defaults).
    const resumeFileDefaults = KNOWN_TEMPLATE_DEFAULTS['Resume File'];
    if (options.resume_file !== undefined && options.resume_file !== null) {
      // Caller explicitly passed a value — always honour it.
      result = stateReplaceField(content, 'Resume File', options.resume_file);
      if (!result) result = stateReplaceField(content, 'Resume file', options.resume_file);
      if (result) { content = result; updated.push('Resume File'); }
    } else {
      // No explicit value — only set 'None' when existing value is also a known default
      // (i.e. not executor-authored).
      const newRf = stateReplaceFieldIfTemplate(content, 'Resume File', resumeFileDefaults, 'None');
      if (newRf !== content) {
        content = newRf;
        updated.push('Resume File');
      } else {
        // Try alternate capitalisation
        const newRfAlt = stateReplaceFieldIfTemplate(content, 'Resume file', resumeFileDefaults, 'None');
        if (newRfAlt !== content) {
          content = newRfAlt;
          updated.push('Resume File');
        }
      }
    }

    // Bug #944: DWIM normalize/auto-create — when the caller supplied --stopped-at or
    // --resume-file but the body lacks the canonical labels (in-place replace
    // returned a miss), persist the values durably. Mirrors the DWIM pattern used
    // by add-decision, add-blocker, and record-metric. Never silently drop
    // caller-supplied values.
    //
    // Guard: only act when the caller actually supplied a value. When no
    // --stopped-at / --resume-file are given and the body already had no session
    // labels (nothing was updated), we return recorded:false — the existing
    // behaviour for a no-op call that didn't supply any values.
    //
    // Correctness invariant: both buildStateFrontmatter and cmdStateSnapshot read
    // only the FIRST `## Session` block (via a /##\s*Session\s*\n…/i regex).
    // If we blindly append a second `## Session` block when one already exists, the
    // newly-written Stopped at / Resume file end up in the second (invisible) block.
    // Fix: when a `## Session` heading already exists, normalize THAT block in place
    // (insert / replace canonical bold-label lines within the existing section).
    // A `## Session Continuity` heading (bootstrap shape) is handled additively —
    // missing canonical fields are inserted while the heading and any prose are
    // preserved (#1101). Only append a brand-new section when NEITHER heading exists.
    const callerSuppliedValues = !!(options.stopped_at || (options.resume_file !== undefined && options.resume_file !== null));
    const needsStoppedAt = options.stopped_at && !updated.includes('Stopped At');
    const needsResumeFile = options.resume_file !== undefined && options.resume_file !== null && !updated.includes('Resume File');
    const needsLastSession = !updated.includes('Last session') && !updated.includes('Last Date');

    if (callerSuppliedValues && (needsStoppedAt || needsResumeFile || needsLastSession)) {
      const resumeValue = (options.resume_file !== undefined && options.resume_file !== null)
        ? options.resume_file
        : 'None';
      const stoppedAtValue = options.stopped_at || 'None';

      // Determine whether a session heading already exists in the body. The
      // canonical normalized form is `## Session`; the bootstrap templates
      // (workstream.cts, gsd2-import.cts, templates/state.md) instead emit
      // `## Session Continuity`. Treat each separately so we never append a
      // duplicate section alongside an existing one.
      const existingCanonicalSession = /^## Session[ \t]*$/im.test(content);
      const existingSessionContinuity = /^## Session Continuity[ \t]*$/im.test(content);

      if (existingCanonicalSession) {
        // Normalize in place: replace the ENTIRE BODY of the existing ## Session
        // section (heading + all content up to the next ## heading or EOF) with
        // canonical bold-label lines. The negative-lookahead per-line pattern
        // `(?!^## )[\s\S]` consumes every line that doesn't start with "## ",
        // which correctly stops at the next section boundary without consuming it.
        // A trailing blank line is added so the next ## heading keeps its spacing.
        content = content.replace(
          /^(## Session[ \t]*\n(?:(?!^## )[\s\S])*)/m,
          [
            '## Session',
            '',
            `**Last session:** ${now}`,
            `**Stopped at:** ${stoppedAtValue}`,
            `**Resume file:** ${resumeValue}`,
            '',
            '',
          ].join('\n'),
        );
      } else if (existingSessionContinuity) {
        // #1101: a `## Session Continuity` section already exists (bootstrap
        // shape). Previously this fell through to the append branch and created
        // a SECOND `## Session` block — a duplicate. Instead, insert only the
        // canonical fields that are still missing, right after the heading,
        // preserving the `## Session Continuity` heading and ALL existing lines
        // (e.g. prose like "Next recommended action"). Fields already updated in
        // place above (needs* false) are not re-inserted. A function replacement
        // is used so `$`-bearing caller values are inserted literally (#3454).
        const linesToInsert: string[] = [];
        if (needsLastSession) linesToInsert.push(`**Last session:** ${now}`);
        if (needsStoppedAt) linesToInsert.push(`**Stopped at:** ${stoppedAtValue}`);
        if (needsResumeFile) linesToInsert.push(`**Resume file:** ${resumeValue}`);
        if (linesToInsert.length > 0) {
          // Case-insensitive to match the `existingSessionContinuity` detection
          // above (#1101 review F3) — otherwise a lowercase heading would detect
          // but no-op the insert while still reporting the fields as updated.
          content = content.replace(
            /^(## Session Continuity[ \t]*\n)/im,
            (_m, heading: string) => heading + linesToInsert.join('\n') + '\n',
          );
        }
      } else {
        // No session heading exists at all — append a new canonical section.
        const scaffold = [
          '',
          '## Session',
          '',
          `**Last session:** ${now}`,
          `**Stopped at:** ${stoppedAtValue}`,
          `**Resume file:** ${resumeValue}`,
          '',
        ].join('\n');
        content = content.trimEnd() + '\n' + scaffold;
      }

      sessionCreated = true;

      if (needsLastSession) updated.push('Last session');
      if (needsStoppedAt) updated.push('Stopped At');
      if (needsResumeFile) updated.push('Resume File');
    }

    return content;
  }, cwd);

  if (updated.length > 0) {
    const result: Record<string, unknown> = { recorded: true, updated };
    if (sessionCreated) result['created'] = true;
    output(result, raw, 'true');
  } else {
    output({ recorded: false, reason: 'No session fields found in STATE.md' }, raw, 'false');
  }
}

/**
 * Match the session section body from a STATE.md body. #1101: recognise the
 * bootstrap `## Session Continuity` heading but PREFER the normalized `## Session`
 * block when both exist (legacy duplicate files), so the reader agrees with the
 * writer (which updates `## Session` first). `(?:^|\n)` line-anchors (kept out of
 * `/m` so `$` stays end-of-string for the `(?=\n##|$)` section boundary), which
 * excludes an h3 `### Session Continuity`; the trailing-` Archive` boundary still
 * excludes `## Session Continuity Archive` (preserving the #2444 scoping).
 * Returns the match whose group 1 is the section body, or null.
 */
function matchSessionSection(body: string): RegExpMatchArray | null {
  return body.match(/(?:^|\n)##[ \t]*Session[ \t]*\n([\s\S]*?)(?=\n##|$)/i) // allow-adhoc-markdown: read-only session-section extract in state.cts; pending collectSection migration #1372
    || body.match(/(?:^|\n)##[ \t]*Session Continuity[ \t]*\n([\s\S]*?)(?=\n##|$)/i); // allow-adhoc-markdown: read-only session-continuity section extract in state.cts; pending collectSection migration #1372
}

function parseProsePhaseField(value: string | null): { phase: string | null; name: string | null } {
  // #2121 Phase 2 (#2125): delegate to the canonical anchored parser so this
  // module holds no independent prose phase-id regex. Drives #2111 — the
  // anchored parser returns { phase: null } for a "Milestone vX.Y complete"
  // body line (the old unanchored regex mined the minor-version digit, e.g.
  // v0.5 -> "5"), so syncStateFrontmatter's #905 guard preserves the real
  // current_phase instead of clobbering it.
  return parsePhaseFromProse(value);
}

function parseProseLastActivityField(value: string | null): { date: string | null; description: string | null } {
  if (!value) return { date: null, description: null };
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:\s+[—-]{1,2}\s+(.+))?$/);
  if (!match) return { date: value, description: null };
  return {
    date: match[1],
    description: match[2]?.trim() || null,
  };
}

function cmdStateSnapshot(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;

  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');

  // Bug #3265: prefer YAML frontmatter for canonical scalar fields so that a
  // body table cell containing **Status:** Y cannot shadow the authoritative
  // frontmatter value.  Mirrors the fix in sdk/src/query/state.ts.
  const fm = extractFrontmatter(content) as Record<string, unknown>;
  const body = stripFrontmatter(content);

  // Helper: return frontmatter scalar value when present and non-empty.
  // Accepts strings, numbers, and booleans — coercing non-string primitives to
  // their string representation so callers always receive string | null.
  // Returns null for missing, null/undefined, or empty-after-trim values so
  // the caller falls back to body extraction.
  const fmScalar = (key: string): string | null => {
    const v = fm[key];
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  };

  // Extract basic fields — frontmatter keys take precedence over body
  const prosePhase = parseProsePhaseField(stateExtractField(body, 'Phase'));
  const currentPhase = fmScalar('current_phase') ?? stateExtractField(body, 'Current Phase') ?? prosePhase.phase;
  const currentPhaseName = fmScalar('current_phase_name') ?? stateExtractField(body, 'Current Phase Name') ?? prosePhase.name;
  const totalPhasesRaw = fmScalar('total_phases') ?? stateExtractField(body, 'Total Phases');
  const currentPlan = fmScalar('current_plan') ?? stateExtractField(body, 'Current Plan');
  const totalPlansRaw = fmScalar('total_plans_in_phase') ?? stateExtractField(body, 'Total Plans in Phase');
  const status = fmScalar('status') ?? stateExtractField(body, 'Status');
  const progressRaw = fmScalar('progress') ?? stateExtractField(body, 'Progress');
  const rawLastActivity = stateExtractField(body, 'Last Activity') ?? stateExtractField(body, 'Last activity');
  const proseLastActivity = parseProseLastActivityField(rawLastActivity);
  const lastActivity = fmScalar('last_activity') ?? proseLastActivity.date ?? rawLastActivity;
  const lastActivityDesc = fmScalar('last_activity_desc') ?? stateExtractField(body, 'Last Activity Description') ?? proseLastActivity.description;
  const pausedAt = fmScalar('paused_at') ?? stateExtractField(body, 'Paused At');

  // Parse numeric fields
  const totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  const progressPercent = progressRaw ? parseInt(progressRaw.replace('%', ''), 10) : null;

  // Extract decisions table
  const decisions: Array<{ phase: string; summary: string; rationale: string }> = [];
  const decisionsMatch = body.match(/##\s*Decisions Made[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n([\s\S]*?)(?=\n##|\n$|$)/i); // allow-adhoc-markdown: read-only decisions-table section-collect in state.cts; pending collectSection migration #1372
  if (decisionsMatch) {
    const tableBody = decisionsMatch[1];
    const rows = tableBody.trim().split('\n').filter(r => r.includes('|'));
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 3) {
        decisions.push({
          phase: cells[0],
          summary: cells[1],
          rationale: cells[2],
        });
      }
    }
  }

  // Extract blockers list
  const blockers: string[] = [];
  const blockersMatch = body.match(/##\s*Blockers\s*\n([\s\S]*?)(?=\n##|$)/i); // allow-adhoc-markdown: read-only blockers section-collect in state.cts; pending collectSection migration #1372
  if (blockersMatch) {
    const blockersSection = blockersMatch[1];
    const items = blockersSection.match(/^-\s+(.+)$/gm) || [];
    for (const item of items) {
      blockers.push(item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract session info
  const session: StateSnapshotSession = {
    last_date: null,
    stopped_at: null,
    resume_file: null,
  };

  // #1101: prefer the canonical `## Session` block, falling back to the bootstrap
  // `## Session Continuity` heading. See matchSessionSection for the anchoring.
  const sessionMatch = matchSessionSection(body);
  if (sessionMatch) {
    const sessionSection = sessionMatch[1];
    // Accept both `**Last Date:**` (canonical template form) and `**Last session:**`
    // (the form written by the DWIM auto-create / normalize path added for #944).
    const lastDateMatch = sessionSection.match(/\*\*Last Date:\*\*\s*(.+)/i)
      || sessionSection.match(/^Last Date:\s*(.+)/im)
      || sessionSection.match(/\*\*Last session:\*\*\s*(.+)/i)
      || sessionSection.match(/^Last session:\s*(.+)/im);
    const stoppedAtMatch = sessionSection.match(/\*\*Stopped At:\*\*\s*(.+)/i)
      || sessionSection.match(/^Stopped At:\s*(.+)/im);
    const resumeFileMatch = sessionSection.match(/\*\*Resume File:\*\*\s*(.+)/i)
      || sessionSection.match(/^Resume File:\s*(.+)/im);

    if (lastDateMatch) session.last_date = lastDateMatch[1].trim();
    if (stoppedAtMatch) session.stopped_at = stoppedAtMatch[1].trim();
    if (resumeFileMatch) session.resume_file = resumeFileMatch[1].trim();
  }

  const result = {
    current_phase: currentPhase,
    current_phase_name: currentPhaseName,
    total_phases: totalPhases,
    current_plan: currentPlan,
    total_plans_in_phase: totalPlansInPhase,
    status,
    progress_percent: progressPercent,
    last_activity: lastActivity,
    last_activity_desc: lastActivityDesc,
    decisions,
    blockers,
    paused_at: pausedAt,
    session,
  };

  output(result, raw, undefined);
}

// ─── State Frontmatter Sync ──────────────────────────────────────────────────

/**
 * Canonical key for matching a ROADMAP phase token against an on-disk phase
 * directory: normalizePhaseName collapses padding/case, strips the project-code
 * prefix, and handles decimals/letter-suffixes/milestone-prefixed IDs, so
 * "Phase 4"/"Phase 04"/dir "04-delta" and "Phase PROJ-42"/dir "PROJ-42-foo"
 * each map to one key. For a directory, extract its phase token first.
 *
 * Stripping the project-code prefix is GSD's canonical phase identity (a
 * project_code is a display prefix; normalizePhaseName / phaseTokenMatches treat
 * `CK-01` and `01` as the same phase, which is what lets a prefixed dir match a
 * bare ROADMAP token). A consistent project uses one scheme, so a bare numeric
 * and a same-suffix project-code phase never coexist in one milestone.
 */
function phaseKeyFromToken(token: string): string {
  return normalizePhaseName(token).toUpperCase();
}
function phaseKeyFromDir(dir: string): string {
  return phaseKeyFromToken(extractPhaseToken(dir));
}

/**
 * Extract the set of retired/folded phase keys from a ROADMAP milestone scope
 * (#1514). A retired phase is struck through with GFM strikethrough,
 * e.g. `- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired`.
 * Such a phase keeps a `[x]` mark and often a directory but ships no completion
 * artifact, so it would otherwise inflate `total_phases` (the denominator)
 * without ever satisfying the numerator, freezing a shipped milestone below
 * 100%.
 *
 * Detection is scoped to the lines that canonically mark a phase retired — a
 * checklist entry (`- [x] …`) or a phase heading (`#### Phase …`) — and within
 * those, only a struck span whose SUBJECT is the phase counts: the phase
 * reference must sit at the start of the `~~…~~` span (after optional markdown
 * emphasis), as in `~~**Phase 04: Delta**~~`, `~~Phase 04~~`, or
 * `~~Phase PROJ-42~~`. This ignores struck PROSE that merely mentions a phase
 * (a goal line `~~folded into Phase 05~~`, or `~~Phase 04 was renamed~~`) and
 * the fold target in `~~Phase 04~~ — folded into Phase 05` (outside the span).
 * The phase token shape mirrors the heading counter's `[\w][\w.-]*` so numeric,
 * decimal, and project-code IDs are detected alike. Returns canonical keys
 * (see phaseKeyFromToken).
 */
function extractRetiredPhaseNumbers(scope: string): Set<string> {
  const retired = new Set<string>();
  const isChecklistOrHeading = /^\s*(?:[-*+]\s*\[[ xX]\]|#{1,6}\s)/;
  for (const line of scope.split(/\r?\n/)) {
    if (!isChecklistOrHeading.test(line)) continue;
    const strikeSpan = /~~([^~]*?)~~/g;
    let s: RegExpExecArray | null;
    while ((s = strikeSpan.exec(line)) !== null) {
      const phaseRef = /^[\s*_]*Phase\s+([\w][\w.-]*)/i.exec(s[1]);
      // Require a digit so struck prose like ~~Phase Overview~~ is ignored.
      if (phaseRef && /\d/.test(phaseRef[1])) retired.add(phaseKeyFromToken(phaseRef[1]));
    }
  }
  return retired;
}

/**
 * Extract machine-readable fields from STATE.md markdown body and build
 * a YAML frontmatter object. Allows hooks and scripts to read state
 * reliably via `state json` instead of fragile regex parsing.
 */
function buildStateFrontmatter(bodyContent: string, cwd: string | undefined): Record<string, unknown> {
  const prosePhase = parseProsePhaseField(stateExtractField(bodyContent, 'Phase'));
  const currentPhase = stateExtractField(bodyContent, 'Current Phase') ?? prosePhase.phase;
  const currentPhaseName = stateExtractField(bodyContent, 'Current Phase Name') ?? prosePhase.name;
  const currentPlan = stateExtractField(bodyContent, 'Current Plan');
  const totalPhasesRaw = stateExtractField(bodyContent, 'Total Phases');
  const totalPlansRaw = stateExtractField(bodyContent, 'Total Plans in Phase');
  const status = stateExtractField(bodyContent, 'Status');
  const progressRaw = stateExtractField(bodyContent, 'Progress');
  const rawLastActivity = stateExtractField(bodyContent, 'Last Activity') ?? stateExtractField(bodyContent, 'Last activity');
  const proseLastActivity = parseProseLastActivityField(rawLastActivity);
  const lastActivity = proseLastActivity.date ?? rawLastActivity;
  const lastActivityDesc = stateExtractField(bodyContent, 'Last Activity Description') ?? proseLastActivity.description;
  // Bug #2444: scope Stopped At extraction to the ## Session section so that
  // historical "Stopped at:" prose elsewhere in the body (e.g. in a
  // Session Continuity Archive section) never overwrites the current value.
  // Fall back to full-body search only when no ## Session section exists.
  // #1101: prefer the canonical `## Session` block, falling back to the bootstrap
  // `## Session Continuity` heading. See matchSessionSection for the anchoring.
  const sessionSectionMatch = matchSessionSection(bodyContent);
  const sessionBodyScope = sessionSectionMatch ? sessionSectionMatch[1] : bodyContent;
  const stoppedAt = stateExtractField(sessionBodyScope, 'Stopped At') || stateExtractField(sessionBodyScope, 'Stopped at');
  const pausedAt = stateExtractField(bodyContent, 'Paused At');

  let milestone: string | null = null;
  let milestoneName: string | null = null;
  if (cwd) {
    try {
      const info = getMilestoneInfo(cwd);
      milestone = info.version;
      milestoneName = info.name;
    } catch { /* intentionally empty */ }
  }

  let totalPhases: number | null = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  let completedPhases: number | null = null;
  let totalPlans: number | null = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  let completedPlans: number | null = null;
  // #1761 read-path: set from cached.milestoneBounded inside the disk-scan
  // block; consumed at the percent computation to mirror the cmdStateSync guard.
  let milestoneUnbounded = false;

  if (cwd) {
    try {
      const phasesDir = planningPaths(cwd).phases;
      if (fs.existsSync(phasesDir)) {
        // Use cached disk scan when available — avoids N+1 readdirSync calls
        // on repeated buildStateFrontmatter invocations within the same process (#1967)
        let cached = _diskScanCache.get(cwd);
        if (!cached) {
          // Read the current-milestone ROADMAP scope once: it feeds both the
          // heading-based phase count below and the retired/folded-phase
          // exclusion (#1514). Computed before the disk scan so retired phases
          // can be dropped from the dir set too.
          let roadmapScope: string | null = null;
          let roadmapRaw: string | null = null;
          let retiredPhaseNums = new Set<string>();
          try {
            const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
            roadmapRaw = platformReadSync(roadmapPath);
            if (roadmapRaw !== null) {
              roadmapScope = extractCurrentMilestone(roadmapRaw, cwd);
              retiredPhaseNums = extractRetiredPhaseNumbers(roadmapScope);
            }
          } catch { /* fall through: no roadmap scope → no retired exclusion */ }

          const isDirInMilestone = getMilestonePhaseFilter(cwd) as (dir: string) => boolean;
          const allMatchingDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name)
            .filter(isDirInMilestone);

          // Bug #2445: when stale phase dirs from a prior milestone remain in
          // .planning/phases/ alongside new dirs with the same phase number,
          // de-duplicate by normalized phase number keeping the most recently
          // modified dir. This prevents double-counting (e.g. two "Phase 1" dirs).
          const seenPhaseNums = new Map<string, string>(); // normalizedNum -> dirName
          for (const dir of allMatchingDirs) {
            // #1514: a retired/folded phase keeps a directory but no completion
            // artifact; drop it from the disk phase set so it counts toward
            // neither the denominator nor the numerator (mirrors the heading
            // exclusion below). Project-code-aware via phaseKeyFromDir.
            if (retiredPhaseNums.size > 0 && retiredPhaseNums.has(phaseKeyFromDir(dir))) continue;
            // phase-id-owner: dir-name dedup grouping; diverges from extractPhaseToken/phaseKeyFromDir on project-code-prefixed and multi-segment milestone dirs. Kept local.
            const m = dir.match(/^0*(\d+[A-Za-z]?(?:\.\d+)*)/);
            const key = m ? m[1].toLowerCase() : dir;
            if (!seenPhaseNums.has(key)) {
              seenPhaseNums.set(key, dir);
            } else {
              // Keep the dir that is newer on disk (more likely current milestone)
              try {
                const existing = path.join(phasesDir, seenPhaseNums.get(key) as string);
                const candidate = path.join(phasesDir, dir);
                if (fs.statSync(candidate).mtimeMs > fs.statSync(existing).mtimeMs) {
                  seenPhaseNums.set(key, dir);
                }
              } catch { /* keep existing on stat error */ }
            }
          }
          const phaseDirs = [...seenPhaseNums.values()];

          let diskTotalPlans = 0;
          let diskTotalSummaries = 0;
          let diskCompletedPhases = 0;

          for (const dir of phaseDirs) {
            const phaseDir = path.join(phasesDir, dir);
            const { planCount, summaryCount, completed } = scanPhasePlans(phaseDir);
            diskTotalPlans += planCount;
            diskTotalSummaries += summaryCount;
            if (completed) diskCompletedPhases++;
          }
          // Count phase headings from ROADMAP using a digit-containing pattern
          // that matches both numeric phases (01, 05.1) and project-code phases
          // (PROJ-42, CK-05) but excludes pure-word section headers like
          // `## Phase Overview:` or `## Phase Details:` — single source of
          // truth for total_phases (#549).
          let roadmapPhaseCount = 0;
          if (roadmapScope !== null) {
            // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
            const phaseHeadingPattern = /#{2,4}\s*Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
            let m: RegExpExecArray | null;
            while ((m = phaseHeadingPattern.exec(roadmapScope)) !== null) {
              // Only count tokens that contain at least one digit — excludes
              // pure-word section headings (Overview, Details) while keeping
              // numeric phases (01, 05.1) and project-code IDs (PROJ-42).
              // Also exclude 999.x backlog phases. Mirrors init.cts filter.
              if (!/\d/.test(m[1]) || /^999\b/.test(m[1])) continue;
              // #1514: retired/folded phases are struck through in the ROADMAP;
              // exclude them from the denominator (they can never be completed).
              if (retiredPhaseNums.has(phaseKeyFromToken(m[1]))) continue;
              roadmapPhaseCount++;
            }
          }

          cached = (() => {
            // #1761 read-path: mirror the cmdStateSync guard (#1794). When the
            // asserted milestone version can't be bounded to a versioned ROADMAP
            // heading, extractCurrentMilestone falls back to the whole document
            // and roadmapPhaseCount conflates sibling milestones. In that case
            // don't substitute the whole-doc count — fall back to the on-disk
            // phase-dir count only, and mark unbounded so percent is skipped
            // downstream (mirrors the sync write-path guard).
            let milestoneBounded = true;
            if (milestone && roadmapRaw !== null) {
              const versionedHeading = new RegExp(
                `^#{1,3}\\s+(?!Phase\\s+\\S).*${escapeRegex(String(milestone).trim())}`,
                'mi',
              );
              milestoneBounded = versionedHeading.test(roadmapRaw);
            }
            return {
              totalPhases: (!milestoneBounded || roadmapPhaseCount === 0)
                ? phaseDirs.length
                : Math.max(phaseDirs.length, roadmapPhaseCount),
              milestoneBounded,
              completedPhases: diskCompletedPhases,
              totalPlans: diskTotalPlans,
              completedPlans: diskTotalSummaries,
            };
          })();
          _diskScanCache.set(cwd, cached);
        }
        totalPhases = cached.totalPhases;
        completedPhases = cached.completedPhases;
        totalPlans = cached.totalPlans;
        completedPlans = cached.completedPlans;
        milestoneUnbounded = cached.milestoneBounded === false;
      }
    } catch { /* intentionally empty */ }
  }

  // Derive percent from disk counts when available (ground truth).
  // Uses min(plan_fraction, phase_fraction) via computeProgressPercent so that
  // ROADMAP-declared-but-unrealized future phases cap the reported completion
  // instead of a false 100% from plan-only coverage (#3242 Bug B).
  // Falls back to the body Progress: field only when no plan files exist on disk.
  let progressPercent = computeProgressPercent(completedPlans, totalPlans, completedPhases, totalPhases);
  // #1761 read-path: when the milestone can't be bounded, percent would be
  // derived from a conflated/understated total — skip it (mirror cmdStateSync).
  if (milestoneUnbounded) progressPercent = null;
  if (progressPercent === null && progressRaw && !milestoneUnbounded) {
    const pctMatch = progressRaw.match(/(\d+)%/);
    if (pctMatch) progressPercent = parseInt(pctMatch[1], 10);
  }

  const normalizedStatus = normalizeStateStatus(status, pausedAt);

  const fm: Record<string, unknown> = { gsd_state_version: '1.0' };

  if (milestone) fm['milestone'] = milestone;
  if (milestoneName) fm['milestone_name'] = milestoneName;
  if (currentPhase) fm['current_phase'] = currentPhase;
  if (currentPhaseName) fm['current_phase_name'] = currentPhaseName;
  if (currentPlan) fm['current_plan'] = currentPlan;
  fm['status'] = normalizedStatus;
  if (stoppedAt) fm['stopped_at'] = stoppedAt;
  if (pausedAt) fm['paused_at'] = pausedAt;
  fm['last_updated'] = realClock.nowIso();
  if (lastActivity) fm['last_activity'] = lastActivity;
  if (lastActivityDesc) fm['last_activity_desc'] = lastActivityDesc;

  const progress: Record<string, unknown> = {};
  if (totalPhases !== null) progress['total_phases'] = totalPhases;
  if (completedPhases !== null) progress['completed_phases'] = completedPhases;
  if (totalPlans !== null) progress['total_plans'] = totalPlans;
  if (completedPlans !== null) progress['completed_plans'] = completedPlans;
  if (progressPercent !== null) progress['percent'] = progressPercent;
  if (Object.keys(progress).length > 0) fm['progress'] = progress;

  return fm;
}

function stripFrontmatter(content: string): string {
  // Strip ALL frontmatter blocks at the start of the file.
  // Handles CRLF line endings and multiple stacked blocks (corruption recovery).
  // Greedy: keeps stripping ---...--- blocks separated by optional whitespace.
  let result = content;

  while (true) {
    const stripped = result.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

function syncStateFrontmatter(content: string, cwd: string | undefined): string {
  // Read existing frontmatter BEFORE stripping — it may contain values
  // that the body no longer has (e.g., Status field removed by an agent).
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const body = stripFrontmatter(content);
  const derivedFm = buildStateFrontmatter(body, cwd);

  // Preserve existing frontmatter status when body-derived status is 'unknown'.
  // This prevents a missing Status: field in the body from overwriting a
  // previously valid status (e.g., 'executing' → 'unknown').
  if (derivedFm['status'] === 'unknown' && existingFm['status'] && existingFm['status'] !== 'unknown') {
    derivedFm['status'] = existingFm['status'];
  }

  // Bug #948: preserve `milestone_name` / `milestone` when the derived value
  // is the template placeholder 'milestone'. getMilestoneInfo returns the
  // literal string 'milestone' when it cannot match the version from the roadmap
  // (e.g. no ROADMAP.md, roadmap lacks the heading for the stored version, or the
  // milestone version read from STATE.md itself triggers the lookup before the
  // file is fully written). A placeholder must never overwrite a real name that the
  // existing frontmatter already holds; only an empty derived value falls through
  // to this guard (the primary #905 preserve path below handles that).
  const MILESTONE_NAME_PLACEHOLDER = 'milestone';
  if (
    derivedFm['milestone_name'] === MILESTONE_NAME_PLACEHOLDER &&
    existingFm['milestone_name'] &&
    existingFm['milestone_name'] !== MILESTONE_NAME_PLACEHOLDER
  ) {
    derivedFm['milestone_name'] = existingFm['milestone_name'];
    // Keep the stored milestone version consistent with the preserved name.
    if (existingFm['milestone']) {
      derivedFm['milestone'] = existingFm['milestone'];
    }
  }

  // Bug #905: preserve scalar fields that buildStateFrontmatter can only derive
  // from body annotations (Current Phase:, Current Plan:, etc.). When those
  // annotations are absent — e.g. after an agent or tool rewrites the body —
  // buildStateFrontmatter returns no value for those keys. Mirror the same
  // fallback pattern used in cmdStateJson so the existing frontmatter values
  // survive every writeStateMd call.
  //
  // For stopped_at / paused_at: the original #905 "fall back when derived is
  // absent" rule is preserved here. The stale-body-overwrites-frontmatter
  // scenario from #948 is prevented by the no-op guard in
  // readModifyWriteStateMd: when the transform produces no change the file is
  // never written, so syncStateFrontmatter never even runs. Attempting to
  // "always prefer frontmatter" here breaks legitimate callers like phase.complete
  // that intentionally write a new stopped_at value to the body and expect
  // syncStateFrontmatter to pick it up.
  if (!derivedFm['stopped_at'] && existingFm['stopped_at']) {
    derivedFm['stopped_at'] = existingFm['stopped_at'];
  }
  if (!derivedFm['paused_at'] && existingFm['paused_at']) {
    derivedFm['paused_at'] = existingFm['paused_at'];
  }
  if (!derivedFm['current_phase'] && existingFm['current_phase']) {
    derivedFm['current_phase'] = existingFm['current_phase'];
  }
  if (!derivedFm['current_phase_name'] && existingFm['current_phase_name']) {
    derivedFm['current_phase_name'] = existingFm['current_phase_name'];
  }
  if (!derivedFm['current_plan'] && existingFm['current_plan']) {
    derivedFm['current_plan'] = existingFm['current_plan'];
  }
  // progress is a sub-object: fall back to existing only when the body+disk
  // scan produced NO progress block at all. When buildStateFrontmatter did
  // derive a progress block (even a lower one), that derived value wins — the
  // shouldPreserveExistingProgress cross-milestone logic is applied later in
  // cmdStateJson on the read path where it is appropriate.
  if (!derivedFm['progress'] && existingFm['progress']) {
    derivedFm['progress'] = normalizeProgressNumbers(existingFm['progress']);
  }

  const yamlStr = reconstructFrontmatter(derivedFm as unknown as Frontmatter);
  return `---\n${yamlStr}\n---\n\n${body}`;
}

// Transient errno codes that indicate a temporary filesystem condition under
// concurrent O_EXCL races — Docker overlay-fs (ENOENT/EINVAL/EIO), NFS
// (ESTALE), and OS-level interrupt/retry signals (EAGAIN/EINTR).  These are
// recoverable; acquireStateLock retries instead of propagating them.
// Truly fatal codes (EMFILE, ENOSPC, EROFS, EACCES) are NOT in this set and
// will still throw immediately.
const ACQUIRE_LOCK_RETRY_ERRNOS = new Set([
  'EPERM',   // Windows / macOS AV scanner holds the file open during delete
  'EBUSY',   // Windows: file in use by another process
  'EAGAIN',  // POSIX: resource temporarily unavailable
  'EINTR',   // POSIX: syscall interrupted by signal
  'EINVAL',  // Docker overlay-fs: transient during concurrent O_EXCL creation
  'EIO',     // Docker overlay-fs / NFS: transient I/O error
  'ENOENT',  // Docker overlay-fs: parent dir transiently missing during race
  'ESTALE',  // NFS: stale file handle (self-resolves on retry)
]);

/**
 * Acquire a lockfile for STATE.md operations.
 * Returns the lock path for later release.
 *
 * @param statePath
 * @param clock
 *   Optional clock seam for testing. Defaults to realClock (Date.now + Atomics.wait).
 *   Pass a fake clock from tests/helpers/clock.cjs to drive timeout/stale logic
 *   without real wall-clock waits.
 */
function acquireStateLock(statePath: string, clock?: StateLockClock): string {
  if (clock === undefined) clock = realClock;
  const lockPath = statePath + '.lock';
  const retryDelay = 200; // ms
  const maxWaitMs = 30000;
  // Deadman ceiling (audit M1) — set ABOVE maxWaitMs so a holder that reads as
  // VERIFIED-LIVE is NEVER stolen within the wait budget; only a crashed (dead
  // pid) or unparseable-body lock is stolen, and a pid-reuse holder (reads alive
  // but is unrelated) is recovered once age crosses this absolute ceiling rather
  // than blocking forever. The prior mtime-only `staleThresholdMs = 10000` gate
  // was BELOW maxWaitMs, so a live-but-slow holder >10 s was robbed mid-write.
  const deadmanCeilingMs = 60000;
  // Fresh-create floor (PR #1532 review, window a) — a lock with an EMPTY/unparseable
  // body is either mid-creation (O_EXCL create done, pid not yet written by the holder)
  // or a genuine orphan. While such a body is younger than this floor it is treated as
  // mid-creation and is NEVER stolen — stealing it at age ≈ 0 robs a holder still
  // writing its pid (the lost-update window capability-lock.cts's `age <= LOCK_STALE_MS`
  // floor closes). The create→write gap is sub-millisecond; this floor is orders of
  // magnitude larger yet well under maxWaitMs so a real orphan still clears within budget.
  // A COMPLETE dead-pid body is NOT subject to this floor — it is stolen promptly.
  const freshCreateFloorMs = 1000;
  const startedAt = clock.now();

  // Shared helper: check the time budget then back off with jitter before the
  // next retry.  Both the EEXIST contention path and the recoverable-errno path
  // must go through this so neither can busy-spin (#1217).
  const checkBudgetAndSleep = (context: string) => {
    if (clock.now() - startedAt >= maxWaitMs) {
      const e = new Error(
        'acquireStateLock: ' + lockPath + ' ' + context + ' for ' +
        (clock.now() - startedAt) + 'ms (exceeded ' + maxWaitMs + 'ms budget)'
      );
      (e as unknown as Record<string, unknown>).lockBudgetExceeded = true;
      throw e;
    }
    const jitter = Math.floor(Math.random() * 50);
    clock.sleep(retryDelay + jitter);
  };

  let _loopIteration = 0;
  while (true) {
    if (_stateLockTestHooks.onLoopIteration) _stateLockTestHooks.onLoopIteration({ iteration: _loopIteration++ });
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      // Audit M9 (resource-safety): once the exclusive create SUCCEEDS, a
      // writeSync/closeSync failure must NOT leak the fd or strand the just-created
      // (now empty) lock — an orphan body self-blocks every later acquirer until a
      // liveness steal or the deadman. On any write/close error, guardedly close the
      // fd and unlink the file we created, then re-throw to the existing outer catch
      // (which keeps classifying recoverable vs fatal errnos — DRY). A FATAL errno
      // still propagates after cleanup; a RECOVERABLE one retries from a clean slate.
      // Mirrors capability-lock.cts:415-425.
      try {
        const injected = _consumeSimulatedWriteError();
        if (injected) throw injected; // test seam: one-shot writeSync failure (M9)
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* best-effort — fd may already be closed */ }
        // Best-effort unlink of the lock WE just created. Guarded so we never throw
        // here; if another acquirer already stole the empty lock the unlink is a
        // harmless ENOENT no-op (we do not double-unlink someone else's lock — the
        // open(O_EXCL) above guarantees we created this path this iteration).
        try { fs.unlinkSync(lockPath); } catch { /* best-effort — no orphan */ }
        throw writeErr; // re-throw to the outer catch for recoverable/fatal classification
      }
      // Exit-time cleanup keeps a crashed locked region from leaving a stale file (#1916).
      _heldStateLocks.add(lockPath);
      return lockPath;
    } catch (err) {
      // Transient filesystem errors (Docker overlay-fs, NFS, OS signals, AV scanners)
      // are recoverable — retry with the same budget + backoff as the EEXIST path so
      // a permanently-failing errno cannot busy-spin at 100% CPU (#1217).
      // See ACQUIRE_LOCK_RETRY_ERRNOS for the full list and rationale.
      if (ACQUIRE_LOCK_RETRY_ERRNOS.has((err as NodeJS.ErrnoException).code as string)) {
        checkBudgetAndSleep((err as NodeJS.ErrnoException).code + ' persisted');
        continue;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // propagate — silent bypass causes lost updates
      // Liveness-gated steal (audit M1) + steal-safety (PR #1532 review). The steal
      // decision is three-way on the lock body:
      //   - VERIFIED-LIVE holder (parseable pid that signals alive): NEVER stolen until
      //     its age crosses the absolute deadman ceiling (the pid-reuse backstop) —
      //     nuking a slow-but-live writer's lock causes lost updates (#3711 / #500/#905/
      //     #1230 family).
      //   - COMPLETE DEAD pid (parseable pid, not alive): stolen PROMPTLY regardless of
      //     age — a crashed holder left a full body.
      //   - EMPTY / unparseable body: liveness is unknowable. While FRESH (age <=
      //     freshCreateFloorMs) it is a lock still mid-creation (O_EXCL done, pid not yet
      //     written) and is NOT stolen (window a); only once aged past the floor is it a
      //     genuine orphan and stealable.
      // The steal itself is an ATOMIC rename-then-recreate (only one racer can rename the
      // inode) guarded by an identity re-confirm, so a racer that recreates a fresh lock
      // in the decision→steal gap never has its replacement deleted (window b). Mirrors
      // capability-lock.cts:455-499.
      try {
        const stat = fs.statSync(lockPath);
        const ageMs = clock.now() - stat.mtimeMs;
        const bodyPid = _stateLockBodyPid(lockPath);
        const holderLive = bodyPid !== null && _stateLockIsPidAlive(bodyPid);
        let steal: boolean;
        if (holderLive) {
          steal = ageMs > deadmanCeilingMs;   // pid-reuse backstop only
        } else if (bodyPid !== null) {
          steal = true;                       // complete dead pid → prompt steal
        } else {
          steal = ageMs > freshCreateFloorMs; // empty/garbage → protect the create window
        }
        if (steal) {
          if (_stateLockTestHooks.beforeSteal) _stateLockTestHooks.beforeSteal({ lockPath });
          // Identity re-confirm immediately before the steal: a racer that stole +
          // recreated a fresh lock in the decision→steal gap changes (dev, ino) and/or
          // the body pid → do NOT delete the replacement; re-evaluate from scratch.
          let confirmStat: fs.Stats;
          try {
            confirmStat = fs.statSync(lockPath);
          } catch {
            continue; // lock vanished between decision and steal — retry the create.
          }
          const sameInstance =
            typeof stat.dev === 'number' && typeof stat.ino === 'number' &&
            confirmStat.dev === stat.dev && confirmStat.ino === stat.ino &&
            _stateLockBodyPid(lockPath) === bodyPid;
          if (!sameInstance) {
            // The lock changed under us (a racer won the steal + recreated). Back off
            // and re-evaluate rather than deleting the racer's fresh replacement.
            checkBudgetAndSleep('lock changed before steal');
            continue;
          }
          // Atomic steal: rename the inode aside, then remove it. Only ONE racer can
          // win the rename; a failed rename means another process already stole it, so
          // we must NOT fall through to a delete — back off and retry the create.
          const stolen = lockPath + '.stale-' + process.pid + '-' + clock.now() + '-' + (_stateStealSeq++);
          let renamed = false;
          try { retryRenameSync(lockPath, stolen); renamed = true; } catch { /* another racer won */ }
          if (renamed) {
            try { fs.rmSync(stolen, { force: true }); } catch { /* best-effort */ }
            // Successful steal — retry immediately to grab the just-freed lock.
            // Must NOT call checkBudgetAndSleep here: a throw-after-rename would
            // corrupt filesystem state, and the budget is already bounded on the next
            // iteration's EEXIST or open attempt (#1217 regression fix).
            continue;
          }
          // Lost the steal race (or a transient rename failure) — apply budget + backoff
          // so it cannot busy-spin (#1217).
          checkBudgetAndSleep('stale lock steal lost to racer');
          continue;
        }
      } catch (err) {
        // Re-throw a budget-exceeded error from the steal path above unchanged — its
        // message already names the real cause ("lock changed before steal" / "stale
        // lock steal lost to racer") and double-wrapping it would replace that with the
        // misleading "statSync failed after EEXIST" context string (#1217 diagnostic fix).
        if ((err as Record<string, unknown>)?.lockBudgetExceeded) throw err;
        // statSync failed — lock was likely released between our EEXIST and this
        // stat call.  Apply budget + backoff so a persistent statSync failure
        // cannot busy-spin (#1217).
        checkBudgetAndSleep('statSync failed after EEXIST');
        continue;
      }
      checkBudgetAndSleep('held by live process');
    }
  }
}

function releaseStateLock(lockPath: string): void {
  _heldStateLocks.delete(lockPath);
  try { fs.unlinkSync(lockPath); } catch { /* lock already gone */ }
}

function withStateLock<T>(statePath: string, fn: () => T): T {
  const lockPath = acquireStateLock(statePath);
  try {
    return fn();
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * Write STATE.md with synchronized YAML frontmatter.
 * All STATE.md writes should use this instead of raw writeFileSync.
 * Uses a simple lockfile to prevent parallel agents from overwriting
 * each other's changes (race condition with read-modify-write cycle).
 *
 * @param statePath
 * @param content
 * @param cwd
 * @param clock
 *   Optional clock seam; defaults to realClock. Passed through to acquireStateLock.
 */
function writeStateMd(statePath: string, content: string, cwd?: string, clock?: StateLockClock): void {
  const lockPath = acquireStateLock(statePath, clock);
  // Test seam (audit M8): fire AFTER the lock is taken so a test can simulate a
  // concurrent writer landing in the (now-closed) scan→lock window.
  if (_stateLockTestHooks.afterAcquire) _stateLockTestHooks.afterAcquire(lockPath);
  try {
    // Audit M8 (leaky-abstractions): the disk scan that counts PLAN/SUMMARY files
    // to build the frontmatter is the READ half of this read-modify-write — it must
    // run INSIDE the lock (mirroring readModifyWriteStateMd), not before it. Scanning
    // before acquireStateLock left a TOCTOU window where a concurrent writer that
    // committed a new PLAN/SUMMARY between our scan and our lock made writeStateMd
    // stamp STALE progress counts (lost update — the #500/#905/#1230 family). The
    // scan order is otherwise byte-for-behaviour identical for single-threaded
    // callers — only the concurrent-writer window closes.
    //
    // Invalidate the disk scan cache first — the write may create new PLAN/SUMMARY
    // files that buildStateFrontmatter must see (#1967).
    if (cwd) _diskScanCache.delete(cwd);
    const synced = syncStateFrontmatter(content, cwd);
    platformWriteSync(statePath, synced);
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * Atomic read-modify-write for STATE.md.
 * Holds the lock across the entire read -> transform -> write cycle,
 * preventing the lost-update problem where two agents read the same
 * content and the second write clobbers the first.
 *
 * @param statePath
 * @param transformFn - (content: string) => string
 * @param cwd
 * @param options
 *   resync: when true (default) rebuilds the entire frontmatter from disk after
 *   the transform. Pass { resync: false } for body-only updates (e.g. state.update
 *   on a single field) that must not trample manually-curated cross-milestone
 *   progress.* counters in the frontmatter (#3242 Bug A).
 *   When resync is false, syncStateFrontmatter still runs to maintain/create the
 *   frontmatter block, but any existing progress.* sub-keys are preserved from
 *   the pre-transform file rather than being rebuilt from disk.
 * @param clock
 *   Optional clock seam; defaults to realClock. Passed through to acquireStateLock.
 */
function readModifyWriteStateMd(statePath: string, transformFn: (content: string) => string, cwd: string, options?: ReadModifyWriteOptions, clock?: StateLockClock): void {
  const resync = !options || options.resync !== false;
  const lockPath = acquireStateLock(statePath, clock);
  try {
    const content = platformReadSync(statePath) || '';
    // Snapshot the existing progress block BEFORE the transform so we can
    // restore it when resync is false.
    const preFm = resync ? null : extractFrontmatter(content) as Record<string, unknown>;

    // Bug #1230: delta heuristic — snapshot pre-transform body source fields so
    // we can detect whether THIS write changed them. syncStateFrontmatter
    // re-derives frontmatter status/stopped_at from the body on every write;
    // when the body's source field was NOT changed by the transform, the
    // existing frontmatter value (e.g. a hand-set 'completed') must win over
    // the body-derived value (e.g. 'verifying' from a stale "Status: Verifying
    // Phase 3" line that an earlier tool wrote). We do NOT disturb `preFm`
    // above (null when resync:true) — these are independent snapshots.
    // Strip frontmatter before calling stateExtractField so the YAML `status:`
    // key in the frontmatter block cannot shadow the body field we are tracking.
    const preBody = stripFrontmatter(content);
    const preFmSnapshot = extractFrontmatter(content) as Record<string, unknown>;
    const preBodyStatus = stateExtractField(preBody, 'Status');
    // Bug #1230 / Change B: scope stopped_at delta to the ## Session section,
    // mirroring buildStateFrontmatter's sessionBodyScope logic (line ~1172).
    // A stale "Stopped at:" in a non-Session section (e.g. Session Continuity
    // Archive prose) must not interfere with the delta comparison.
    const preSessionMatch = matchSessionSection(preBody);
    const preSessionScope = preSessionMatch ? preSessionMatch[1] : preBody;
    const preBodyStoppedAt = stateExtractField(preSessionScope, 'Stopped At') || stateExtractField(preSessionScope, 'Stopped at');

    // ADR-1769 Phase 6 / #1743 / #1695: snapshot the body source for the curated
    // current_phase_name (the `Phase:` line parseProsePhaseField harvests). When
    // this write does NOT change that line, the curated frontmatter value must
    // win over syncStateFrontmatter's body re-derivation (which can harvest a
    // wrong parenthetical aside — #1695). Gated by the field-classification
    // table's preserve-always row so the rule lives in one place.
    const preBodyPhaseSource = stateExtractField(preBody, 'Phase');

    const modified = transformFn(content);

    // Bug #948: no-op guard — if the transform produced no change, do NOT write
    // the file. An unconditional write would bump `last_updated`, reset
    // `milestone_name` to the template placeholder, and resurrect stale
    // body-derived `stopped_at` values via syncStateFrontmatter. Skipping the
    // write when content is unchanged is safe because every caller that mutates
    // content already returns the mutated string, and callers that detect a
    // no-op explicitly return the original content unchanged.
    if (modified === content) {
      return;
    }

    let synced = syncStateFrontmatter(modified, cwd);

    // Post-transform body source fields used for the delta comparison (#1230).
    // Use `modified` (not `synced`): syncStateFrontmatter only rewrites the frontmatter block, so the body is identical in both — and we need the body the transform produced.
    // Strip frontmatter so the YAML status key cannot shadow the body field we are tracking.
    const postBody = stripFrontmatter(modified);
    const postBodyStatus = stateExtractField(postBody, 'Status');
    // Bug #1230 / Change B: scope stopped_at delta to the ## Session section,
    // consistent with the pre-transform snapshot above and buildStateFrontmatter.
    const postSessionMatch = matchSessionSection(postBody);
    const postSessionScope = postSessionMatch ? postSessionMatch[1] : postBody;
    const postBodyStoppedAt = stateExtractField(postSessionScope, 'Stopped At') || stateExtractField(postSessionScope, 'Stopped at');
    // ADR-1769 Phase 6 / #1695: post-transform body Phase source for the
    // current_phase_name delta comparison.
    const postBodyPhaseSource = stateExtractField(postBody, 'Phase');

    // ADR-1769 #1796 (Path A — finish the consolidation): the post-sync
    // preservation block is now the pure, table-driven `applyStatePreservation`
    // in the STATE.md Transition Module. progress / status / stopped_at /
    // current_phase_name are all governed by their FIELD_CLASSIFICATION row —
    // one policy source, not three drifting encodings. Behavior-identical to
    // the pre-#1796 inline block; this is the absorption ADR-1769 / CONTEXT.md
    // already claimed shipped.
    const postFm = extractFrontmatter(synced) as Record<string, unknown>;
    const preservation = applyStatePreservation({
      preFm, postFm, preFmSnapshot, resync,
      preBodyStatus, postBodyStatus,
      preBodyStoppedAt, postBodyStoppedAt,
      preBodyPhaseSource, postBodyPhaseSource,
    });
    if (preservation.mutated) {
      const yamlStr = reconstructFrontmatter(preservation.postFm as unknown as Frontmatter);
      const body = stripFrontmatter(synced);
      synced = `---\n${yamlStr}\n---\n\n${body}`;
    }

    platformWriteSync(statePath, synced);
  } finally {
    releaseStateLock(lockPath);
  }
}

function cmdStateJson(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, 'STATE.md not found');
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const body = stripFrontmatter(content);

  // Always rebuild from body + disk so progress counters reflect current state.
  // Returning cached frontmatter directly causes stale percent/completed_plans
  // when SUMMARY files were added after the last STATE.md write (#1589).
  const built = buildStateFrontmatter(body, cwd);

  // Preserve frontmatter-only fields that cannot be recovered from the body.
  if (existingFm && existingFm['stopped_at'] && !built['stopped_at']) {
    built['stopped_at'] = existingFm['stopped_at'];
  }
  if (existingFm && existingFm['paused_at'] && !built['paused_at']) {
    built['paused_at'] = existingFm['paused_at'];
  }
  // Preserve existing status when body-derived status is 'unknown' (same logic as syncStateFrontmatter).
  if (built['status'] === 'unknown' && existingFm && existingFm['status'] && existingFm['status'] !== 'unknown') {
    built['status'] = existingFm['status'];
  }
  // Bug #905: preserve scalar fields when body annotations are absent.
  // Mirrors the same fallback pattern applied in syncStateFrontmatter.
  if (existingFm && !built['current_phase'] && existingFm['current_phase']) {
    built['current_phase'] = existingFm['current_phase'];
  }
  if (existingFm && !built['current_phase_name'] && existingFm['current_phase_name']) {
    built['current_phase_name'] = existingFm['current_phase_name'];
  }
  if (existingFm && !built['current_plan'] && existingFm['current_plan']) {
    built['current_plan'] = existingFm['current_plan'];
  }
  // Preserve curated cross-milestone aggregates when local disk scanning sees
  // only a narrower realized subset (#3242 Bug A). Stale lower counters still
  // rebuild from disk because they do not exceed the derived scan.
  if (existingFm && shouldPreserveExistingProgress(existingFm['progress'], built['progress'])) {
    built['progress'] = normalizeProgressNumbers(existingFm['progress']);
  }

  output(built, raw, JSON.stringify(built, null, 2));
}

/**
 * Update STATE.md when a new phase begins execution.
 * Updates body text fields (Current focus, Status, Last Activity, Current Position)
 * and synchronizes frontmatter via writeStateMd.
 * Fixes: #1102 (plan counts), #1103 (status/last_activity), #1104 (body text).
 */
function cmdStateBeginPhase(cwd: string, phaseNumber: string | number, phaseName: string | null | undefined, planCount: number | null | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  // ADR-1769 Phase 1: dispatches to the STATE.md Transition Module. The 175-line
  // RMW callback that used to live here (format detection + preservation policy
  // + section mutation + idempotency guard + resume branching) is now the pure
  // `transitionCore` function in src/state-transition.cts, backed by the
  // field-classification table. readModifyWriteStateMd still owns the lock,
  // #1230 post-sync preservation, and the no-op write guard.
  const intent: StateTransitionIntent = {
    kind: 'beginPhase',
    phaseNumber,
    phaseName: phaseName ?? null,
    planCount: planCount ?? null,
  };
  const deps: StateTransitionDeps = {
    clock: realClock,
    progressProvider: () => null, // beginPhase doesn't consult disk progress; syncStateFrontmatter's scan is authoritative
  };

  let updated: string[] = [];
  readModifyWriteStateMd(statePath, (content) => {
    const result = transitionCore(content, intent, deps);
    updated = result.updated;
    return result.content;
  }, cwd);

  output({ updated, phase: phaseNumber, phase_name: phaseName || null, plan_count: planCount || null }, raw, updated.length > 0 ? 'true' : 'false');
}

/**
 * Write a WAITING.json signal file when GSD hits a decision point.
 * External watchers (fswatch, polling, orchestrators) can detect this.
 * File is written to .planning/WAITING.json (or .gsd/WAITING.json if .gsd exists).
 * Fixes #1034.
 */
function cmdSignalWaiting(cwd: string, type: string | undefined, question: string | undefined, options: string | undefined, phase: string | undefined, raw: boolean): void {
  const gsdDir = fs.existsSync(path.join(cwd, '.gsd')) ? path.join(cwd, '.gsd') : planningDir(cwd);
  const waitingPath = path.join(gsdDir, 'WAITING.json');

  const signal = {
    status: 'waiting',
    type: type || 'decision_point',
    question: question || null,
    options: options ? options.split('|').map(o => o.trim()) : [],
    since: realClock.nowIso(),
    phase: phase || null,
  };

  try {
    platformEnsureDir(gsdDir);
    platformWriteSync(waitingPath, JSON.stringify(signal, null, 2));
    output({ signaled: true, path: waitingPath }, raw, 'true');
  } catch (e) {
    output({ signaled: false, error: (e as Error).message }, raw, 'false');
  }
}

/**
 * Remove the WAITING.json signal file when user answers and agent resumes.
 */
function cmdSignalResume(cwd: string, raw: boolean): void {
  const paths = [
    path.join(cwd, '.gsd', 'WAITING.json'),
    path.join(planningDir(cwd), 'WAITING.json'),
  ];

  let removed = false;
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); removed = true; } catch { /* intentionally empty */ }
    }
  }

  output({ resumed: true, removed }, raw, removed ? 'true' : 'false');
}

// ─── Gate Functions (STATE.md consistency enforcement) ────────────────────────

/**
 * Update the ## Performance Metrics section in STATE.md content.
 * Increments Velocity totals and upserts a By Phase table row.
 * Returns modified content string.
 */
function updatePerformanceMetricsSection(content: string, cwd: string, phaseNum: string | number, planCount: number, summaryCount: number): string {
  // By Phase table — upsert the row for THIS phase FIRST. The velocity total is then
  // DERIVED from the table's Plans column so it stays idempotent on re-run: completing
  // the same phase again upserts the same row, so the column sum is stable. The previous
  // blind-add (prevTotal + summaryCount) re-read the cumulative total each call and
  // double-counted on every re-run. (#1582)
  const byPhaseMatch = content.match(byPhaseTablePattern);
  if (byPhaseMatch) {
    let tableBody = byPhaseMatch[2].trim();
    // Match the existing row for this phase, tolerating leading-zero padding in either
    // direction (#1659): canonicalize a numeric phase to its integer form so a seeded
    // "| 05 |" row is upserted (not duplicated) by `phase complete 5`, and vice-versa.
    const phaseNumStr = String(phaseNum);
    const canonCell = /^\d+$/.test(phaseNumStr) ? `0*${Number(phaseNumStr)}` : escapeRegex(phaseNumStr);
    const phaseRowPattern = new RegExp(`^\\|\\s*${canonCell}\\s*\\|.*$`, 'm');
    const newRow = `| ${phaseNum} | ${summaryCount} | - | - |`;

    if (phaseRowPattern.test(tableBody)) {
      // Update existing row
      tableBody = tableBody.replace(phaseRowPattern, newRow);
    } else {
      // Remove placeholder row and add new row
      tableBody = tableBody.replace(/^\|\s*-\s*\|\s*-\s*\|\s*-\s*\|\s*-\s*\|$/m, '').trim();
      tableBody = tableBody ? tableBody + '\n' + newRow : newRow;
    }

    content = content.replace(byPhaseTablePattern, (_match, tableHeader: string) => `${tableHeader}${tableBody}\n`);
  }

  // Velocity: Total plans completed — DERIVED as the sum of the By-Phase Plans column
  // (the second cell) across all data rows. Idempotent by construction (re-running phase
  // complete upserts the same row → same sum) and self-healing (a hand-edited inflated
  // total is corrected to the true sum on the next completion). When the By-Phase table
  // is absent, leave the velocity total unchanged rather than guess. (#1582)
  if (/Total plans completed:\s*(\d+|\[N\])/.test(content)) {
    const tableForSum = content.match(byPhaseTablePattern);
    if (tableForSum) {
      let sum = 0;
      for (const row of tableForSum[2].split(/\r?\n/)) {
        // Data rows look like `| <phase> | <plans> | … |`, optionally indented (the
        // byPhaseTablePattern data-row capture allows `[ \t]*` leading whitespace, so the
        // sum must too or hand-edited/legacy indented rows are silently skipped — #1582
        // codex review). Header (`| Phase | Plans | …`) and separator (`| --- | --- | …`)
        // rows have a non-numeric second cell and are skipped; non-numeric cells → 0.
        const cellMatch = row.match(/^\s*\|\s*[^|]+\s*\|\s*(\d+)\s*\|/);
        if (cellMatch) sum += parseInt(cellMatch[1], 10);
      }
      content = content.replace(
        /Total plans completed:\s*(\d+|\[N\])/,
        `Total plans completed: ${sum}`,
      );
    }
  }

  return content;
}

/**
 * Gate 3a: Record state after plan-phase completes.
 * Updates Status to "Ready to execute", Total Plans, Last Activity.
 */
function cmdStatePlannedPhase(cwd: string, phaseNumber: string | number, planCount: number | null | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  // ADR-1769 Phase 4: dispatches to the STATE.md Transition Module. The RMW
  // callback that lived here (body strip/reassemble, template-aware Status +
  // Last Activity, Total Plans in Phase, Last Activity Description, Current
  // Position section update) is the pure `plannedPhaseCore` in
  // src/state-transition.cts, backed by the field-classification table.
  // resync:false is preserved: plan-phase must NOT re-derive milestone-wide
  // progress.* from a half-planned disk snapshot (#500 RC1). readModifyWriteStateMd
  // still owns the lock, the #1230 preservation, and the no-op write guard.
  const intent: StateTransitionIntent = {
    kind: 'plannedPhase',
    phaseNumber,
    planCount: planCount ?? null,
  };
  const deps: StateTransitionDeps = {
    clock: realClock,
    progressProvider: () => null,
  };

  let updated: string[] = [];
  readModifyWriteStateMd(statePath, (content) => {
    const result = transitionCore(content, intent, deps);
    updated = result.updated;
    return result.content;
  }, cwd, { resync: false });

  output({ updated, phase: phaseNumber, plan_count: planCount }, raw, updated.length > 0 ? 'true' : 'false');
}

/**
 * Bug #2630: reset STATE.md for a new milestone cycle.
 * Stomps frontmatter milestone/milestone_name/status/progress AND rewrites
 * the Current Position body. Preserves Accumulated Context.
 * Symmetric with the SDK `stateMilestoneSwitch` handler.
 */
function cmdStateMilestoneSwitch(cwd: string, version: string | undefined, name: string | undefined, raw: boolean): void {
  if (!version || !String(version).trim()) {
    output({ error: 'milestone required (--milestone <vX.Y>)' }, raw, undefined);
    return;
  }
  const resolvedName = (name && String(name).trim()) || 'milestone';
  const statePath = planningPaths(cwd).state;

  // ADR-1769 Phase 4: dispatches to the STATE.md Transition Module. The reset
  // policy (frontmatter rebuild + Current Position body reset) is the pure
  // `milestoneSwitchCore` in src/state-transition.cts. acquireStateLock +
  // platformWriteSync are retained (NOT readModifyWriteStateMd) because
  // milestoneSwitch rebuilds frontmatter directly and must not run the
  // steady-state syncStateFrontmatter post-sync.
  const intent: StateTransitionIntent = { kind: 'milestoneSwitch', version, name: resolvedName };
  const deps: StateTransitionDeps = { clock: realClock, progressProvider: () => null };

  const lockPath = acquireStateLock(statePath);
  try {
    const content = platformReadSync(statePath) || '';
    const result = transitionCore(content, intent, deps);
    platformWriteSync(statePath, result.content);
    output(
      { switched: true, version, name: resolvedName, status: 'planning' },
      raw,
      'true',
    );
  } finally {
    releaseStateLock(lockPath);
  }
}

/**
 * Gate 1: Validate STATE.md against filesystem.
 * Returns { valid, warnings, drift } JSON.
 */
function cmdStateValidate(cwd: string, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  const warnings: string[] = [];
  const drift: Record<string, unknown> = {};

  const status = stateExtractField(content, 'Status') || '';
  const currentPhase = stateExtractField(content, 'Current Phase');
  const totalPlansRaw = stateExtractField(content, 'Total Plans in Phase');
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;

  const phasesDir = planningPaths(cwd).phases;

  // Scan disk for current phase
  if (currentPhase && fs.existsSync(phasesDir)) {
    const normalized = currentPhase.replace(/\s+of\s+\d+.*/, '').trim();
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const phaseDir = entries.find(e => e.isDirectory() && e.name.startsWith(normalized.replace(/^0+/, '').padStart(2, '0')));
      if (phaseDir) {
        const phaseDirPath = path.join(phasesDir, phaseDir.name);
        const { planCount: diskPlans, summaryCount: diskSummaries } = scanPhasePlans(phaseDirPath);

        // Check plan count mismatch
        if (totalPlansInPhase !== null && diskPlans !== totalPlansInPhase) {
          warnings.push(`Plan count mismatch: STATE.md says ${totalPlansInPhase} plans, disk has ${diskPlans}`);
          drift['plan_count'] = { state: totalPlansInPhase, disk: diskPlans };
        }

        // Check for VERIFICATION.md
        const files = fs.readdirSync(phaseDirPath);
        const verificationFiles = files.filter(f => f.includes('VERIFICATION') && f.endsWith('.md'));
        for (const vf of verificationFiles) {
          try {
            const vContent = fs.readFileSync(path.join(phaseDirPath, vf), 'utf-8');
            if (/status:\s*passed/i.test(vContent) && /executing/i.test(status)) {
              warnings.push(`Status drift: STATE.md says "${status}" but ${vf} shows verification passed — phase may be complete`);
              drift['verification_status'] = { state_status: status, verification: 'passed' };
            }
          } catch { /* intentionally empty */ }
        }

        // Check if all plans have summaries but status still says executing
        if (diskPlans > 0 && diskSummaries >= diskPlans && /executing/i.test(status)) {
          // Only warn if no verification exists (if verification passed, the above warning covers it)
          if (verificationFiles.length === 0) {
            warnings.push(`All ${diskPlans} plans have summaries but status is still "${status}" — phase may be ready for verification`);
          }
        }
      }
    } catch { /* intentionally empty */ }
  }

  const valid = warnings.length === 0;
  output({ valid, warnings, drift }, raw, undefined);
}

/**
 * Gate 2: Sync STATE.md from filesystem ground truth.
 * Scans phase dirs, reconstructs counters, progress, metrics.
 * Supports --verify for dry-run mode.
 */
function cmdStateSync(cwd: string, options: StateSyncOptions | undefined, raw: boolean): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const verify = options && options.verify;
  const content = fs.readFileSync(statePath, 'utf-8');
  const changes: string[] = [];
  let modified = content;


  const phasesDir = planningPaths(cwd).phases;
  if (!fs.existsSync(phasesDir)) {
    output({ synced: true, changes: [], dry_run: !!verify }, raw, undefined);
    return;
  }

  // #1514: read the current-milestone ROADMAP scope once so retired/folded
  // phases are excluded from BOTH the disk scan and the heading count here,
  // exactly as buildStateFrontmatter does — otherwise `state sync --verify`
  // would keep re-deriving the inflated denominator and report "no drift".
  let syncRoadmapScope: string | null = null;
  let syncRoadmapRaw: string | null = null;
  let syncRetiredPhaseNums = new Set<string>();
  try {
    const roadmapRaw = platformReadSync(path.join(planningDir(cwd), 'ROADMAP.md'));
    if (roadmapRaw !== null) {
      syncRoadmapRaw = roadmapRaw;
      syncRoadmapScope = extractCurrentMilestone(roadmapRaw, cwd);
      syncRetiredPhaseNums = extractRetiredPhaseNumbers(syncRoadmapScope);
    }
  } catch { /* fall through: no roadmap scope → no retired exclusion */ }

  // Scan all phases
  let entries: string[];
  try {
    entries = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => !(syncRetiredPhaseNums.size > 0 && syncRetiredPhaseNums.has(phaseKeyFromDir(name))))
      .sort();
  } catch {
    output({ synced: true, changes: [], dry_run: !!verify }, raw, undefined);
    return;
  }

  let totalDiskPlans = 0;
  let totalDiskSummaries = 0;
  let diskCompletedPhases = 0;
  let highestIncompletePhase: string | null = null;
  let _highestIncompletePhaseNum: string | null = null;
  let highestIncompletePhaseplanCount = 0;
  let _highestIncompletePhaseSummaryCount = 0;

  for (const dir of entries) {
    const dirPath = path.join(phasesDir, dir);
    const { planCount: plans, summaryCount: summaries, completed } = scanPhasePlans(dirPath);
    totalDiskPlans += plans;
    totalDiskSummaries += summaries;
    if (completed) diskCompletedPhases++;

    // Track the highest phase with incomplete plans (or any plans)
    const phaseMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
    if (phaseMatch && plans > 0) {
      if (summaries < plans) {
        // Incomplete phase — this is likely the current one
        highestIncompletePhase = dir;
        _highestIncompletePhaseNum = phaseMatch[1];
        highestIncompletePhaseplanCount = plans;
        _highestIncompletePhaseSummaryCount = summaries;
      } else if (!highestIncompletePhase) {
        // All complete, track as potential current
        highestIncompletePhase = dir;
        _highestIncompletePhaseNum = phaseMatch[1];
        highestIncompletePhaseplanCount = plans;
        _highestIncompletePhaseSummaryCount = summaries;
      }
    }
  }

  // Determine total phases from ROADMAP (may be larger than realized disk dirs).
  // Mirrors the logic in buildStateFrontmatter so both report consistent percents (#3242 Bug B).
  let syncTotalPhases: number | null = null;
  try {
    let roadmapPhaseCount = 0;
    if (syncRoadmapScope !== null) {
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phaseHeadingPattern = /#{2,4}\s*Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
      let m: RegExpExecArray | null;
      while ((m = phaseHeadingPattern.exec(syncRoadmapScope)) !== null) {
        // Only count tokens that contain at least one digit — excludes
        // pure-word section headings (Overview, Details) while keeping
        // numeric phases (01, 05.1) and project-code IDs (PROJ-42).
        if (!/\d/.test(m[1])) continue;
        // #1514: retired/folded phases are struck through; exclude from total.
        if (syncRetiredPhaseNums.has(phaseKeyFromToken(m[1]))) continue;
        roadmapPhaseCount++;
      }
    }
    if (roadmapPhaseCount > 0) {
      syncTotalPhases = Math.max(entries.length, roadmapPhaseCount);
    } else {
      syncTotalPhases = entries.length;
    }
  } catch { /* intentionally empty */ }

  // ADR-1769 Phase 7: the body writes (Total Plans in Phase, Progress bar, Last
  // Activity) are the pure `syncCore` in src/state-transition.cts.
  // #1761: when a milestone version is set in frontmatter but the ROADMAP has no
  // versioned heading for it, the milestone cannot be bounded to a versioned phase
  // set — leave Progress untouched (percent=null) rather than silently writing
  // fallback-derived wrong values. Projects without a milestone version (the common
  // sync-test shape) are unaffected: the gate only fires when a version is asserted.
  const fmVersion = (extractFrontmatter(content) as Record<string, unknown>).milestone;
  const versionStr = typeof fmVersion === 'string' && fmVersion.trim() ? fmVersion.trim() : null;
  let milestoneBounded = true;
  if (versionStr !== null && syncRoadmapRaw !== null) {
    const versionedHeading = new RegExp(`^#{1,3}\\s+(?!Phase\\s+\\S).*${escapeRegex(versionStr)}`, 'mi');
    milestoneBounded = versionedHeading.test(syncRoadmapRaw);
  }
  let percent: number | null = null;
  if (!milestoneBounded) {
    changes.push(`Progress: skipped — milestone ${versionStr} cannot be bounded to a versioned ROADMAP phase set (#1761)`);
  } else {
    const p = computeProgressPercent(totalDiskSummaries, totalDiskPlans, diskCompletedPhases, syncTotalPhases);
    percent = p !== null ? p : 0;
  }

  const syncResult = transitionCore(
    modified,
    { kind: 'sync', totalPlansInPhase: highestIncompletePhase ? highestIncompletePhaseplanCount : null, percent },
    { clock: realClock, progressProvider: () => null },
  );
  modified = syncResult.content;
  const coreChanges = (syncResult.data as { changes?: string[] } | undefined)?.changes ?? [];
  changes.push(...coreChanges);

  if (verify) {
    output({ synced: false, changes, dry_run: true }, raw, undefined);
    return;
  }

  if (changes.length > 0 || modified !== content) {
    writeStateMd(statePath, modified, cwd);
  }

  output({ synced: true, changes, dry_run: false }, raw, undefined);
}

/**
 * Prune old entries from STATE.md sections that grow unboundedly (#1970).
 * Moves decisions, recently-completed summaries, and resolved blockers
 * older than keepRecent phases to STATE-ARCHIVE.md.
 *
 * Options:
 *   keepRecent: number of recent phases to retain (default: 3)
 *   dryRun: if true, return what would be pruned without modifying STATE.md
 */
function cmdStatePrune(cwd: string, options: StatePruneOptions, raw: boolean): void {
  const silent = !!options.silent;
  const emit = silent ? () => {} : (result: Record<string, unknown>, r: boolean, v?: string) => output(result, r, v);
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { emit({ error: 'STATE.md not found' }, raw); return; }

  const keepRecent = parseInt(String(options.keepRecent), 10) || 3;
  const dryRun = !!options.dryRun;
  // Resolve the current phase via the same canonical chain buildStateFrontmatter
  // uses (frontmatter `current_phase` → `Current Phase` field → prose `Phase: X
  // of Y`), so prune engages on template-conformant STATE.md instead of bailing
  // "Only 0 phases" (#1760).
  // #1776: scope ONLY the prose `Phase:` term to the canonical `## Current
  // Position` section. Over the whole body, `stateExtractField`'s pipe-table
  // fallback matches any `| Phase | N |` row (e.g. a historical verification
  // table), resolving a stale phase and computing a wrong cutoff. Frontmatter and
  // the explicit `Current Phase` field are unambiguous, so they stay document-wide;
  // the shared extractor is not narrowed for any other caller.
  const rawState = fs.readFileSync(statePath, 'utf-8');
  const fm = extractFrontmatter(rawState) as Record<string, unknown>;
  const body = stripFrontmatter(rawState);
  // Mirror buildStateFrontmatter's fmScalar: only string/number/boolean
  // frontmatter scalars are usable (an object/array `current_phase` is ignored,
  // which also avoids a base-to-string on a non-primitive).
  const fmRawPhase = fm.current_phase;
  const fmCurrentPhase =
    typeof fmRawPhase === 'string' ? (fmRawPhase.trim() || null)
      : typeof fmRawPhase === 'number' || typeof fmRawPhase === 'boolean' ? String(fmRawPhase)
        : null;
  const positionSection = sliceCurrentPositionSection(body);
  const prosePhase =
    positionSection !== null ? parseProsePhaseField(stateExtractField(positionSection, 'Phase')).phase : null;
  const currentPhaseRaw = fmCurrentPhase ?? stateExtractField(body, 'Current Phase') ?? prosePhase;
  const currentPhase = parseInt(String(currentPhaseRaw), 10) || 0;
  const cutoff = currentPhase - keepRecent;

  if (cutoff <= 0) {
    emit({ pruned: false, reason: `Only ${currentPhase} phases — nothing to prune with --keep-recent ${keepRecent}` }, raw, 'false');
    return;
  }

  const archivePath = path.join(path.dirname(statePath), 'STATE-ARCHIVE.md');
  const archived: PrunedSection[] = [];

  // ADR-1769 Phase 7: the section-pruning is the pure `pruneCore` in
  // src/state-transition.cts (byte-identical tokenizeHeadings section splicing).
  // This adapter owns currentPhase derivation (#1760 `Phase`/`Current Phase`
  // fallback above), dry-run, and STATE-ARCHIVE.md writes.
  const runPruneCore = (content: string): { newContent: string; archivedSections: PrunedSection[] } => {
    const result = transitionCore(content, { kind: 'prune', cutoff }, { clock: realClock, progressProvider: () => null });
    return {
      newContent: result.content,
      archivedSections: ((result.data as { archivedSections?: PrunedSection[] } | undefined)?.archivedSections) ?? [],
    };
  };

  if (dryRun) {
    // Dry-run: compute what would be pruned without writing anything
    const content = fs.readFileSync(statePath, 'utf-8');
    const result = runPruneCore(content);
    const totalPruned = result.archivedSections.reduce((sum, s) => sum + s.count, 0);
    emit({
      pruned: false,
      dry_run: true,
      cutoff_phase: cutoff,
      keep_recent: keepRecent,
      sections: result.archivedSections.map(s => ({ section: s.section, entries_would_archive: s.count })),
      total_would_archive: totalPruned,
      note: totalPruned > 0 ? 'Run without --dry-run to actually prune' : 'Nothing to prune',
    }, raw, totalPruned > 0 ? 'true' : 'false');
    return;
  }

  readModifyWriteStateMd(statePath, (content) => {
    const result = runPruneCore(content);
    archived.push(...result.archivedSections);
    return result.newContent;
  }, cwd);

  // Write archived entries to STATE-ARCHIVE.md
  if (archived.length > 0) {
    const timestamp = realClock.today();
    let archiveContent = platformReadSync(archivePath);
    if (archiveContent === null) {
      archiveContent = '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
    }
    archiveContent += `## Pruned ${timestamp} (phases 1-${cutoff}, kept recent ${keepRecent})\n\n`;
    for (const section of archived) {
      archiveContent += `### ${section.section}\n\n${section.lines.join('\n')}\n\n`;
    }
    platformWriteSync(archivePath, archiveContent);
  }

  const totalPruned = archived.reduce((sum, s) => sum + s.count, 0);
  emit({
    pruned: totalPruned > 0,
    cutoff_phase: cutoff,
    keep_recent: keepRecent,
    sections: archived.map(s => ({ section: s.section, entries_archived: s.count })),
    total_archived: totalPruned,
    archive_file: totalPruned > 0 ? 'STATE-ARCHIVE.md' : null,
  }, raw, totalPruned > 0 ? 'true' : 'false');
}

/**
 * Rebuild STATE.md body structure from canonical sources (ADR-1817).
 *
 * Implements the `gsd state rebuild` subcommand (issue #1817 Phase 2, #1826).
 * Wires the pure `rebuildCore` transition (Phase 1, #1827) to the CLI:
 *   - Locks via `readModifyWriteStateMd` (real path) or reads-only (dry-run).
 *   - Wires `phaseInventoryProvider` to a real `.planning/phases/` disk scan.
 *   - `--dry-run`: computes the rebuild, emits a structured diff, writes nothing.
 *   - `--verbose`: emits the audit-log entries to stderr (in addition to the
 *     `## Rebuild Log` section that `rebuildCore` already appends to STATE.md).
 *
 * Per ADR-1817 §5 this is the heavy/manual counterpart to the lightweight,
 * auto-triggered `state sync` (3 frontmatter fields). The two compose
 * non-overlappingly.
 */
function cmdStateRebuild(cwd: string, options: StateRebuildOptions, raw: boolean): void {
  const silent = !!options.silent;
  const emit = silent ? () => {} : (result: Record<string, unknown>, r: boolean, v?: string) => output(result, r, v);
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) { emit({ error: 'STATE.md not found' }, raw); return; }

  const dryRun = !!options.dryRun;
  const verbose = !!options.verbose;

  // Wire phaseInventoryProvider to a real `.planning/phases/` disk scan. This
  // is the same canonical source `buildStateFrontmatter` consults; the Leaky-
  // Abstractions guard in `rebuildCore` (ADR-1817 §1) keeps the pure core
  // testable without this dep — here we provide it.
  const phaseInventoryProvider = (): PhaseInventoryRecord[] | null => {
    try {
      const phasesDir = path.join(planningPaths(cwd).planning, 'phases');
      if (!fs.existsSync(phasesDir) || !fs.statSync(phasesDir).isDirectory()) return null;
      const entries = fs.readdirSync(phasesDir);
      const records: PhaseInventoryRecord[] = [];
      for (const entry of entries) {
        const full = path.join(phasesDir, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;
        // Directory-name convention: `<NN>-<slug>` (e.g. `03-test-phase`).
        const m = entry.match(/^(\d+)-(.+)$/);
        if (!m) continue;
        const files = fs.readdirSync(full);
        const planCount = files.filter(f => /-PLAN\.md$/i.test(f)).length;
        const summaryCount = files.filter(f => /-SUMMARY\.md$/i.test(f)).length;
        records.push({ number: m[1], name: m[2], planCount, summaryCount });
      }
      return records;
    } catch {
      return null;
    }
  };

  const deps: StateTransitionDeps = {
    progressProvider: () => null,
    clock: realClock,
    phaseInventoryProvider,
  };

  const runRebuild = (content: string) => transitionCore(content, { kind: 'rebuild' }, deps);

  const emitVerboseLog = (log: unknown): void => {
    if (!verbose || !Array.isArray(log)) return;
    for (const entry of log) {
      // Treat user-data as data-only (ADR-1577 untrusted-input-boundary).
      process.stderr.write(`[rebuild] ${JSON.stringify(entry)}\n`);
    }
  };

  if (dryRun) {
    const content = fs.readFileSync(statePath, 'utf-8');
    const result = runRebuild(content);
    const data = (result.data ?? {}) as { log?: unknown[]; mutated?: boolean };
    emitVerboseLog(data.log);
    const mutated = data.mutated === true;
    emit({
      rebuilt: false,
      dry_run: true,
      mutations: Array.isArray(data.log) ? data.log.length : 0,
      mutated,
      note: mutated ? 'Run without --dry-run to apply changes' : 'Nothing to rebuild',
    }, raw, mutated ? 'true' : 'false');
    return;
  }

  // Real path: lock + RMW via the existing seam. The rebuild log is captured
  // so we can emit it to stderr under --verbose (the section is also written
  // to STATE.md by rebuildCore itself, per ADR-1817 §3).
  let capturedLog: unknown[] = [];
  let capturedMutated = false;
  readModifyWriteStateMd(statePath, (content: string) => {
    const result = runRebuild(content);
    const data = (result.data ?? {}) as { log?: unknown[]; mutated?: boolean };
    capturedLog = Array.isArray(data.log) ? data.log : [];
    capturedMutated = data.mutated === true;
    return result.content;
  }, cwd);

  emitVerboseLog(capturedLog);

  emit({
    rebuilt: capturedMutated,
    mutations: capturedLog.length,
    note: capturedMutated ? 'STATE.md rebuilt; see ## Rebuild Log section for the audit trail' : 'Nothing to rebuild',
  }, raw, capturedMutated ? 'true' : 'false');
}

/**
 * Mark the current phase as COMPLETE in STATE.md.
 * Updates Status, Last Activity, and the Current Position section to reflect
 * that the phase execution is finished and the project is ready for the next phase.
 * Implements the `gsd state complete-phase` subcommand (issue #2735).
 */
function resolvePhaseIdForCompletePhase(content: string, overridePhase: string | undefined): string | null {
  const candidate = overridePhase ||
    stateExtractField(content, 'Current Phase') ||
    stateExtractField(content, 'Phase') ||
    '';

  // #2125: parse via the canonical anchored parser so a narrative `Phase:`
  // body line (e.g. "Milestone v0.5 complete") does not mine a bogus token —
  // the old unanchored regex yielded "0.5" and rewrote STATE.md as
  // "Phase 0.5 complete". A canonical token at the start of the value
  // (3, 03, 3A, 3.3, 10.2, "3 of 5", "1 — Setup") is preserved; a milestone
  // closure line yields null, so the caller's "unable to resolve" guard fires.
  return parsePhaseFromProse(candidate).phase;
}

function cmdStateCompletePhase(cwd: string, raw: boolean, overridePhase?: string): void {
  const statePath = planningPaths(cwd).state;
  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw, undefined);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');
  const resolvedPhase = resolvePhaseIdForCompletePhase(content, overridePhase);
  if (!resolvedPhase || /^phase$/i.test(resolvedPhase)) {
    output({ error: 'Unable to resolve current phase. Pass an explicit phase: state complete-phase --phase <N>' }, raw, undefined);
    return;
  }

  // Idempotency guard (#3489). If STATE.md's canonical `Current Phase` field
  // already names a phase distinct from the one we are being asked to mark
  // complete, the project has advanced past the requested phase (e.g. a
  // follow-up phase was inserted, or the next phase began). Re-running
  // `state complete-phase --phase <N>` in that situation previously rolled
  // STATE.md back to <N>'s moment-of-completion — silently clobbering Status,
  // Last Activity, Last Activity Description, and the Current Position body.
  // The handler is now a no-op in that case so re-invocation from downstream
  // workflows cannot regress the project state.
  const existingCurrentPhaseRaw = stateExtractField(content, 'Current Phase') || '';
  // #2125: same canonical parser as resolvePhaseIdForCompletePhase so the two
  // sites cannot diverge on the token they extract.
  const existingCurrentPhase = parsePhaseFromProse(existingCurrentPhaseRaw).phase;
  if (existingCurrentPhase && existingCurrentPhase !== resolvedPhase) {
    output(
      { updated: [], phase: resolvedPhase, idempotent: true, note: 'phase already superseded; no-op' },
      raw,
      'false',
    );
    return;
  }

  const today = realClock.today();
  const updated: string[] = [];

  readModifyWriteStateMd(statePath, (content) => {
    const currentPhase = resolvedPhase;

    // Bug #1255: operate on body only so the YAML frontmatter `status:` key
    // cannot shadow the body Status field (pipe-table or inline).
    const existingFm = extractFrontmatter(content) as Record<string, unknown>;
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);

    const reassemble = (b: string) =>
      hasFrontmatter ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}` : b;

    // Update Status field (body only — #1255)
    const statusValue = `Phase ${currentPhase} complete`;
    let result = stateReplaceField(body, 'Status', statusValue);
    if (result) { body = result; updated.push('Status'); }

    // Update Last Activity date
    result = stateReplaceField(body, 'Last Activity', today);
    if (result) { body = result; updated.push('Last Activity'); }

    // Update Last Activity Description
    const activityDesc = `Phase ${currentPhase} marked complete`;
    result = stateReplaceField(body, 'Last Activity Description', activityDesc);
    if (result) { body = result; updated.push('Last Activity Description'); }

    // Update ## Current Position section
    // ADR-1372 T6: positionPattern → tokenizeHeadings; stop at level ≥ 2.
    // Mirrors /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i
    {
      const cpHs = tokenizeHeadings(body);
      const cpIdx = cpHs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
      if (cpIdx !== -1) {
        const cpH = cpHs[cpIdx];
        const cpBodyLines = body.split('\n');
        const cpHL = cpBodyLines[cpH.line - 1];
        const cpBodyStart = cpH.offset + cpHL.length + 1;
        let cpBodyEnd = body.length;
        for (let j = cpIdx + 1; j < cpHs.length; j++) {
          if (STOP_H2_PLUS(cpHs[j].level)) { cpBodyEnd = cpHs[j].offset - 1; break; }
        }
        let posBody = body.slice(cpBodyStart, cpBodyEnd);

        // Update Phase line to show COMPLETE
        const newPhase = `Phase: ${currentPhase} — COMPLETE`;
        if (/^Phase:/m.test(posBody)) {
          posBody = posBody.replace(/^Phase:.*$/m, newPhase);
        } else {
          // Pipe-table format in Current Position (#1255)
          // Value cell must be bare (no "Phase:" label prefix) — the column header already provides the label.
          const replaced = stateReplaceField(posBody, 'Phase', `${currentPhase} — COMPLETE`);
          if (replaced !== null) posBody = replaced;
        }

        // Update Status line if present
        const newStatus = `Status: Phase ${currentPhase} complete`;
        if (/^Status:/m.test(posBody)) {
          posBody = posBody.replace(/^Status:.*$/m, newStatus);
        } else {
          // Pipe-table format in Current Position (#1255)
          const replaced = stateReplaceField(posBody, 'Status', `Phase ${currentPhase} complete`);
          if (replaced !== null) posBody = replaced;
        }

        // Update Last activity line if present
        const newActivity = `Last activity: ${today} — Phase ${currentPhase} marked complete`;
        if (/^Last activity:/im.test(posBody)) {
          posBody = posBody.replace(/^Last activity:.*$/im, newActivity);
        } else {
          // Pipe-table format in Current Position (#1255)
          // Value must match the inline branch (date + narrative), not bare date.
          const activityValue = `${today} — Phase ${currentPhase} marked complete`;
          const replaced = stateReplaceField(posBody, 'Last Activity', activityValue)
            ?? stateReplaceField(posBody, 'Last activity', activityValue);
          if (replaced !== null) posBody = replaced;
        }

        body = body.slice(0, cpBodyStart) + posBody + body.slice(cpBodyEnd);
        updated.push('Current Position');
      }
    }

    return reassemble(body);
  }, cwd);

  output(
    { updated, phase: resolvedPhase },
    raw,
    updated.length > 0 ? 'true' : 'false',
  );
}

export = {
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
  acquireStateLock,
  releaseStateLock,
  writeStateMd,
  readModifyWriteStateMd,
  syncStateFrontmatter,
  withStateLock,
  updatePerformanceMetricsSection,
  cmdStateLoad,
  cmdStateGet,
  cmdStatePatch,
  cmdStateUpdate,
  cmdStateAdvancePlan,
  cmdStateRecordMetric,
  cmdStateUpdateProgress,
  cmdStateAddDecision,
  cmdStateAddBlocker,
  cmdStateAddRoadmapEvolution,
  cmdStateResolveBlocker,
  cmdStateRecordSession,
  cmdStateSnapshot,
  cmdStateJson,
  cmdStateBeginPhase,
  cmdStatePlannedPhase,
  cmdStateCompletePhase,
  cmdStateValidate,
  cmdStateSync,
  cmdStatePrune,
  cmdStateRebuild,
  cmdStateMilestoneSwitch,
  cmdSignalWaiting,
  cmdSignalResume,
  // Test seam (#1514): the pure retired/folded-phase parser, exposed so its
  // strikethrough-detection logic can be property-tested directly.
  _extractRetiredPhaseNumbers: extractRetiredPhaseNumbers,
  // Test seam (audit M1): inject a deterministic isPidAlive so the liveness-gated
  // steal decision is exercised without real pids. Mirrors capability-lock.cts.
  _setLockProbes(probes: Partial<{ isPidAlive: (pid: number) => boolean }>): void {
    if (typeof probes.isPidAlive === 'function') _stateLockProbes.isPidAlive = probes.isPidAlive;
  },
  _resetLockProbes(): void {
    _stateLockProbes.isPidAlive = _realIsPidAlive;
  },
  // Test seam (audit M8/M9): inject deterministic hooks for the scan-in-lock window
  // (afterAcquire), the one-shot recoverable writeSync failure (simulateWriteError),
  // and per-iteration orphan-lock snapshots (onLoopIteration). See _stateLockTestHooks.
  _setStateLockTestHooks(hooks: StateLockTestHooks): void {
    if ('afterAcquire' in hooks) _stateLockTestHooks.afterAcquire = hooks.afterAcquire;
    if ('simulateWriteError' in hooks) _stateLockTestHooks.simulateWriteError = hooks.simulateWriteError;
    if ('onLoopIteration' in hooks) _stateLockTestHooks.onLoopIteration = hooks.onLoopIteration;
    if ('beforeSteal' in hooks) _stateLockTestHooks.beforeSteal = hooks.beforeSteal;
  },
  _resetStateLockTestHooks(): void {
    delete _stateLockTestHooks.afterAcquire;
    delete _stateLockTestHooks.simulateWriteError;
    delete _stateLockTestHooks.onLoopIteration;
    delete _stateLockTestHooks.beforeSteal;
  },
};

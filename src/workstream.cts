/**
 * Workstream — CRUD operations for workstream namespacing
 *
 * Workstreams enable parallel milestones by scoping ROADMAP.md, STATE.md,
 * REQUIREMENTS.md, and phases/ into .planning/workstreams/{name}/ directories.
 *
 * When no workstreams/ directory exists, GSD operates in "flat mode" with
 * everything at .planning/ — backward compatible with pre-workstream installs.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParser = require('./roadmap-parser.cjs');
const { getMilestoneInfo } = roadmapParser;
import { platformWriteSync, platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5120: an export= CommonJS module (withStateLock)
import stateMod = require('./state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningRoot, setActiveWorkstream, getActiveWorkstream } = planningWorkspace;
import {
  toWorkstreamSlug,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  isReservedWorkstreamName,
  reservedWorkstreamNameMessage,
  INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
} from './workstream-name-policy.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import workstreamInventory = require('./workstream-inventory.cjs');
const {
  getOtherActiveWorkstreamInventories,
  inspectWorkstream,
  listWorkstreamInventories,
} = workstreamInventory;

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkstreamCreateOptions {
  migrate?: boolean;
  migrateName?: string | null;
}

interface MigrateResult {
  migrated: boolean;
  workstream: string;
  files_moved: string[];
}

const { withStateLock } = stateMod;

/**
 * #5120 (ADR-4629 guard roster; review Major 3): a move of a workstream's files runs inside ONE
 * scope that holds the STATE.md lock on both the source and the destination directory's STATE.md,
 * taken before the first rename and released after the last (rollback renames included). They are
 * taken in one fixed order (by path).
 */
function withBothStateLocks<T>(dirA: string, dirB: string, fn: () => T): T {
  const [first, second] = [path.join(dirA, 'STATE.md'), path.join(dirB, 'STATE.md')].sort();
  return withStateLock(first, () => withStateLock(second, fn));
}

/**
 * The error a failed move reports (pre-push review R4-m3).
 */
function moveFailure(cause: unknown, notReturned: string[], leftIn: string, dirsLeft: string[]): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (notReturned.length === 0 && dirsLeft.length > 0) return new Error(`${message}; left behind: ${dirsLeft.join(', ')}`, { cause });
  if (notReturned.length === 0) return cause instanceof Error ? cause : new Error(message);
  return new Error(`${message}; NOT rolled back: ${notReturned.join(', ')} left in ${leftIn}`, { cause });
}

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate flat .planning/ layout to workstream mode.
 * Moves per-workstream files (ROADMAP.md, STATE.md, REQUIREMENTS.md, phases/)
 * into .planning/workstreams/{name}/. Shared files (PROJECT.md, config.json,
 * milestones/, research/, codebase/, todos/) stay in place.
 */
function migrateToWorkstreams(cwd: string, workstreamName: string): MigrateResult {
  try {
    assertValidActiveWorkstreamName(workstreamName, 'Invalid workstream name for migration');
  } catch {
    throw new Error('Invalid workstream name for migration');
  }
  if (isReservedWorkstreamName(workstreamName)) {
    throw new Error(reservedWorkstreamNameMessage(workstreamName));
  }

  const baseDir = planningRoot(cwd);
  const wsDir = path.join(baseDir, 'workstreams', workstreamName);

  if (fs.existsSync(path.join(baseDir, 'workstreams'))) {
    throw new Error('Already in workstream mode — .planning/workstreams/ exists');
  }

  const toMove: Array<{ name: string; type: string }> = [
    { name: 'ROADMAP.md', type: 'file' },
    { name: 'STATE.md', type: 'file' },
    { name: 'REQUIREMENTS.md', type: 'file' },
    { name: 'phases', type: 'dir' },
  ];

  platformEnsureDir(wsDir);

  const filesMoved: string[] = [];
  const notReturned: string[] = [];
  let failure: unknown = null;
  try {
    withBothStateLocks(baseDir, wsDir, () => {
      try {
        for (const item of toMove) {
          const src = path.join(baseDir, item.name);
          if (fs.existsSync(src)) {
            retryRenameSync(src, path.join(wsDir, item.name));
            filesMoved.push(item.name);
          }
        }
      } catch (err) {
        failure = err;
        for (const name of [...filesMoved].reverse()) {
          try { retryRenameSync(path.join(wsDir, name), path.join(baseDir, name)); } catch { notReturned.push(name); }
        }
      }
    });
  } catch (lockErr) {
    failure = failure ?? lockErr;
  }
  if (failure !== null) {
    try { fs.rmdirSync(wsDir); } catch { /* not empty, or already gone */ }
    try { fs.rmdirSync(path.join(baseDir, 'workstreams')); } catch { /* not empty, or already gone */ }
    // Pre-push review R5-m1: .planning/workstreams is named too, since its presence refuses a retry.
    const dirsLeft = [wsDir, path.join(baseDir, 'workstreams')].filter((d) => fs.existsSync(d)).map((d) => toPosixPath(path.relative(cwd, d)));
    throw moveFailure(failure, notReturned, toPosixPath(path.relative(cwd, wsDir)), dirsLeft);
  }

  return { migrated: true, workstream: workstreamName, files_moved: filesMoved };
}

// ─── CRUD Commands ────────────────────────────────────────────────────────────

function cmdWorkstreamCreate(cwd: string, name: string | null | undefined, options: WorkstreamCreateOptions, raw: boolean): void {
  if (!name) {
    error('workstream name required. Usage: workstream create <name>');
  }

  const slug = toWorkstreamSlug(name);
  if (!slug) {
    error('Invalid workstream name — must contain at least one alphanumeric character');
  }
  if (isReservedWorkstreamName(slug)) {
    error(reservedWorkstreamNameMessage(slug));
  }

  const baseDir = planningRoot(cwd);
  if (!fs.existsSync(baseDir)) {
    error(`.planning/ directory not found — run ${formatGsdSlash('new-project', resolveRuntime(cwd)) as string} first`);
  }

  const wsRoot = path.join(baseDir, 'workstreams');
  const wsDir = path.join(wsRoot, slug);

  if (fs.existsSync(wsDir) && fs.existsSync(path.join(wsDir, 'STATE.md'))) {
    output({ created: false, error: 'already_exists', workstream: slug, path: toPosixPath(path.relative(cwd, wsDir)) }, raw, undefined);
    return;
  }

  const isFlatMode = !fs.existsSync(wsRoot);
  let migration: MigrateResult | null = null;
  if (isFlatMode && options.migrate !== false) {
    const hasExistingWork = fs.existsSync(path.join(baseDir, 'ROADMAP.md')) ||
                            fs.existsSync(path.join(baseDir, 'STATE.md')) ||
                            fs.existsSync(path.join(baseDir, 'phases'));

    if (hasExistingWork) {
      const migrateName = options.migrateName || null;
      let existingWsName: string;
      if (migrateName) {
        const slugged = toWorkstreamSlug(migrateName);
        if (!slugged) {
          output({
            created: false,
            error: 'migration_failed',
            message: 'Invalid migrate-name — must contain at least one alphanumeric character',
          }, raw, undefined);
          return;
        }
        existingWsName = slugged;
      } else {
        try {
          const milestone = getMilestoneInfo(cwd).value;
          existingWsName = generateSlugInternal(milestone?.name ?? null) || 'default';
        } catch {
          existingWsName = 'default';
        }
      }

      try {
        migration = migrateToWorkstreams(cwd, existingWsName);
      } catch (e) {
        output({ created: false, error: 'migration_failed', message: (e as Error).message }, raw, undefined);
        return;
      }
    } else {
      platformEnsureDir(wsRoot);
    }
  }

  platformEnsureDir(wsDir);
  platformEnsureDir(path.join(wsDir, 'phases'));

  const today = realClock.localToday();
  const stateContent = [
    '---',
    `workstream: ${slug}`,
    `created: ${today}`,
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '**Status:** Not started',
    '**Current Phase:** None',
    `**Last Activity:** ${today}`,
    '**Last Activity Description:** Workstream created',
    '',
    '## Progress',
    '**Phases Complete:** 0',
    '**Current Plan:** N/A',
    '',
    '## Session Continuity',
    '**Stopped At:** N/A',
    '**Resume File:** None',
    '',
  ].join('\n');

  // #5120 review Major 1: written under the STATE.md lock, and the existence check is made under
  // it too.
  const statePath = path.join(wsDir, 'STATE.md');
  withStateLock(statePath, () => {
    if (!fs.existsSync(statePath)) platformWriteSync(statePath, stateContent);
  });

  setActiveWorkstream(cwd, slug);

  const relPath = toPosixPath(path.relative(cwd, wsDir));
  output({
    created: true,
    workstream: slug,
    path: relPath,
    state_path: relPath + '/STATE.md',
    phases_path: relPath + '/phases',
    migration: migration || null,
    active: true,
  }, raw, undefined);
}

function cmdWorkstreamList(cwd: string, raw: boolean): void {
  const inventory = listWorkstreamInventories(cwd);
  if (inventory.mode === 'flat') {
    output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
    return;
  }

  const workstreams = inventory.workstreams.map(ws => ({
    name: ws.name,
    path: ws.path,
    has_roadmap: ws.files.roadmap,
    has_state: ws.files.state,
    status: ws.status,
    // #2562: a refused shipped marker must reach the surface. Projecting
    // `status` without it renders the refusal invisible at the CLI, which is
    // the silent-collapse defect this issue is about.
    milestone_shipped_unverified: ws.milestone_shipped_unverified,
    current_phase: ws.current_phase,
    phase_count: ws.phase_count,
    completed_phases: ws.completed_phases,
  }));

  output({ mode: 'workstream', workstreams, count: workstreams.length }, raw, undefined);
}

function cmdWorkstreamStatus(cwd: string, name: string | null | undefined, raw: boolean): void {
  if (!name) error('workstream name required. Usage: workstream status <name>');
  try {
    assertValidActiveWorkstreamName(name, INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  } catch {
    error(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name!);
  if (!fs.existsSync(wsDir)) {
    output({ found: false, workstream: name }, raw, undefined);
    return;
  }

  const inv = inspectWorkstream(cwd, name!);
  if (!inv) {
    output({ found: false, workstream: name }, raw, undefined);
    return;
  }

  output({
    found: true,
    workstream: name,
    path: inv.path,
    files: inv.files,
    phases: inv.phases,
    phase_count: inv.phase_count,
    completed_phases: inv.completed_phases,
    status: inv.status,
    milestone_shipped_unverified: inv.milestone_shipped_unverified,
    current_phase: inv.current_phase,
    last_activity: inv.last_activity,
  }, raw, undefined);
}

function cmdWorkstreamComplete(cwd: string, name: string | null | undefined, options: Record<string, unknown>, raw: boolean): void {
  if (!name) error('workstream name required. Usage: workstream complete <name>');
  try {
    assertValidActiveWorkstreamName(name, INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  } catch {
    error(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
  }

  const root = planningRoot(cwd);
  const wsRoot = path.join(root, 'workstreams');
  const wsDir = path.join(wsRoot, name!);

  if (!fs.existsSync(wsDir)) {
    output({ completed: false, error: 'not_found', workstream: name }, raw, undefined);
    return;
  }

  const active = getActiveWorkstream(cwd);
  if (active === name) setActiveWorkstream(cwd, null as unknown as string);

  const archiveDir = path.join(root, 'milestones');
  const today = realClock.localToday();
  let archivePath = path.join(archiveDir, `ws-${name}-${today}`);
  let suffix = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDir, `ws-${name}-${today}-${suffix++}`);
  }

  platformEnsureDir(archivePath);

  const filesMoved: string[] = [];
  const notReturned: string[] = [];
  let failure: unknown = null;
  try {
    withBothStateLocks(wsDir, archivePath, () => {
      try {
        // Listed after the locks are taken: the one lock file in wsDir is this process's own
        // (#5120 pre-push review M1), and it is removed when the locks are released.
        for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
          if (entry.name === 'STATE.md.lock') continue;
          try {
            retryRenameSync(path.join(wsDir, entry.name), path.join(archivePath, entry.name));
          } catch (err) {
            // A lock another process's steal renamed aside can be removed by that process first.
            if (entry.name.startsWith('STATE.md.lock.') && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
          }
          filesMoved.push(entry.name);
        }
      } catch (err) {
        failure = err;
        for (const fname of [...filesMoved].reverse()) {
          try { retryRenameSync(path.join(archivePath, fname), path.join(wsDir, fname)); } catch { notReturned.push(fname); }
        }
      }
    });
  } catch (lockErr) {
    failure = failure ?? lockErr;
  }
  if (failure !== null) {
    try { fs.rmdirSync(archivePath); } catch { /* not empty, or already gone */ }
    if (active === name) setActiveWorkstream(cwd, name!);
    const err = moveFailure(failure, notReturned, toPosixPath(path.relative(cwd, archivePath)), fs.existsSync(archivePath) ? [toPosixPath(path.relative(cwd, archivePath))] : []);
    output({ completed: false, error: 'archive_failed', message: err.message, workstream: name }, raw, undefined);
    return;
  }

  try { fs.rmdirSync(wsDir); } catch { /* ignore */ }
  // #5120 pre-push review R3-m2: a workstream directory still there after the move is named. It is
  // still counted below.
  const dirLeft = fs.existsSync(wsDir) ? toPosixPath(path.relative(cwd, wsDir)) : null;

  let remainingWs = 0;
  try {
    remainingWs = fs.readdirSync(wsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).length;
    if (remainingWs === 0) fs.rmdirSync(wsRoot);
  } catch { /* ignore */ }

  output({
    completed: true,
    workstream: name,
    archived_to: toPosixPath(path.relative(cwd, archivePath)),
    remaining_workstreams: remainingWs,
    reverted_to_flat: remainingWs === 0,
    ...(dirLeft !== null ? { workstream_dir_left: dirLeft } : {}),
  }, raw, undefined);
}

// ─── Active Workstream Commands ───────────────────────────────────────────────

function cmdWorkstreamSet(cwd: string, name: string | null | undefined, raw: boolean): void {
  if (!name || name === '--clear') {
    if (name !== '--clear') {
      error('Workstream name required. Usage: workstream set <name> (or workstream set --clear to unset)');
    }
    const previous = getActiveWorkstream(cwd);
    setActiveWorkstream(cwd, null as unknown as string);
    output({ active: null, cleared: true, previous: previous || null }, raw, undefined);
    return;
  }

  if (!isValidActiveWorkstreamName(name) || isReservedWorkstreamName(name)) {
    const message = isReservedWorkstreamName(name)
      ? reservedWorkstreamNameMessage(name)
      : 'Workstream name must be alphanumeric, hyphens, underscores, or dots';
    output({ active: null, error: 'invalid_name', message }, raw, undefined);
    return;
  }

  const wsDir = path.join(planningRoot(cwd), 'workstreams', name);
  if (!fs.existsSync(wsDir)) {
    output({ active: null, error: 'not_found', workstream: name }, raw, undefined);
    return;
  }

  setActiveWorkstream(cwd, name);
  output({ active: name, set: true }, raw, name);
}

function cmdWorkstreamGet(cwd: string, raw: boolean): void {
  const active = getActiveWorkstream(cwd);
  const wsRoot = path.join(planningRoot(cwd), 'workstreams');
  output({ active, mode: fs.existsSync(wsRoot) ? 'workstream' : 'flat' }, raw, active || 'none');
}

function cmdWorkstreamProgress(cwd: string, raw: boolean): void {
  const inventory = listWorkstreamInventories(cwd);
  if (inventory.mode === 'flat') {
    output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
    return;
  }

  const workstreams = inventory.workstreams.map(ws => ({
    name: ws.name,
    active: ws.active,
    status: ws.status,
    milestone_shipped_unverified: ws.milestone_shipped_unverified,
    current_phase: ws.current_phase ?? null,
    phases: `${ws.completed_phases}/${ws.roadmap_phase_count}`,
    plans: `${ws.completed_plans}/${ws.total_plans}`,
    progress_percent: ws.progress_percent,
  }));

  output({ mode: 'workstream', active: inventory.active, workstreams, count: workstreams.length }, raw, undefined);
}

// ─── Collision Detection ──────────────────────────────────────────────────────

/**
 * Return other workstreams that are NOT complete.
 * Used to detect whether the milestone has active parallel work
 * when a workstream finishes its last phase.
 */
function getOtherActiveWorkstreams(cwd: string, excludeWs: string): Array<{
  name: string;
  status: string;
  current_phase: string | null;
  phases: string;
}> {
  return getOtherActiveWorkstreamInventories(cwd, excludeWs).map(ws => ({
    name: ws.name,
    status: ws.status,
    current_phase: ws.current_phase ?? null,
    phases: `${ws.completed_phases}/${ws.phase_count}`,
  }));
}

export = {
  migrateToWorkstreams,
  cmdWorkstreamCreate,
  cmdWorkstreamList,
  cmdWorkstreamStatus,
  cmdWorkstreamComplete,
  cmdWorkstreamSet,
  cmdWorkstreamGet,
  cmdWorkstreamProgress,
  getOtherActiveWorkstreams,
};

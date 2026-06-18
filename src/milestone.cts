/**
 * Milestone — Milestone and requirements lifecycle operations.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/milestone.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the same
 * require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformEnsureDir } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, phaseTokenMatches, isBacklogPhaseToken } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter, extractCurrentMilestone } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { extractOneLinerFromBody } = coreUtilsMod;
const { planningPaths } = planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
const { writeStateMd, stateReplaceFieldWithFallback } = stateMod;

interface MilestoneCompleteOptions {
  name?: string;
  force?: boolean;
  archivePhases?: boolean;
}
interface DirectoryInventoryEntry {
  key: string;
}

interface PhaseArchiveOperation {
  source: string;
  target: string;
  mode: 'rename' | 'remove-source-identical';
}

interface PhaseArchivePlan {
  archiveDir: string;
  operations: PhaseArchiveOperation[];
}

function collectDirectoryInventory(dir: string): DirectoryInventoryEntry[] {
  const entries: DirectoryInventoryEntry[] = [];
  function walk(current: string, prefix: string) {
    const full = prefix ? path.join(current, prefix) : current;
    const names = fs.readdirSync(full).sort();
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const itemPath = path.join(current, rel);
      const stat = fs.lstatSync(itemPath);
      if (stat.isDirectory()) {
        entries.push({ key: `${rel}/` });
        walk(current, rel);
      } else if (stat.isFile()) {
        const content = fs.readFileSync(itemPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        entries.push({ key: `${rel}:${stat.size}:${hash}` });
      } else {
        entries.push({ key: `${rel}:${stat.size}:${stat.isSymbolicLink() ? 'symlink' : 'other'}` });
      }
    }
  }
  walk(dir, '');
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

function inventoriesMatch(a: DirectoryInventoryEntry[], b: DirectoryInventoryEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
  }
  return true;
}

function preparePhaseArchivePlan(
  cwd: string,
  version: string,
  phasesDir: string,
  archiveDir: string,
  isDirInMilestone: (dir: string) => boolean,
): PhaseArchivePlan {
  void cwd;
  const phaseArchiveDir = path.join(archiveDir, `${version}-phases`);
  const operations: PhaseArchiveOperation[] = [];
  if (!fs.existsSync(phasesDir)) {
    return { archiveDir: phaseArchiveDir, operations };
  }

  const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
  const candidateDirs = phaseEntries
    .filter((e) => e.isDirectory() && !isBacklogPhaseToken(e.name) && isDirInMilestone(e.name))
    .map((e) => e.name)
    .sort();

  for (const dir of candidateDirs) {
    const source = path.join(phasesDir, dir);
    const target = path.join(phaseArchiveDir, dir);
    if (!fs.existsSync(target)) {
      operations.push({ source, target, mode: 'rename' });
      continue;
    }
    if (!fs.lstatSync(target).isDirectory()) {
      error(
        `Cannot archive phases for ${version}: archive target already exists and differs for ${dir}. ` +
          `Resolve .planning/milestones/${version}-phases/${dir} or remove the stale source directory before retrying.`,
      );
    }
    const sourceInventory = collectDirectoryInventory(source);
    const targetInventory = collectDirectoryInventory(target);
    if (inventoriesMatch(sourceInventory, targetInventory)) {
      operations.push({ source, target, mode: 'remove-source-identical' });
    } else {
      error(
        `Cannot archive phases for ${version}: archive target already exists and differs for ${dir}. ` +
          `Resolve .planning/milestones/${version}-phases/${dir} or remove the stale source directory before retrying.`,
      );
    }
  }

  return { archiveDir: phaseArchiveDir, operations };
}

function executePhaseArchivePlan(plan: PhaseArchivePlan): number {
  if (plan.operations.length === 0) return 0;
  platformEnsureDir(plan.archiveDir);
  for (const op of plan.operations) {
    if (op.mode === 'rename') {
      fs.renameSync(op.source, op.target);
    } else if (op.mode === 'remove-source-identical') {
      fs.rmSync(op.source, { recursive: true, force: true });
    }
  }
  return plan.operations.length;
}

function cmdRequirementsMarkComplete(cwd: string, reqIdsRaw: string[], raw: boolean): void {
  if (!reqIdsRaw || reqIdsRaw.length === 0) {
    error('requirement IDs required. Usage: requirements mark-complete REQ-01,REQ-02 or REQ-01 REQ-02');
  }

  // Accept comma-separated, space-separated, or bracket-wrapped: [REQ-01, REQ-02]
  const reqIds = reqIdsRaw
    .join(' ')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (reqIds.length === 0) {
    error('no valid requirement IDs found');
  }

  const reqPath = planningPaths(cwd).requirements;
  if (!fs.existsSync(reqPath)) {
    output({ updated: false, reason: 'REQUIREMENTS.md not found', ids: reqIds }, raw, 'no requirements file');
    return;
  }

  let reqContent = fs.readFileSync(reqPath, 'utf-8');
  const updated: string[] = [];
  const alreadyComplete: string[] = [];
  const notFound: string[] = [];

  for (const reqId of reqIds) {
    let found = false;
    const reqEscaped = escapeRegex(reqId);

    // Update checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**
    // Use replace() directly and compare — avoids test()+replace() global regex
    // lastIndex bug where test() advances state and replace() misses matches.
    const checkboxPattern = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
    const afterCheckbox = reqContent.replace(checkboxPattern, '$1x$2');
    if (afterCheckbox !== reqContent) {
      reqContent = afterCheckbox;
      found = true;
    }

    // Update traceability table: | REQ-ID | Phase N | Pending | → | REQ-ID | Phase N | Complete |
    const tablePattern = new RegExp(`(\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)`, 'gi');
    const afterTable = reqContent.replace(tablePattern, '$1 Complete $2');
    if (afterTable !== reqContent) {
      reqContent = afterTable;
      found = true;
    }

    if (found) {
      updated.push(reqId);
    } else {
      // Check if already complete before declaring not_found.
      // Non-global flag is fine here — we only need to know if a match exists.
      const doneCheckbox = new RegExp(`-\\s*\\[x\\]\\s*\\*\\*${reqEscaped}\\*\\*`, 'i');
      const doneTable = new RegExp(`\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|\\s*Complete\\s*\\|`, 'i');
      if (doneCheckbox.test(reqContent) || doneTable.test(reqContent)) {
        alreadyComplete.push(reqId);
      } else {
        notFound.push(reqId);
      }
    }
  }

  if (updated.length > 0) {
    platformWriteSync(reqPath, reqContent);
  }

  output(
    {
      updated: updated.length > 0,
      marked_complete: updated,
      already_complete: alreadyComplete,
      not_found: notFound,
      total: reqIds.length,
    },
    raw,
    `${updated.length}/${reqIds.length} requirements marked complete`,
  );
}

function cmdMilestoneComplete(cwd: string, version: string, options: MilestoneCompleteOptions, raw: boolean): void {
  if (!version) {
    error('version required for milestone complete (e.g., v1.0)');
  }
  const milestoneVersion = /^v/i.test(version) ? version.replace(/^v/i, 'v') : `v${version}`;

  const roadmapPath = planningPaths(cwd).roadmap;
  const reqPath = planningPaths(cwd).requirements;
  const statePath = planningPaths(cwd).state;
  const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
  const archiveDir = path.join(cwd, '.planning', 'milestones');
  const phasesDir = planningPaths(cwd).phases;
  const today = new Date().toISOString().split('T')[0];
  const milestoneName = options.name || milestoneVersion;

  // Ensure archive directory exists
  platformEnsureDir(archiveDir);

  // Scope stats and accomplishments to only the phases belonging to the
  // current milestone's ROADMAP.  Uses the shared filter from roadmap-parser.cjs
  // (same logic used by cmdPhasesList and other callers).
  const isDirInMilestone = getMilestonePhaseFilter(cwd, milestoneVersion);
  if (isDirInMilestone.missingExplicitVersion) {
    error(`no phases found for milestone ${milestoneVersion} in ROADMAP.md`);
  }

  // Guard: prevent marking complete when ROADMAP still lists phases that have
  // no directory on disk (disk_status: no_directory). This catches the case
  // where the active milestone was erroneously marked complete before phases
  // were even started. Only fires when STATE.md confirms the current milestone
  // version matches what is being completed — no false positives on fresh
  // projects where phases haven't been scaffolded yet.
  // Pass --force to override this guard.
  if (!options.force) {
    try {
      // Only guard when STATE.md's milestone field matches the version being completed.
      let stateVersion: string | null = null;
      try {
        const stateRaw = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : null;
        if (stateRaw) {
          const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
          if (milestoneMatch) stateVersion = milestoneMatch[1].trim();
        }
      } catch {
        /* skip */
      }

      if (stateVersion) {
        const normalizedStateVersion = /^v/i.test(stateVersion) ? stateVersion.replace(/^v/i, 'v') : `v${stateVersion}`;
        if (normalizedStateVersion === milestoneVersion) {
          const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
          const scopedContent = extractCurrentMilestone(roadmapContent, cwd);
          const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
          const noDirectoryPhases: string[] = [];
          let pm: RegExpExecArray | null;
          const phaseDirEntries = ((): string[] => {
            try {
              return fs
                .readdirSync(phasesDir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
            } catch {
              return [];
            }
          })();
          while ((pm = phasePattern.exec(scopedContent)) !== null) {
            const phaseNum = pm[1];
            if (isBacklogPhaseToken(phaseNum)) continue;
            const normalized = normalizePhaseName(phaseNum);
            const hasDirectory = phaseDirEntries.some((d) => phaseTokenMatches(d, normalized));
            if (!hasDirectory) {
              noDirectoryPhases.push(phaseNum);
            }
          }
          if (noDirectoryPhases.length > 0) {
            error(
              `Cannot mark milestone complete: ROADMAP lists ${noDirectoryPhases.length} unstarted phase(s) ` +
                `(e.g. Phase ${noDirectoryPhases[0]}). Re-run with --force to override.`,
            );
          }
        }
      }
      // If the error came from our guard, re-throw it; otherwise skip silently.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.startsWith('Cannot mark milestone complete:')) throw e;
      // Phase scan failed or STATE version mismatch — allow completion to proceed.
    }
  }

  // Gather stats from phases (scoped to current milestone only)
  let phaseCount = 0;
  let totalPlans = 0;
  let totalTasks = 0;
  const accomplishments: string[] = [];

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dir of dirs) {
      if (isBacklogPhaseToken(dir)) continue;
      if (!isDirInMilestone(dir)) continue;

      phaseCount++;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md');
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
      totalPlans += plans.length;

      // Extract one-liners from summaries
      for (const s of summaries) {
        try {
          const content = fs.readFileSync(path.join(phasesDir, dir, s), 'utf-8');
          const fm = extractFrontmatter(content);
          const rawOneLiner = fm['one-liner'];
          const oneLiner = (typeof rawOneLiner === 'string' ? rawOneLiner : '') || extractOneLinerFromBody(content);
          if (oneLiner) {
            accomplishments.push(oneLiner);
          }
          // Count tasks: prefer **Tasks:** N from Performance section,
          // then <task XML tags, then ## Task N markdown headers
          const tasksFieldMatch = content.match(/\*\*Tasks:\*\*\s*(\d+)/);
          if (tasksFieldMatch) {
            totalTasks += parseInt(tasksFieldMatch[1], 10);
          } else {
            const xmlTaskMatches = content.match(/<task[\s>]/gi) || [];
            const mdTaskMatches = content.match(/##\s*Task\s*\d+/gi) || [];
            totalTasks += xmlTaskMatches.length || mdTaskMatches.length;
          }
        } catch {
          /* intentionally empty */
        }
      }
    }
  } catch {
    /* intentionally empty */
  }

  // Preflight phase archive plan before writing any milestone files so that
  // archive conflicts fail early without duplicating MILESTONES entries.
  let phaseArchivePlan: PhaseArchivePlan | null = null;
  if (options.archivePhases) {
    try {
      phaseArchivePlan = preparePhaseArchivePlan(cwd, milestoneVersion, phasesDir, archiveDir, isDirInMilestone);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('Failed to archive phase directories: ' + message);
    }
  }

  // Archive ROADMAP.md
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    platformWriteSync(path.join(archiveDir, `${milestoneVersion}-ROADMAP.md`), roadmapContent);
  }

  // Archive REQUIREMENTS.md
  if (fs.existsSync(reqPath)) {
    const reqContent = fs.readFileSync(reqPath, 'utf-8');
    const archiveHeader = `# Requirements Archive: ${milestoneVersion} ${milestoneName}\n\n**Archived:** ${today}\n**Status:** SHIPPED\n\nFor current requirements, see \`.planning/REQUIREMENTS.md\`.\n\n---\n\n`;
    platformWriteSync(path.join(archiveDir, `${milestoneVersion}-REQUIREMENTS.md`), archiveHeader + reqContent);
  }

  // Execute phase archive plan after ROADMAP/REQUIREMENTS archives but before
  // audit/MILESTONES/STATE updates.
  let phasesArchived = false;
  if (phaseArchivePlan) {
    try {
      const archiveCount = executePhaseArchivePlan(phaseArchivePlan);
      phasesArchived = archiveCount > 0;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('Failed to archive phase directories: ' + message);
    }
  }

  // Archive audit file if exists
  const auditFile = path.join(cwd, '.planning', `${milestoneVersion}-MILESTONE-AUDIT.md`);
  if (fs.existsSync(auditFile)) {
    fs.renameSync(auditFile, path.join(archiveDir, `${milestoneVersion}-MILESTONE-AUDIT.md`));
  }

  // Create/append MILESTONES.md entry
  const accomplishmentsList = accomplishments.map((a) => `- ${a}`).join('\n');
  const milestoneEntry = `## ${milestoneVersion} ${milestoneName} (Shipped: ${today})\n\n**Phases completed:** ${phaseCount} phases, ${totalPlans} plans, ${totalTasks} tasks\n\n**Key accomplishments:**\n${accomplishmentsList || '- (none recorded)'}\n\n---\n\n`;

  if (fs.existsSync(milestonesPath)) {
    const existing = fs.readFileSync(milestonesPath, 'utf-8');
    if (!existing.trim()) {
      // Empty file — treat like new
      platformWriteSync(milestonesPath, `# Milestones\n\n${milestoneEntry}`);
    } else {
      // Insert after the header line(s) for reverse chronological order (newest first)
      const headerMatch = existing.match(/^(#{1,3}\s+[^\n]*\n\n?)/);
      if (headerMatch) {
        const header = headerMatch[1];
        const rest = existing.slice(header.length);
        platformWriteSync(milestonesPath, header + milestoneEntry + rest);
      } else {
        // No recognizable header — prepend the entry
        platformWriteSync(milestonesPath, milestoneEntry + existing);
      }
    }
  } else {
    platformWriteSync(milestonesPath, `# Milestones\n\n${milestoneEntry}`);
  }

  // Update STATE.md — keep frontmatter/body semantically aligned after closure
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');

    stateContent = stateReplaceFieldWithFallback(stateContent, 'Status', null, `${milestoneVersion} milestone complete`);
    stateContent = stateReplaceFieldWithFallback(stateContent, 'Last Activity', 'Last activity', today);
    stateContent = stateReplaceFieldWithFallback(
      stateContent,
      'Last Activity Description',
      null,
      `${milestoneVersion} milestone completed and archived`,
    );

    // Reset Current Position narrative so resume/progress flows do not keep
    // pointing at closed-phase execution instructions.
    const positionPattern = /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i;
    const closedPositionBody =
      `\nPhase: Milestone ${milestoneVersion} complete\n` +
      `Plan: —\n` +
      `Status: Awaiting next milestone\n` +
      `Last activity: ${today} — Milestone ${milestoneVersion} completed and archived\n\n`;
    if (positionPattern.test(stateContent)) {
      stateContent = stateContent.replace(positionPattern, (_m, header: string) => `${header}${closedPositionBody}`);
    } else {
      stateContent = `${stateContent.trimEnd()}\n\n## Current Position\n${closedPositionBody}`;
    }

    // Normalize operator-next-step tails that can become stale after close.
    const operatorPattern = /(##\s*Operator Next Steps\s*\n)([\s\S]*?)(?=\n##|$)/i;
    if (operatorPattern.test(stateContent)) {
      stateContent = stateContent.replace(
        operatorPattern,
        `$1\n- Start the next milestone with ${formatGsdSlash('new-milestone', resolveRuntime(cwd)) as string}\n\n`,
      );
    } else {
      stateContent = `${stateContent.trimEnd()}\n\n## Operator Next Steps\n\n- Start the next milestone with ${formatGsdSlash('new-milestone', resolveRuntime(cwd)) as string}\n`;
    }

    writeStateMd(statePath, stateContent, cwd);
  }


  const result = {
    version: milestoneVersion,
    name: milestoneName,
    date: today,
    phases: phaseCount,
    plans: totalPlans,
    tasks: totalTasks,
    accomplishments,
    archived: {
      roadmap: fs.existsSync(path.join(archiveDir, `${milestoneVersion}-ROADMAP.md`)),
      requirements: fs.existsSync(path.join(archiveDir, `${milestoneVersion}-REQUIREMENTS.md`)),
      audit: fs.existsSync(path.join(archiveDir, `${milestoneVersion}-MILESTONE-AUDIT.md`)),
      phases: phasesArchived,
    },
    milestones_updated: true,
    state_updated: fs.existsSync(statePath),
  };
  output(result, raw);
}

function cmdPhasesClear(cwd: string, raw: boolean, args: string[]): void {
  const phasesDir = planningPaths(cwd).phases;
  const confirm = Array.isArray(args) && args.includes('--confirm');
  const force = Array.isArray(args) && args.includes('--force');
  let cleared = 0;

  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '--confirm' && arg !== '--force') {
      error('Unknown phases clear option: ' + arg + '. Allowed: --confirm, --force');
    }
  }

  if (force && !confirm) {
    error('--force requires --confirm. Use phases clear --confirm --force to delete intentionally.');
  }

  if (!fs.existsSync(phasesDir)) {
    output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
    return;
  }

  const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !isBacklogPhaseToken(e.name))
    .map((e) => e.name)
    .sort();

  if (dirs.length === 0) {
    output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
    return;
  }

  if (!confirm) {
    error(
      `phases clear would delete ${dirs.length} phase directories. ` +
        `Pass --confirm to proceed.`,
    );
  }

  if (!force) {
    // Archive parity: each active dir must match the latest shipped milestone archive.
    const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
    let version: string | null = null;
    if (fs.existsSync(milestonesPath)) {
      const content = fs.readFileSync(milestonesPath, 'utf-8');
      const match = content.match(/^##\s+(v[\d.]+)\s+(.+?)\s+\(Shipped:/m);
      if (match) version = match[1];
    }
    if (!version) {
      error(
        `phases clear would delete ${dirs.length} phase directories, ` +
          `but .planning/MILESTONES.md has no shipped milestone entry. ` +
          'Run milestone complete <version> --archive-phases first, or pass --confirm --force to delete intentionally.',
      );
    }
    const archiveDir = path.join(cwd, '.planning', 'milestones', `${version}-phases`);
    if (!fs.existsSync(archiveDir)) {
      error(
        `phases clear would delete ${dirs.length} phase directories, ` +
          `but .planning/milestones/${version}-phases/ is missing. ` +
          `Run milestone complete ${version} --archive-phases first, or pass --confirm --force to delete intentionally.`,
      );
    }
    for (const dir of dirs) {
      const source = path.join(phasesDir, dir);
      const target = path.join(archiveDir, dir);
      if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory()) {
        error(
          `phases clear would delete ${dirs.length} phase directories, ` +
            `but archive parity failed for ${dir}. ` +
            `Run milestone complete ${version} --archive-phases first, or pass --confirm --force to delete intentionally.`,
        );
      }
      const sourceInventory = collectDirectoryInventory(source);
      const targetInventory = collectDirectoryInventory(target);
      if (!inventoriesMatch(sourceInventory, targetInventory)) {
        error(
          `phases clear would delete ${dirs.length} phase directories, ` +
            `but archive parity failed for ${dir}. ` +
            `Run milestone complete ${version} --archive-phases first, or pass --confirm --force to delete intentionally.`,
        );
      }
    }
  }

  try {
    for (const dir of dirs) {
      fs.rmSync(path.join(phasesDir, dir), { recursive: true, force: true });
      cleared++;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error('Failed to clear phases directory: ' + message);
  }

  output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
}

export = {
  cmdRequirementsMarkComplete,
  cmdMilestoneComplete,
  cmdPhasesClear,
};

/**
 * Milestone — Milestone and requirements lifecycle operations.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/milestone.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the same
 * require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformEnsureDir, execGit } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, phaseTokenMatches } = phaseIdMod;
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

  const roadmapPath = planningPaths(cwd).roadmap;
  const reqPath = planningPaths(cwd).requirements;
  const statePath = planningPaths(cwd).state;
  const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
  const archiveDir = path.join(cwd, '.planning', 'milestones');
  const phasesDir = planningPaths(cwd).phases;
  const today = new Date().toISOString().split('T')[0];
  const milestoneName = options.name || version;

  // Ensure archive directory exists
  platformEnsureDir(archiveDir);

  // Scope stats and accomplishments to only the phases belonging to the
  // current milestone's ROADMAP.  Uses the shared filter from roadmap-parser.cjs
  // (same logic used by cmdPhasesList and other callers).
  const isDirInMilestone = getMilestonePhaseFilter(cwd, version);
  if (isDirInMilestone.missingExplicitVersion) {
    error(`no phases found for milestone ${version} in ROADMAP.md`);
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

      if (stateVersion && stateVersion === version) {
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
          const normalized = normalizePhaseName(phaseNum);
          // A phase has disk_status: 'no_directory' when no phase directory
          // with a matching token exists on disk. Use the same phaseTokenMatches
          // helper that roadmap.analyze uses to avoid false positives on decimal
          // (2.1) and letter-suffix (12A) phase IDs.
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
    } catch (e) {
      // If the error came from our guard, re-throw it; otherwise skip silently.
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

  // Archive ROADMAP.md
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    platformWriteSync(path.join(archiveDir, `${version}-ROADMAP.md`), roadmapContent);
  }

  // Archive REQUIREMENTS.md
  if (fs.existsSync(reqPath)) {
    const reqContent = fs.readFileSync(reqPath, 'utf-8');
    const archiveHeader = `# Requirements Archive: ${version} ${milestoneName}\n\n**Archived:** ${today}\n**Status:** SHIPPED\n\nFor current requirements, see \`.planning/REQUIREMENTS.md\`.\n\n---\n\n`;
    platformWriteSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`), archiveHeader + reqContent);
  }

  // Archive audit file if exists
  const auditFile = path.join(cwd, '.planning', `${version}-MILESTONE-AUDIT.md`);
  if (fs.existsSync(auditFile)) {
    fs.renameSync(auditFile, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`));
  }

  // Create/append MILESTONES.md entry
  const accomplishmentsList = accomplishments.map((a) => `- ${a}`).join('\n');
  const milestoneEntry = `## ${version} ${milestoneName} (Shipped: ${today})\n\n**Phases completed:** ${phaseCount} phases, ${totalPlans} plans, ${totalTasks} tasks\n\n**Key accomplishments:**\n${accomplishmentsList || '- (none recorded)'}\n\n---\n\n`;

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

    stateContent = stateReplaceFieldWithFallback(stateContent, 'Status', null, `${version} milestone complete`);
    stateContent = stateReplaceFieldWithFallback(stateContent, 'Last Activity', 'Last activity', today);
    stateContent = stateReplaceFieldWithFallback(
      stateContent,
      'Last Activity Description',
      null,
      `${version} milestone completed and archived`,
    );

    // Reset Current Position narrative so resume/progress flows do not keep
    // pointing at closed-phase execution instructions.
    const positionPattern = /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i; // allow-adhoc-markdown: pre-seam section write-modify in milestone.cts; pending collectSection migration #1372
    const closedPositionBody =
      `\nPhase: Milestone ${version} complete\n` +
      `Plan: —\n` +
      `Status: Awaiting next milestone\n` +
      `Last activity: ${today} — Milestone ${version} completed and archived\n\n`;
    if (positionPattern.test(stateContent)) {
      stateContent = stateContent.replace(positionPattern, (_m, header: string) => `${header}${closedPositionBody}`);
    } else {
      stateContent = `${stateContent.trimEnd()}\n\n## Current Position\n${closedPositionBody}`;
    }

    // Normalize operator-next-step tails that can become stale after close.
    const operatorPattern = /(##\s*Operator Next Steps\s*\n)([\s\S]*?)(?=\n##|$)/i; // allow-adhoc-markdown: pre-seam section write-modify in milestone.cts; pending collectSection migration #1372
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

  // Archive phase directories if requested
  let phasesArchived = false;
  if (options.archivePhases) {
    try {
      const phaseArchiveDir = path.join(archiveDir, `${version}-phases`);
      platformEnsureDir(phaseArchiveDir);

      const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const phaseDirNames = phaseEntries.filter((e) => e.isDirectory()).map((e) => e.name);
      let archivedCount = 0;
      for (const dir of phaseDirNames) {
        if (!isDirInMilestone(dir)) continue;
        fs.renameSync(path.join(phasesDir, dir), path.join(phaseArchiveDir, dir));
        archivedCount++;
      }
      phasesArchived = archivedCount > 0;
    } catch {
      /* intentionally empty */
    }
  }

  const result = {
    version,
    name: milestoneName,
    date: today,
    phases: phaseCount,
    plans: totalPlans,
    tasks: totalTasks,
    accomplishments,
    archived: {
      roadmap: fs.existsSync(path.join(archiveDir, `${version}-ROADMAP.md`)),
      requirements: fs.existsSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`)),
      audit: fs.existsSync(path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`)),
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
  // --force bypasses the uncommitted-changes guard. Only use when the caller
  // has already archived or explicitly accepts loss of uncommitted work. (#1447)
  const force = Array.isArray(args) && args.includes('--force');
  let cleared = 0;

  if (fs.existsSync(phasesDir)) {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !/^999(?:\.|$)/.test(e.name));

    if (dirs.length > 0 && !confirm) {
      error(
        `phases clear would delete ${dirs.length} phase director${dirs.length === 1 ? 'y' : 'ies'}. ` +
          `Pass --confirm to proceed.`,
      );
    }

    // Guard (#1447): refuse to hard-delete phase directories that contain
    // uncommitted changes. This prevents data loss when `new-milestone` runs
    // `phases.clear --confirm` before the operator has archived or committed
    // phase work from the outgoing milestone.
    // Use `--force` to bypass this guard only when you have verified that
    // archive or commit of the outgoing phases is already done.
    if (dirs.length > 0 && !force) {
      // Compute the path relative to cwd for git status
      let relPhasesDir: string;
      try {
        relPhasesDir = path.relative(cwd, phasesDir);
      } catch {
        relPhasesDir = phasesDir;
      }

      let gitStatusOutput = '';
      try {
        const gitResult = execGit(['status', '--porcelain', relPhasesDir], { cwd, timeout: 10_000 });
        if (gitResult.exitCode === 0) {
          gitStatusOutput = gitResult.stdout ?? '';
        }
        // If git is not available or this is not a git repo, skip the guard
        // (gitResult.exitCode non-zero → not a git repo → no uncommitted changes to protect).
      } catch {
        // git unavailable — skip guard
      }

      const uncommittedLines = gitStatusOutput
        .split('\n')
        .filter((line) => line.trim().length > 0);
      if (uncommittedLines.length > 0) {
        error(
          `phases clear aborted: ${uncommittedLines.length} uncommitted change${uncommittedLines.length === 1 ? '' : 's'} detected in phase directories. ` +
            `Archive or commit outgoing phase work before running this command, ` +
            `or pass --force to skip this check and permanently delete the phase directories. (#1447)`,
        );
      }
    }

    try {
      for (const entry of dirs) {
        fs.rmSync(path.join(phasesDir, entry.name), { recursive: true, force: true });
        cleared++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('Failed to clear phases directory: ' + message);
    }
  }

  output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
}

export = {
  cmdRequirementsMarkComplete,
  cmdMilestoneComplete,
  cmdPhasesClear,
};

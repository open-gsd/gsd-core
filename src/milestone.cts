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
import { platformWriteSync, platformEnsureDir, execGit, retryRenameSync } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { writeSetComplete } from './write-set.cjs';
import type { WriteSet } from './write-set.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, phaseTokenMatches, PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter, extractCurrentMilestone, getMilestoneInfo } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
const { extractOneLinerFromBody } = coreUtilsMod;
const { planningPaths } = planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
const { writeStateMd } = stateMod;

interface MilestoneCompleteOptions {
  name?: string;
  force?: boolean;
  archivePhases?: boolean;
  dryRun?: boolean;
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
  // #2140: IDs reconciled on the checkbox surface only — a traceability table
  // exists but has no row for the ID. Without this bucket the payload for a
  // partial reconcile is byte-identical to a full one, and audit-milestone (which
  // reads the table) still sees Pending while the CLI reported success.
  const tableUnmatched: string[] = [];

  // A traceability table is present if the file has a "| Requirement | … |"
  // header. A REQUIREMENTS.md with no such table is legitimate (mid-roadmap), so
  // a missing row only counts as drift when a table actually exists.
  const hasTable = /^\|\s*Requirement\s*\|/im.test(reqContent);

  // ADR-2143 §6 per-surface write-set, tracked PER requirement ID: a
  // multi-ID batch must not OR one ID's surface outcome into another's —
  // that is the exact #2140 class one level up (an ID whose traceability
  // row is absent/unmatched must not have its partial write masked by a
  // different ID in the same invocation that fully reconciled). Reported
  // additively as `write_set` below — it does not change the existing
  // marked_complete/already_complete/not_found/table_unmatched/updated
  // computation, which stays byte-for-behaviour identical (#2140's tactical
  // fix already surfaces the checkbox-only-partial-write case via
  // table_unmatched; this only adds the structured ADR-2143 shape on top).
  const writeSet: WriteSet = [];

  for (const reqId of reqIds) {
    const reqEscaped = escapeRegex(reqId);

    // Surface 1 — the checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**
    // Use replace() + compare to avoid the test()+replace() global regex
    // lastIndex bug where test() advances state and replace() misses matches.
    const checkboxPattern = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
    const afterCheckbox = reqContent.replace(checkboxPattern, '$1x$2');
    const checkboxHit = afterCheckbox !== reqContent;
    if (checkboxHit) reqContent = afterCheckbox;

    // Surface 2 — the traceability row: | REQ-ID | Phase N | Pending | → ... Complete |
    const tablePattern = new RegExp(`(\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)`, 'gi');
    const afterTable = reqContent.replace(tablePattern, '$1 Complete $2');
    const tableHit = afterTable !== reqContent;
    if (tableHit) reqContent = afterTable;

    // ADR-2143 §6 per-ID write-set entries: this ID's checkbox surface is
    // always tracked; the traceability surface is tracked only when the file
    // has a traceability table at all (same `hasTable` gate the existing
    // required-surface logic below uses) — omitted entirely, not a false
    // `applied:false`, when no table is required of this file.
    writeSet.push({ requirement: reqId, surface: 'checkbox', applied: checkboxHit });
    if (hasTable) {
      writeSet.push({ requirement: reqId, surface: 'traceability', applied: tableHit });
    }

    // Coverage of the traceability surface for this ID (computed after any flip).
    // hasRow keys on the ID + a second cell (`| ID | <phase> |`) so a bare mention
    // of the ID in a non-traceability table does not masquerade as a real row.
    const hasRow = new RegExp(`\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|`, 'i').test(reqContent);
    const doneCheckbox = new RegExp(`-\\s*\\[x\\]\\s*\\*\\*${reqEscaped}\\*\\*`, 'i').test(reqContent);
    const doneTable = new RegExp(`\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|\\s*Complete\\s*\\|`, 'i').test(reqContent);

    if (checkboxHit || tableHit) {
      updated.push(reqId);
    } else if (doneTable || (doneCheckbox && !hasTable)) {
      // Fully reconciled: the table row is Complete, OR the checkbox is done and
      // there is no table to reconcile against. (A [x] checkbox with a Pending or
      // absent row is NOT fully reconciled when a table exists — #2140.)
      alreadyComplete.push(reqId);
    } else if (!doneCheckbox && !doneTable) {
      notFound.push(reqId);
    }
    // else: doneCheckbox && hasTable && !doneTable — partially reconciled. It is
    // neither updated, already_complete, nor not_found; the table_unmatched bucket
    // below carries the truthful partial-reconcile signal.

    // Surface traceability drift: checkbox reconciled (this run or before) but the
    // table has no row for this ID. This is what makes a partial reconcile
    // distinguishable from a full one (#2140).
    if (hasTable && doneCheckbox && !hasRow) {
      tableUnmatched.push(reqId);
    }
  }

  if (updated.length > 0) {
    platformWriteSync(reqPath, reqContent);
  }

  // ADR-2143 §6: `writeSet` above already carries one WriteOutcome per
  // (requirement, surface) this invocation could have written to — per ID,
  // not ORed across the batch. `write_set` and `write_set_complete` are
  // additive: they do not replace or gate `updated` / `marked_complete` /
  // `already_complete` / `not_found` / `table_unmatched`, which remain
  // computed exactly as before (see #2140 note above — that fix already
  // surfaces a checkbox-only partial write via `table_unmatched`;
  // `write_set_complete` is a structured, ADR-2143-shaped read of the SAME
  // per-surface, per-ID facts, `false` if ANY id's ANY required surface did
  // not apply, since `writeSetComplete` requires EVERY entry to have
  // applied, never an OR across surfaces OR across IDs).
  output(
    {
      updated: updated.length > 0,
      marked_complete: updated,
      already_complete: alreadyComplete,
      not_found: notFound,
      table_unmatched: tableUnmatched,
      total: reqIds.length,
      write_set: writeSet,
      write_set_complete: writeSetComplete(writeSet),
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
  // #1911: derive the archive base from the workstream-aware planning root so
  // `milestone complete --ws` archives into the workstream, not root. planningPaths(cwd).planning
  // resolves to the workstream base when GSD_WORKSTREAM is set and to root .planning otherwise
  // (flat mode is a no-op).
  const planningBase = planningPaths(cwd).planning;
  const milestonesPath = path.join(planningBase, 'MILESTONES.md');
  const archiveDir = path.join(planningBase, 'milestones');
  const phasesDir = planningPaths(cwd).phases;
  const today = realClock.localToday();
  const milestoneName = options.name || version;

  // Ensure archive directory exists (skipped in dry-run — no mutations)
  if (!options.dryRun) {
    platformEnsureDir(archiveDir);
  }

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
        // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
        const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gi');
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
          // Phase 0 (pre-milestone) and Phase 999 (backlog) are sentinels, not
          // real phases — they legitimately have no directory and must not block
          // milestone completion. Mirrors the engine-wide sentinel convention
          // (phase-id getMilestoneFromPhaseId, roadmap-command-router SENTINELS,
          // the #1445 /^999/ progress filters). (#1580)
          const major = parseInt(phaseNum, 10);
          if (major === 0 || major === 999) continue;
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

  // #2118: --dry-run preview — compute what WOULD happen without mutating.
  // The stats above are read-only; all mutations start at the archive section below.
  if (options.dryRun) {
    const phaseDirsToArchive: string[] = [];
    if (options.archivePhases !== false) {
      try {
        const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && isDirInMilestone(e.name)) {
            phaseDirsToArchive.push(e.name);
          }
        }
      } catch { /* phasesDir missing — nothing to archive */ }
    }
    const dryRunResult = {
      dry_run: true,
      version,
      name: milestoneName,
      stats: { phases: phaseCount, plans: totalPlans, tasks: totalTasks },
      accomplishments,
      would_archive: {
        roadmap: fs.existsSync(roadmapPath)
          ? { source: path.relative(cwd, roadmapPath).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-ROADMAP.md`)).split(path.sep).join('/') }
          : null,
        requirements: fs.existsSync(reqPath)
          ? { source: path.relative(cwd, reqPath).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-REQUIREMENTS.md`)).split(path.sep).join('/') }
          : null,
        audit: fs.existsSync(path.join(planningBase, `${version}-MILESTONE-AUDIT.md`))
          ? { source: path.relative(cwd, path.join(planningBase, `${version}-MILESTONE-AUDIT.md`)).split(path.sep).join('/'), target: path.relative(cwd, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`)).split(path.sep).join('/') }
          : null,
        phases: phaseDirsToArchive,
      },
      would_update: {
        milestones_md: path.relative(cwd, milestonesPath).split(path.sep).join('/'),
        state_md: fs.existsSync(statePath) ? path.relative(cwd, statePath).split(path.sep).join('/') : null,
      },
    };
    output(dryRunResult, raw);
    return;
  }

  // Archive ROADMAP.md
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    platformWriteSync(path.join(archiveDir, `${version}-ROADMAP.md`), roadmapContent);
  }

  // Archive REQUIREMENTS.md
  if (fs.existsSync(reqPath)) {
    const reqContent = fs.readFileSync(reqPath, 'utf-8');
    // Derive the display path from the same source the writer uses (reqPath), so a
    // workstream archive header points at `.planning/workstreams/<ws>/REQUIREMENTS.md`
    // instead of the hardcoded root path (#1993). Root case is byte-identical.
    // Normalize to POSIX separators so the header is cross-platform (Windows
    // path.relative yields backslashes; the original literal was forward-slash).
    const reqDisplay = path.relative(cwd, reqPath).split(path.sep).join('/');
    const archiveHeader = `# Requirements Archive: ${version} ${milestoneName}\n\n**Archived:** ${today}\n**Status:** SHIPPED\n\nFor current requirements, see \`${reqDisplay}\`.\n\n---\n\n`;
    platformWriteSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`), archiveHeader + reqContent);
  }

  // Archive audit file if exists
  const auditFile = path.join(planningBase, `${version}-MILESTONE-AUDIT.md`);
  if (fs.existsSync(auditFile)) {
    retryRenameSync(auditFile, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`));
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

  // Update STATE.md — keep frontmatter/body semantically aligned after closure.
  // ADR-1769 Phase 5: dispatches to the STATE.md Transition Module. The closure
  // write (Status, Last Activity, Last Activity Description, Current Position
  // reset, Operator Next Steps reset) is the pure `milestoneCompleteCore` in
  // src/state-transition.cts, backed by the field-classification table. The
  // runtime-specific next-milestone slash command is resolved here and injected
  // via the intent so the core stays pure. writeStateMd still owns the lock and
  // the steady-state syncStateFrontmatter post-sync.
  if (fs.existsSync(statePath)) {
    const result = transitionCore(
      fs.readFileSync(statePath, 'utf-8'),
      {
        kind: 'milestoneComplete',
        version,
        nextMilestoneCommand: formatGsdSlash('new-milestone', resolveRuntime(cwd)) as string,
      },
      { clock: realClock, progressProvider: () => null },
    );
    writeStateMd(statePath, result.content, cwd);
  }

  // Archive phase directories if requested
  let phasesArchived = false;
  // #1871: archive phase dirs by default on milestone complete (opt out via --no-archive-phases).
  if (options.archivePhases !== false) {
    try {
      const phaseArchiveDir = path.join(archiveDir, `${version}-phases`);
      platformEnsureDir(phaseArchiveDir);

      const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const phaseDirNames = phaseEntries.filter((e) => e.isDirectory()).map((e) => e.name);
      let archivedCount = 0;
      for (const dir of phaseDirNames) {
        if (!isDirInMilestone(dir)) continue;
        retryRenameSync(path.join(phasesDir, dir), path.join(phaseArchiveDir, dir));
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
      // #1871: archive phase directories instead of destroying them (shared helper).
      cleared = archivePhaseDirectories(cwd, phasesDir, dirs).archived;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('Failed to clear phases directory: ' + message);
    }
  }

  output({ cleared }, raw, `${cleared} phase director${cleared === 1 ? 'y' : 'ies'} cleared`);
}

/**
 * #1871: move each non-999 phase directory under `phasesDir` into
 * `milestones/<version>-phases/` (collision-safe; version from getMilestoneInfo,
 * timestamp fallback). Shared by `phases clear` (archive-then-remove) and the
 * internal milestone.complete phase archival so phase history survives a
 * milestone switch instead of being hard-deleted.
 */
function archivePhaseDirectories(cwd: string, phasesDir: string, dirs: ReadonlyArray<{ name: string }>): { archiveDir: string; archived: number } {
  let archiveVersion: string | null = null;
  try {
    archiveVersion = getMilestoneInfo(cwd).version ?? null;
  } catch {
    /* ROADMAP/STATE unreadable — fall back to a dated label */
  }
  if (!archiveVersion) {
    archiveVersion = `archived-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8)}`;
  }
  const archivePhasesDir = path.join(planningPaths(cwd).planning, 'milestones', `${archiveVersion}-phases`);
  platformEnsureDir(archivePhasesDir);
  let archived = 0;
  for (const entry of dirs) {
    const src = path.join(phasesDir, entry.name);
    // Collision-safe: if a same-named archive entry exists (re-run), suffix it.
    let dest = path.join(archivePhasesDir, entry.name);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(archivePhasesDir, `${entry.name}.${n++}`);
    }
    retryRenameSync(src, dest);
    archived++;
  }
  return { archiveDir: archivePhasesDir, archived };
}

export = {
  cmdRequirementsMarkComplete,
  cmdMilestoneComplete,
  cmdPhasesClear,
};

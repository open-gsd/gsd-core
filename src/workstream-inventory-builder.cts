/**
 * Workstream Inventory Builder — pure projection from pre-collected
 * filesystem data to typed WorkstreamInventory. No I/O. No async.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/workstream-inventory-builder.cjs collapsed to a TypeScript source
 * of truth. Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 */

import path from 'node:path';

// Internal helpers
function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

export function isCompletedInventory(status: unknown): boolean {
  const s = (typeof status === 'string'
    ? status
    : typeof status === 'number' || typeof status === 'boolean'
      ? String(status)
      : ''
  ).trim().toLowerCase();
  return /\bmilestone\s+complete\b/.test(s) || /\barchived\b/.test(s);
}

export interface PhaseFilesCount {
  directory: string;
  planCount: number;
  summaryCount: number;
}

export interface PhaseStatus {
  directory: string;
  status: 'complete' | 'in_progress' | 'pending';
  plan_count: number;
  summary_count: number;
}

export interface WorkstreamFilesExist {
  roadmap: boolean;
  state: boolean;
  requirements: boolean;
}

export interface StateProjection {
  status: string;
  current_phase: string | null | undefined;
  last_activity: string | null | undefined;
}

export interface BuildWorkstreamInventoryInputs {
  name: string;
  projectDir: string;
  workstreamDir: string;
  phaseDirNames: string[];
  activeWorkstreamName: string;
  phaseFilesCounts: PhaseFilesCount[];
  roadmapPhaseCount: number;
  stateProjection: StateProjection;
  filesExist: WorkstreamFilesExist;
  /**
   * True when an authoritative shipped signal is present for this workstream
   * (an archived milestone snapshot under milestones/, or a SHIPPED marker in
   * the workstream ROADMAP). When true, the inventory status is DERIVED as
   * "milestone complete" regardless of the mutable STATE.md `Status` field,
   * so a stale field can never report a shipped workstream as executing (#1913).
   */
  milestoneShipped: boolean;
}

export interface WorkstreamInventory {
  name: string;
  path: string;
  active: boolean;
  files: WorkstreamFilesExist;
  status: string;
  /** Whether `status` was derived from an authoritative signal ("derived") or taken verbatim from the STATE.md field ("field"). */
  status_source: 'field' | 'derived';
  /** True when the derived status disagrees with the STATE.md `Status` field (the field is stale). */
  status_conflict: boolean;
  current_phase: string | null | undefined;
  last_activity: string | null | undefined;
  phases: PhaseStatus[];
  phase_count: number;
  completed_phases: number;
  roadmap_phase_count: number;
  total_plans: number;
  completed_plans: number;
  progress_percent: number;
}

export function buildWorkstreamInventory(inputs: BuildWorkstreamInventoryInputs): WorkstreamInventory {
  const {
    name,
    projectDir,
    workstreamDir,
    phaseDirNames,
    activeWorkstreamName,
    phaseFilesCounts,
    roadmapPhaseCount,
    stateProjection,
    filesExist,
    milestoneShipped,
  } = inputs;

  // Index counts by directory for O(1) lookup during sort/iteration
  const countsMap = new Map<string, { planCount: number; summaryCount: number }>();
  for (const entry of phaseFilesCounts) {
    countsMap.set(entry.directory, { planCount: entry.planCount, summaryCount: entry.summaryCount });
  }

  const phases: PhaseStatus[] = [];
  let completedPhases = 0;
  let totalPlans = 0;
  let completedPlans = 0;

  for (const dir of [...phaseDirNames].sort()) {
    const counts = countsMap.get(dir) ?? { planCount: 0, summaryCount: 0 };
    const status: 'complete' | 'in_progress' | 'pending' =
      counts.summaryCount >= counts.planCount && counts.planCount > 0
        ? 'complete'
        : counts.planCount > 0
          ? 'in_progress'
          : 'pending';
    totalPlans += counts.planCount;
    completedPlans += Math.min(counts.summaryCount, counts.planCount);
    if (status === 'complete') completedPhases++;
    phases.push({
      directory: dir,
      status,
      plan_count: counts.planCount,
      summary_count: counts.summaryCount,
    });
  }

  // #1913: derive status from authoritative shipped signals rather than trusting
  // the mutable STATE.md `Status` field. When a shipped signal is present, the
  // workstream is "milestone complete" regardless of a stale field value.
  const fieldStatus = stateProjection.status;
  const useDerived = milestoneShipped;
  const status = useDerived ? 'milestone complete' : fieldStatus;
  const status_source: 'field' | 'derived' = useDerived ? 'derived' : 'field';
  const status_conflict = useDerived && !isCompletedInventory(fieldStatus);

  return {
    name,
    path: toPosixPath(path.relative(projectDir, workstreamDir)),
    active: name === activeWorkstreamName,
    files: {
      roadmap: filesExist.roadmap,
      state: filesExist.state,
      requirements: filesExist.requirements,
    },
    status,
    status_source,
    status_conflict,
    current_phase: stateProjection.current_phase,
    last_activity: stateProjection.last_activity,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    roadmap_phase_count: roadmapPhaseCount,
    total_plans: totalPlans,
    completed_plans: completedPlans,
    progress_percent:
      roadmapPhaseCount > 0
        ? Math.min(100, Math.round((completedPhases / roadmapPhaseCount) * 100))
        : 0,
  };
}

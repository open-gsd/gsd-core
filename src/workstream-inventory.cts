/**
 * Workstream Inventory Module
 *
 * Owns discovery and read-only projection of .planning/workstreams/* state.
 * Command handlers should render outputs from this inventory instead of
 * rescanning workstream directories directly.
 *
 * Pure projection logic lives in workstream-inventory-builder.cts.
 * This module handles I/O orchestration only.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream-inventory.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./core.cjs');
const { readSubdirectories } = core;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScan = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningRoot, getActiveWorkstream } = planningWorkspace;
import { stateExtractField } from './state-document.cjs';
import { buildWorkstreamInventory, isCompletedInventory } from './workstream-inventory-builder.cjs';
import type { WorkstreamInventory, StateProjection } from './workstream-inventory-builder.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhaseFileCounts {
  planCount: number;
  summaryCount: number;
}

interface InspectWorkstreamOptions {
  active?: string | null;
}

interface WorkstreamInventoryList {
  mode: 'flat' | 'workstream';
  active: string | null;
  workstreams: WorkstreamInventory[];
  count: number;
  message?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function workstreamsRoot(cwd: string): string {
  return path.join(planningRoot(cwd), 'workstreams');
}

function countRoadmapPhases(roadmapPath: string, fallbackCount: number): number {
  try {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const matches = roadmapContent.match(/^#{2,4}\s+Phase\s+[\w][\w.-]*/gm);
    return matches ? matches.length : fallbackCount;
  } catch {
    return fallbackCount;
  }
}

function countPhaseFiles(phaseDir: string): PhaseFileCounts {
  const scan = planScan(phaseDir);
  return { planCount: scan.planCount, summaryCount: scan.summaryCount };
}

function readStateProjection(statePath: string): StateProjection {
  try {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    return {
      status: stateExtractField(stateContent, 'Status') || 'unknown',
      current_phase: stateExtractField(stateContent, 'Current Phase'),
      last_activity: stateExtractField(stateContent, 'Last Activity'),
    };
  } catch {
    return {
      status: 'unknown',
      current_phase: null,
      last_activity: null,
    };
  }
}

function sortWorkstreamInventories(inventories: WorkstreamInventory[], activeWorkstreamName: string | null): WorkstreamInventory[] {
  return [...inventories].sort((a, b) => {
    const aActive = a.name === activeWorkstreamName ? 1 : 0;
    const bActive = b.name === activeWorkstreamName ? 1 : 0;
    if (aActive !== bActive) {
      return bActive - aActive;
    }
    return a.name.localeCompare(b.name);
  });
}

function inspectWorkstream(cwd: string, name: string, options: InspectWorkstreamOptions = {}): WorkstreamInventory | null {
  const wsDir = path.join(workstreamsRoot(cwd), name);
  if (!fs.existsSync(wsDir)) return null;

  const activeWorkstreamName = options.active === undefined ? getActiveWorkstream(cwd) : options.active;
  const p = planningPaths(cwd, name);
  const phaseDirNames = readSubdirectories(p.phases);

  // Collect per-phase file counts
  const phaseFilesCounts = phaseDirNames.map(dir => {
    const counts = countPhaseFiles(path.join(p.phases, dir));
    return { directory: dir, planCount: counts.planCount, summaryCount: counts.summaryCount };
  });

  return buildWorkstreamInventory({
    name,
    projectDir: cwd,
    workstreamDir: wsDir,
    phaseDirNames,
    activeWorkstreamName: activeWorkstreamName ?? '',
    phaseFilesCounts,
    roadmapPhaseCount: countRoadmapPhases(p.roadmap, phaseDirNames.length),
    stateProjection: readStateProjection(p.state),
    filesExist: {
      roadmap: fs.existsSync(p.roadmap),
      state: fs.existsSync(p.state),
      requirements: fs.existsSync(p.requirements),
    },
  });
}

function listWorkstreamInventories(cwd: string): WorkstreamInventoryList {
  const wsRoot = workstreamsRoot(cwd);
  if (!fs.existsSync(wsRoot)) {
    return {
      mode: 'flat',
      active: null,
      workstreams: [],
      count: 0,
      message: 'No workstreams — operating in flat mode',
    };
  }

  const active = getActiveWorkstream(cwd);
  const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
  const workstreams: WorkstreamInventory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const inventory = inspectWorkstream(cwd, entry.name, { active });
    if (inventory) workstreams.push(inventory);
  }

  const ordered = sortWorkstreamInventories(workstreams, active);

  return {
    mode: 'workstream',
    active,
    workstreams: ordered,
    count: ordered.length,
  };
}

function getOtherActiveWorkstreamInventories(cwd: string, excludeWs: string): WorkstreamInventory[] {
  return listWorkstreamInventories(cwd).workstreams
    .filter(inventory => inventory.name !== excludeWs)
    .filter(inventory => !isCompletedInventory(inventory.status));
}

export = {
  countPhaseFiles,
  countRoadmapPhases,
  getOtherActiveWorkstreamInventories,
  inspectWorkstream,
  isCompletedInventory,
  listWorkstreamInventories,
  sortWorkstreamInventories,
  workstreamsRoot,
};

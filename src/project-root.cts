/**
 * Project-Root Resolution Module — resolves a project root from a starting
 * directory by walking the ancestor chain and applying five heuristics:
 *   (0) own .planning/ guard (#1362)
 *   (1) parent .planning/config.json sub_repos
 *   (2) legacy multiRepo: true + ancestor .git
 *   (3) .git heuristic with parent .planning/
 *   (4) nearest ancestor .planning/ (#1414, Resolution Provenance P1)
 * Bounded by FIND_PROJECT_ROOT_MAX_DEPTH ancestors. Sync I/O.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/project-root.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FIND_PROJECT_ROOT_MAX_DEPTH = 10;

export function findProjectRoot(startDir: string): string {
  let resolvedStart: string;
  try {
    resolvedStart = path.resolve(startDir);
  } catch {
    return startDir;
  }

  const fsRoot = path.parse(resolvedStart).root;
  const home = os.homedir();

  // If startDir already contains .planning/, it IS the project root.
  try {
    const ownPlanningDir = resolvedStart + path.sep + '.planning';
    if (fs.existsSync(ownPlanningDir) && fs.statSync(ownPlanningDir).isDirectory()) {
      return startDir;
    }
  } catch {
    // fall through
  }

  // Walk upward, mirroring isInsideGitRepo from the CJS reference.
  function isInsideGitRepo(candidateParent: string): boolean {
    let d = resolvedStart;
    while (d !== fsRoot) {
      try {
        if (fs.existsSync(d + path.sep + '.git')) return true;
      } catch {
        // ignore
      }
      if (d === candidateParent) break;
      const next = path.dirname(d);
      if (next === d) break;
      d = next;
    }
    return false;
  }

  let dir = resolvedStart;
  let depth = 0;

  while (dir !== fsRoot && depth < FIND_PROJECT_ROOT_MAX_DEPTH) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (parent === home) break;

    const parentPlanning = parent + path.sep + '.planning';
    let parentPlanningIsDir = false;
    try {
      parentPlanningIsDir = fs.existsSync(parentPlanning) && fs.statSync(parentPlanning).isDirectory();
    } catch {
      parentPlanningIsDir = false;
    }

    if (parentPlanningIsDir) {
      const configPath = parentPlanning + path.sep + 'config.json';
      let matched = false;
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config: unknown = JSON.parse(raw);
        if (config && typeof config === 'object') {
          const cfg = config as Record<string, unknown>;
          const subReposValue =
            cfg['sub_repos'] ??
            (cfg['planning'] && typeof cfg['planning'] === 'object'
              ? (cfg['planning'] as Record<string, unknown>)['sub_repos']
              : undefined);
          const subRepos = Array.isArray(subReposValue) ? (subReposValue as unknown[]) : [];
          if (subRepos.length > 0) {
            const relPath = path.relative(parent, resolvedStart);
            const topSegment = relPath.split(path.sep)[0];
            if (subRepos.includes(topSegment)) {
              return parent;
            }
          }
          if (cfg['multiRepo'] === true && isInsideGitRepo(parent)) {
            matched = true;
          }
        }
      } catch {
        // config.json missing or unparseable — fall through to .git heuristic.
      }
      if (matched) return parent;
      // Heuristic: parent has .planning/ and we're inside a git repo.
      if (isInsideGitRepo(parent)) {
        return parent;
      }
    }

    dir = parent;
    depth += 1;
  }

  // Heuristic (4): nearest ancestor .planning/ — last resort before fallback.
  // Runs only after heuristics (1)–(3) have been exhausted without a match,
  // ensuring sub_repos / multiRepo / .git-based resolution always wins when
  // applicable. Walks upward again within the same FIND_PROJECT_ROOT_MAX_DEPTH
  // bound; returns the nearest ancestor directory that contains a .planning/
  // subdirectory so config resolves correctly when invoked from a plain
  // descendant of a single-repo project. (#1414)
  let dir2 = resolvedStart;
  let depth2 = 0;
  while (dir2 !== fsRoot && depth2 < FIND_PROJECT_ROOT_MAX_DEPTH) {
    const parent2 = path.dirname(dir2);
    if (parent2 === dir2) break;
    try {
      const candidatePlanning = parent2 + path.sep + '.planning';
      if (fs.existsSync(candidatePlanning) && fs.statSync(candidatePlanning).isDirectory()) {
        return parent2;
      }
    } catch {
      // ignore fs errors and continue walking
    }
    if (parent2 === home) break;
    dir2 = parent2;
    depth2 += 1;
  }

  return startDir;
}

/**
 * Runtime surface module — ADR-0011 Phase 2 (Option B).
 *
 * Manages the runtime enable/disable surface state (the `.gsd-surface.json` marker in
 * each runtime's config dir root (e.g., ~/.claude)) independently of the install-time profile marker
 * (`.gsd-profile`). Runtime config locations are resolved by callers.
 *
 * Effective skill set = base profile ∪ explicitAdds − disabledClusters − explicitRemoves,
 * then transitively closed via the manifest.
 *
 * Exports:
 *   readSurface(runtimeConfigDir)
 *   writeSurface(runtimeConfigDir, surfaceState)
 *   resolveSurface(runtimeConfigDir, manifest, clusterMap)
 *   applySurface(runtimeConfigDir, layout, manifest, clusterMap)
 *   listSurface(runtimeConfigDir, manifest, clusterMap)
 *   pruneSkillDirs(skillsDir, retainedNames, prefix, manifest)
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/surface.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfiles = require('./install-profiles.cjs');
const {
  readActiveProfile,
  resolveProfile,
  loadSkillsManifest,
} = installProfiles;
import { CLUSTERS } from './clusters.cjs';
import type { ClusterMap } from './clusters.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactLayout = require('./runtime-artifact-layout.cjs');
const { findInstallSourceRoot, getInstallExports } = runtimeArtifactLayout;

const SURFACE_FILE_NAME = '.gsd-surface.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArtifactKind {
  kind: string;
  destSubpath: string;
  prefix: string;
  stage: (resolvedProfile: { name: string; skills: Set<string> | '*'; agents: Set<string> }) => string;
}

interface Layout {
  runtime: string;
  configDir: string;
  scope?: 'local' | 'global';
  kinds: ArtifactKind[];
}

// ---------------------------------------------------------------------------
// State IO
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SurfaceState
 * @property {string} baseProfile
 * @property {string[]} disabledClusters
 * @property {string[]} explicitAdds
 * @property {string[]} explicitRemoves
 */

interface SurfaceState {
  baseProfile: string;
  disabledClusters: string[];
  explicitAdds: string[];
  explicitRemoves: string[];
}

/**
 * Read the surface state from a runtime config directory.
 *
 * @param runtimeConfigDir
 * @returns null if file missing or corrupt
 */
function readSurface(runtimeConfigDir: string): SurfaceState | null {
  const filePath = path.join(runtimeConfigDir, SURFACE_FILE_NAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Structural validation — must have these fields with expected types
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['baseProfile'] !== 'string') return null;
    if (!Array.isArray(p['disabledClusters'])) return null;
    if (!Array.isArray(p['explicitAdds'])) return null;
    if (!Array.isArray(p['explicitRemoves'])) return null;
    return {
      baseProfile: p['baseProfile'],
      disabledClusters: p['disabledClusters'] as string[],
      explicitAdds: p['explicitAdds'] as string[],
      explicitRemoves: p['explicitRemoves'] as string[],
    };
  } catch {
    return null;
  }
}

/**
 * Write the surface state atomically via the platform seam (mkdir + tmp+rename).
 */
function writeSurface(runtimeConfigDir: string, surfaceState: SurfaceState): void {
  platformWriteSync(path.join(runtimeConfigDir, SURFACE_FILE_NAME), JSON.stringify(surfaceState, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Expand cluster names to skill stems using the provided clusterMap.
 */
function clustersToSkills(clusterNames: string[], clusterMap: ClusterMap | Record<string, string[]>): Set<string> {
  const result = new Set<string>();
  for (const name of clusterNames) {
    const members = (clusterMap as Record<string, ReadonlyArray<string> | undefined>)[name];
    if (members) {
      for (const s of members) result.add(s);
    }
  }
  return result;
}

/**
 * Normalize manifest inputs to the skill-dependency Map shape expected by
 * resolveProfile/computeClosure.
 *
 * Supports:
 *  - canonical Map<string, string[]>
 *  - legacy plain object map: { [stem]: string[] }
 *  - parsed gsd-file-manifest.json object ({ files: { ... } }) by rebuilding
 *    the dependency manifest from the install source tree
 */
function normalizeSkillManifest(runtimeConfigDir: string, manifest: Map<string, string[]> | object | null | undefined): Map<string, string[]> {
  if (manifest instanceof Map) {
    return manifest;
  }
  if (!manifest || typeof manifest !== 'object') {
    return new Map();
  }

  // Legacy/ad-hoc object map: stem -> requires[]
  const arrayEntries = Object.entries(manifest as Record<string, unknown>).filter(([, value]) => Array.isArray(value)) as [string, string[]][];
  if (arrayEntries.length > 0) {
    return new Map(arrayEntries.map(([stem, deps]) => [stem, deps]));
  }

  // Parsed gsd-file-manifest.json shape: rebuild the dependency map from source.
  const manifestObj = manifest as Record<string, unknown>;
  if (manifestObj['files'] && typeof manifestObj['files'] === 'object') {
    const srcCommandsDir = findInstallSourceRoot(runtimeConfigDir);
    return loadSkillsManifest(srcCommandsDir);
  }

  return new Map();
}

/**
 * Resolve the effective surface to a typed profile-like object.
 * Shape: { name, skills: Set<string>|'*', agents: Set<string> }
 *
 * Resolution order:
 * 1. Start with base profile resolved via resolveProfile()
 * 2. Remove skills in disabled clusters
 * 3. Add explicitAdds (and their transitive closure)
 * 4. Remove explicitRemoves (only the stem itself, no cascade)
 */
function resolveSurface(runtimeConfigDir: string, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>): { name: string; skills: Set<string>; agents: Set<string> } {
  const cm = clusterMap || CLUSTERS;
  const skillManifest = normalizeSkillManifest(runtimeConfigDir, manifest);
  const surface = readSurface(runtimeConfigDir);

  // Determine base profile name: from surface state or from .gsd-profile marker
  const baseProfileName = (surface && surface.baseProfile)
    ? surface.baseProfile
    : (readActiveProfile(runtimeConfigDir) || 'full');

  // Resolve base profile
  const baseResolved = resolveProfile({
    modes: baseProfileName.split(',').map((s: string) => s.trim()),
    manifest: skillManifest,
  });

  // If full, we need to enumerate all skills from the manifest
  let skills: Set<string>;
  if (baseResolved.skills === '*') {
    // Materialize all skill stems from manifest
    skills = new Set<string>();
    for (const [key] of skillManifest) {
      if (!key.startsWith('_calls_agents_')) skills.add(key);
    }
  } else {
    skills = new Set(baseResolved.skills);
  }

  if (surface) {
    // Step 2: remove disabled cluster members
    const disabledSkills = clustersToSkills(surface.disabledClusters, cm);
    for (const s of disabledSkills) skills.delete(s);

    // Step 3: add explicitAdds with transitive closure
    if (surface.explicitAdds.length > 0) {
      const addSet = new Set(surface.explicitAdds);
      // Compute closure of adds
      const queue = [...addSet];
      const visited = new Set(addSet);
      while (queue.length > 0) {
        const stem = queue.pop()!;
        const deps = skillManifest.get(stem) || [];
        for (const dep of deps) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      for (const s of visited) skills.add(s);
    }

    // Step 4: remove explicitRemoves (stem only, no cascade)
    for (const s of surface.explicitRemoves) {
      skills.delete(s);
    }
  }

  // Derive agents from skills
  const agents = new Set<string>();
  for (const skillStem of skills) {
    const agentRefs = skillManifest.get(`_calls_agents_${skillStem}`) || [];
    for (const agentStem of agentRefs) agents.add(agentStem);
  }

  const name = surface ? `surface:${surface.baseProfile}` : `profile:${baseProfileName}`;
  return { name, skills, agents };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Re-stage the active surface using the resolved layout.
 * Iterates layout.kinds and syncs each artifact kind to its destination.
 */
function applySurface(runtimeConfigDir: string, layout: Layout, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>): { name: string; skills: Set<string>; agents: Set<string> } {
  if (path.resolve(runtimeConfigDir) !== path.resolve(layout.configDir)) {
    throw new TypeError('applySurface runtimeConfigDir must match layout.configDir');
  }
  const skillManifest = normalizeSkillManifest(layout.configDir, manifest);
  const resolved = resolveSurface(layout.configDir, skillManifest, clusterMap);
  // Mirror installRuntimeArtifacts: skills kinds get per-runtime path rewrites
  // so SKILL.md bodies reference the install target (pathPrefix), not the
  // converter's default ~/.claude paths (#813). Computed lazily so command-only
  // runtimes do not trigger the install.js require.
  let pathPrefix: string | null = null;
  for (const kind of layout.kinds) {
    const staged = kind.stage(resolved);
    if (kind.kind === 'skills') {
      const installExports = getInstallExports();
      if (pathPrefix === null) {
        const scope = layout.scope ?? 'global';
        const resolvedTarget = path.resolve(layout.configDir).replace(/\\/g, '/');
        const homeDir = os.homedir().replace(/\\/g, '/');
        pathPrefix = installExports.computePathPrefix({
          isGlobal: scope === 'global',
          isOpencode: layout.runtime === 'opencode',
          isWindowsHost: process.platform === 'win32',
          resolvedTarget,
          homeDir,
        });
      }
      installExports.applyRuntimeContentRewritesInPlace(staged, layout.runtime, pathPrefix);
    }
    const dest = path.join(layout.configDir, kind.destSubpath);
    _syncGsdDir(staged, dest, kind, skillManifest);
  }
  return resolved;
}

/**
 * Prune GSD-managed skill directories from a skills directory.
 *
 * Removes every directory in `skillsDir` that is GSD-owned but NOT listed
 * in `retainedNames`. User-owned dirs (not matching the GSD ownership criteria)
 * are always preserved.
 *
 * Ownership criteria:
 *   - Non-empty prefix (e.g. 'gsd-'): dir name starts with that prefix AND
 *     appears in the manifest (manifest membership is required). Dirs that match
 *     the prefix but are NOT in the manifest are treated as user-owned and
 *     preserved — this prevents data loss for user-created gsd-* directories.
 *     A warning is written to stderr when such a dir is encountered.
 *   - Empty prefix (Hermes): dir name appears as a canonical skill stem in the
 *     manifest. User dirs not in the manifest are preserved.
 *   - Empty prefix without manifest, or manifest not a Map: conservative; no
 *     dirs are removed.
 *
 * This is the single point of truth for skill-dir pruning. Both _syncGsdDir
 * (surface apply) and callers that need stand-alone pruning use this function.
 *
 * @param skillsDir        directory that contains the gsd-STEM sub-dirs
 * @param retainedNames    set of directory names to keep (e.g. 'gsd-help')
 * @param prefix           GSD dir prefix, e.g. 'gsd-' (or '' for Hermes)
 * @param manifest         optional; required for Hermes empty-prefix case
 *                         and for manifest-membership gate in prefixed case.
 *                         Must be a Map; any other type is treated as missing.
 */
function pruneSkillDirs(skillsDir: string, retainedNames: Set<string>, prefix: string, manifest?: Map<string, string[]>): void {
  if (!fs.existsSync(skillsDir)) return;

  // Finding 2: guard against callers passing a truthy non-Map as manifest.
  // A non-Map manifest would throw on .keys(); treat it as absent and be conservative.
  const safeManifest = (manifest instanceof Map) ? manifest : null;

  // Build the canonical stem set from the manifest (used for both prefixed and Hermes paths).
  // Deletion requires manifest membership — without a valid manifest, be conservative.
  const canonicalStems = safeManifest
    ? new Set([...safeManifest.keys()].filter(k => !k.startsWith('_calls_agents_')))
    : null;

  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    let isGsdOwned: boolean;
    if (prefix !== '') {
      if (!entry.startsWith(prefix)) {
        // Does not match prefix at all — user-owned, preserve.
        continue;
      }
      if (!canonicalStems) {
        // No manifest available: cannot confirm ownership — preserve conservatively.
        continue;
      }
      // Finding 1 fix: prefix match is necessary but NOT sufficient.
      // The dir must also be in the manifest to be considered GSD-owned.
      // A user-created gsd-* dir that isn't in the manifest is preserved with a warning.
      if (!canonicalStems.has(entry.slice(prefix.length))) {
        process.stderr.write(
          `[gsd] Warning: ${entry} matches GSD prefix '${prefix}' but is not in the manifest — preserving (user-owned or unknown)\n`
        );
        continue;
      }
      isGsdOwned = true;
    } else if (canonicalStems) {
      // Hermes: GSD-owned iff the directory name appears in the canonical manifest.
      isGsdOwned = canonicalStems.has(entry);
    } else {
      // No manifest available: be conservative, don't remove anything.
      continue;
    }

    if (!isGsdOwned) continue;         // Hermes path only: preserve user-owned dirs not in manifest
    if (retainedNames.has(entry)) continue; // GSD-owned and in retain set
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`surface: failed to prune ${entryPath}: ${(err as Error).message}\n`);
    }
  }
}

/**
 * Sync destination directory from staged source.
 *
 * For 'commands' kind: iterate *.md files in destDir, remove if not in staged set.
 * For 'agents' kind: same, but only remove files starting with 'gsd-' prefix.
 * For 'skills' kind: iterate directories in destDir matching kind.prefix; add missing
 *   by copying recursively; remove dirs not in staged set. Preserves dirs not matching
 *   the prefix (user-owned skills). Pruning is delegated to pruneSkillDirs().
 *
 * For Hermes (empty prefix): uses manifest membership to discriminate GSD-owned vs
 * user-owned dirs. GSD-owned = stem in manifest; removal targets = in manifest AND
 * not in staged set. User-owned (not in manifest) are always preserved.
 */
function _syncGsdDir(stagedDir: string, destDir: string, kind: ArtifactKind | string, manifest?: Map<string, string[]>): void {
  if (!fs.existsSync(stagedDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  // Normalize: allow legacy string context for backward-compat with internal callers
  const kindName = (typeof kind === 'string') ? kind : kind.kind;
  const kindPrefix = (typeof kind === 'object' && kind !== null) ? kind.prefix : 'gsd-';

  if (kindName === 'skills') {
    // Skills kind: work with directories, not files.
    // Each staged entry is a directory named ${prefix}${stem}.
    const stagedDirs = new Set<string>(
      fs.readdirSync(stagedDir).filter(entry => {
        return fs.statSync(path.join(stagedDir, entry)).isDirectory();
      })
    );

    // Copy missing dirs from staged to dest (always overwrite to ensure content is current)
    for (const dirName of stagedDirs) {
      const destSubDir = path.join(destDir, dirName);
      fs.cpSync(path.join(stagedDir, dirName), destSubDir, { recursive: true });
    }

    // Prune GSD-owned dirs that are no longer in the staged set.
    // pruneSkillDirs() is the single point of truth for this logic.
    pruneSkillDirs(destDir, stagedDirs, kindPrefix, manifest);
  } else {
    // commands / agents kind: mirror installRuntimeArtifacts (_copyStaged /
    // _removeGsdEntries in bin/install.js) so surface produces the SAME files as a
    // fresh install (#816). Flat command dirs (opencode/cursor/augment/kilo) take
    // the gsd- prefix on copy; namespaced command dirs (commands/gsd) and agents
    // keep their staged names. Copying staged names verbatim previously diverged
    // from install and orphaned the installed gsd-*.md files, and the unscoped
    // prune deleted user-owned command files.
    //
    // NOTE: the destName rule below intentionally mirrors bin/install.js
    // `_copyStaged` (the `namespacedByDir` decision). Keep them in sync.
    const destLast = (typeof kind === 'object' && kind !== null && kind.destSubpath)
      ? path.basename(kind.destSubpath)
      : '';
    const prefixStem = kindPrefix ? kindPrefix.replace(/-$/, '') : '';
    const namespacedByDir = kindName === 'commands' && destLast === prefixStem;

    const stagedFiles = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    const stagedDestNames = new Set<string>();
    for (const file of stagedFiles) {
      const destName = (kindName === 'agents' || namespacedByDir)
        ? file
        : `${kindPrefix}${file.slice(0, -3)}.md`;
      fs.copyFileSync(path.join(stagedDir, file), path.join(destDir, destName));
      stagedDestNames.add(destName);
    }

    // Prune stale GSD-owned files not in the staged set, preserving user-owned files
    // (mirrors install's prefix-scoped _removeGsdEntries):
    //   - agents: only gsd-* are GSD-owned
    //   - flat command dirs: only `${kindPrefix}`-prefixed are GSD-owned
    //   - namespaced command dirs: the whole dir is GSD-owned
    for (const file of fs.readdirSync(destDir).filter(f => f.endsWith('.md'))) {
      if (kindName === 'agents' && !file.startsWith('gsd-')) continue;
      if (kindName === 'commands' && !namespacedByDir && kindPrefix && !file.startsWith(kindPrefix)) continue;
      if (!stagedDestNames.has(file)) {
        try { fs.unlinkSync(path.join(destDir, file)); } catch { /* ignore */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List the currently enabled and disabled skills with token cost.
 *
 * Token cost = sum of description lengths ÷ 4 (mirrors audit script).
 * Descriptions are read from the install source (findInstallSourceRoot).
 */
function listSurface(runtimeConfigDir: string, manifest: Map<string, string[]> | object, clusterMap?: ClusterMap | Record<string, string[]>): { enabled: string[]; disabled: string[]; tokenCost: number } {
  const skillManifest = normalizeSkillManifest(runtimeConfigDir, manifest);
  const resolved = resolveSurface(runtimeConfigDir, skillManifest, clusterMap);

  // All known stems from manifest (exclude _calls_agents_ meta keys)
  const allStems: string[] = [];
  for (const [key] of skillManifest) {
    if (!key.startsWith('_calls_agents_')) allStems.push(key);
  }

  const enabledSet = resolved.skills instanceof Set ? resolved.skills : new Set(allStems);

  const enabled = allStems.filter(s => enabledSet.has(s)).sort();
  const disabled = allStems.filter(s => !enabledSet.has(s)).sort();

  // Compute token cost by reading descriptions from the install source
  const srcCommandsDir = findInstallSourceRoot(runtimeConfigDir);
  let tokenCost = 0;
  for (const stem of enabled) {
    const filePath = path.join(srcCommandsDir, `${stem}.md`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        tokenCost += Math.ceil(descMatch[1].trim().length / 4);
      }
    } catch { /* ignore */ }
  }

  return { enabled, disabled, tokenCost };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  readSurface,
  writeSurface,
  resolveSurface,
  applySurface,
  listSurface,
  // Exported for testing and for callers that need stand-alone pruning
  pruneSkillDirs,
  _syncGsdDir,
};

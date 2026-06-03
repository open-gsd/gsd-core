/**
 * Skill Surface Budget Module — single source of truth for which skills/agents
 * are written to the runtime config dirs (ADR-0011).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/install-profiles.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { platformWriteSync } from './shell-command-projection.cjs';

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

/**
 * PROFILES maps profile name → base skill set (array) or '*' sentinel (full).
 *
 * The effective set for any profile is CLOSURE(base, requires: manifest).
 * standard is a superset of core; full is the identity (all skills).
 *
 * Composition: --profile=core,audit resolves to union(closure(core), closure(audit)).
 */
const PROFILES = Object.freeze({
  core: Object.freeze([
    'new-project',
    'discuss-phase',
    'plan-phase',
    'execute-phase',
    'phase',
    'help',
    'update',
    'surface',
  ]),
  standard: Object.freeze([
    // Core loop
    'new-project',
    'discuss-phase',
    'plan-phase',
    'execute-phase',
    'help',
    'update',
    'surface',
    // Phase management (hot nodes from audit — required by 38+ skills)
    'phase',
    'review',
    'config',
    'progress',
    // Workspace / state
    'resume-work',
    'pause-work',
    'workspace',
  ]),
  full: '*' as const,
} as const);

type ProfileName = keyof typeof PROFILES;

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/**
 * Parse the requires: field from YAML frontmatter.
 * Handles: "requires: [a, b, c]" (flow style) and absent field.
 * Returns string[] — empty array if no requires: field.
 *
 * No external YAML parser dependency — hand-parse the single line
 * since GSD enforces flow-style arrays for requires:.
 */
function parseRequires(content: string): string[] {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const line = fm.match(/^requires:\s*(.+)$/m);
  if (!line) return [];
  const val = line[1].trim();
  // Flow-style: [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  }
  // Single bare value (not currently used, but defensive)
  return val ? [val] : [];
}

/**
 * Parse agent references from a skill file's body text.
 * Scans the full content for `gsd-<stem>` patterns that correspond to
 * real agent files. Returns all unique `gsd-*` stems found in the body.
 *
 * The caller is responsible for filtering by which agents actually exist —
 * this function returns all syntactically valid `gsd-*` matches.
 */
function parseCallsAgents(content: string): string[] {
  // Match word-boundary gsd-<stem> patterns; stems are lowercase letters and hyphens.
  // We use a regex that matches `gsd-` followed by one or more lowercase-alpha-or-hyphen chars.
  // This catches `gsd-planner`, `gsd-plan-checker`, etc. in prose and code.
  const matches = content.match(/\bgsd-[a-z][a-z-]*/g);
  if (!matches) return [];
  // Deduplicate
  return [...new Set(matches)];
}

/**
 * Load the requires: dependency graph from a commands/gsd directory.
 * Also derives calls_agents for each skill by scanning the body text for
 * `gsd-*` agent name references. Agent stems are stored under the special
 * key `_calls_agents_<stem>` so they don't conflict with skill stems.
 */
function loadSkillsManifest(commandsDir: string): Map<string, string[]> {
  const manifest = new Map<string, string[]>();
  if (!fs.existsSync(commandsDir)) return manifest;
  const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    try {
      const content = fs.readFileSync(path.join(commandsDir, entry.name), 'utf8');
      manifest.set(stem, parseRequires(content));
      // Derive agent references from body text
      const agentRefs = parseCallsAgents(content);
      manifest.set(`_calls_agents_${stem}`, agentRefs);
    } catch {
      manifest.set(stem, []);
      manifest.set(`_calls_agents_${stem}`, []);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Profile resolution (transitive closure)
// ---------------------------------------------------------------------------

/**
 * Compute the transitive closure of a set of skill stems over the manifest.
 */
function computeClosure(base: Iterable<string>, manifest: Map<string, string[]>): Set<string> {
  const closed = new Set(base);
  const queue = [...closed];
  while (queue.length > 0) {
    const stem = queue.pop()!;
    const deps = manifest.get(stem) || [];
    for (const dep of deps) {
      if (!closed.has(dep)) {
        closed.add(dep);
        queue.push(dep);
      }
    }
  }
  return closed;
}

interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

interface ResolveProfileOpts {
  modes?: string[];
  manifest?: Map<string, string[]>;
  _profilesOverride?: Record<string, string | readonly string[]>;
}

/**
 * Resolve a profile (or composed profiles) to a typed result object.
 */
function resolveProfile({ modes, manifest, _profilesOverride }: ResolveProfileOpts = {}): ResolvedProfile {
  const profiles: Record<string, string | readonly string[]> = _profilesOverride || PROFILES;
  const activeModes = (modes && modes.length > 0) ? modes : ['full'];
  const normalizedModes = activeModes
    .flatMap((mode) => String(mode).split(','))
    .map((mode) => mode.trim())
    .filter(Boolean);
  const modesToResolve = normalizedModes.length > 0 ? normalizedModes : ['full'];

  // If any mode is 'full', the result is the full sentinel
  if (modesToResolve.includes('full')) {
    return { name: 'full', skills: '*', agents: new Set() };
  }

  const validModes = modesToResolve.filter((mode) => Object.prototype.hasOwnProperty.call(profiles, mode));
  if (validModes.length === 0) {
    // Invalid/corrupt marker fallback: avoid empty installs by defaulting to full.
    return { name: 'full', skills: '*', agents: new Set() };
  }

  const man = manifest || new Map<string, string[]>();
  const unionSkills = new Set<string>();

  for (const mode of validModes) {
    const base = profiles[mode];
    if (base === '*') {
      // This profile is full — sentinel short-circuit
      return { name: 'full', skills: '*', agents: new Set() };
    }
    const closure = computeClosure(base as Iterable<string>, man);
    for (const s of closure) unionSkills.add(s);
  }

  // Derive agents: union of all agent names referenced in the body text of
  // every skill in unionSkills. Agent names are stored in the manifest under
  // _calls_agents_<stem> keys (populated by loadSkillsManifest).
  const unionAgents = new Set<string>();
  for (const skillStem of unionSkills) {
    const agentRefs = man.get(`_calls_agents_${skillStem}`) || [];
    for (const agentStem of agentRefs) {
      unionAgents.add(agentStem);
    }
  }

  const name = validModes.length === 1 ? validModes[0] : validModes.join(',');
  return { name, skills: unionSkills, agents: unionAgents };
}

// ---------------------------------------------------------------------------
// Staging — skills
// ---------------------------------------------------------------------------

// Stage dirs created during this process — cleaned up on exit.
// 13 runtime dispatch sites in install.js can each call stageSkillsForMode,
// so accumulating them in a single set avoids leaks without forcing each
// site to track its own cleanup handle.
const STAGED_DIRS = new Set<string>();
let exitHandlerRegistered = false;

function cleanupStagedSkills(): void {
  for (const dir of STAGED_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: missing dir or permission error shouldn't crash a
      // successful install. The OS reaps tmpdir eventually.
    }
  }
  STAGED_DIRS.clear();
}

// Signals we register a cleanup handler for in addition to the natural
// 'exit' event. `process.on('exit')` does NOT fire on these — an installer
// is exactly the kind of process users abort mid-run, so without explicit
// signal handling Ctrl+C would leave staged tmp dirs behind.
const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function ensureExitCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on('exit', cleanupStagedSkills);
  for (const sig of CLEANUP_SIGNALS) {
    // `once` so re-raising the signal below isn't intercepted by us a second
    // time — the OS-default handler should take over and exit with the right
    // status code (so CI sees the abort, scripts see 130 for SIGINT, etc.).
    process.once(sig, () => {
      cleanupStagedSkills();
      process.kill(process.pid, sig);
    });
  }
}

/**
 * Stage a filtered copy of commands/gsd for a resolved profile.
 * In full mode (skills === '*') returns srcDir unchanged (no-op).
 */
function stageSkillsForProfile(srcDir: string, resolvedProfile: ResolvedProfile): string {
  if (resolvedProfile.skills === '*') return srcDir;
  if (!fs.existsSync(srcDir)) return srcDir;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-profile-skills-'));
  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (!(resolvedProfile.skills).has(stem)) continue;
      fs.copyFileSync(
        path.join(srcDir, entry.name),
        path.join(stageDir, entry.name),
      );
    }
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  STAGED_DIRS.add(stageDir);
  ensureExitCleanup();
  return stageDir;
}

/**
 * Stage a filtered copy of the agents directory for a resolved profile.
 * For 'full', returns srcAgentsDir unchanged.
 * For tiered profiles, copies only agents whose full stem (e.g. 'gsd-planner')
 * is in resolvedProfile.agents — which is populated by resolveProfile() from
 * the _calls_agents_* entries in the manifest.
 */
function stageAgentsForProfile(srcAgentsDir: string, resolvedProfile: ResolvedProfile): string {
  if (resolvedProfile.skills === '*') return srcAgentsDir;
  if (!fs.existsSync(srcAgentsDir)) return srcAgentsDir;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-profile-agents-'));
  try {
    if (resolvedProfile.agents instanceof Set && resolvedProfile.agents.size > 0) {
      const entries = fs.readdirSync(srcAgentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.md')) continue;
        // Agent stem is the full filename without extension, e.g. "gsd-planner"
        const stem = entry.name.slice(0, -3);
        if (!resolvedProfile.agents.has(stem)) continue;
        fs.copyFileSync(
          path.join(srcAgentsDir, entry.name),
          path.join(stageDir, entry.name),
        );
      }
    }
    // If agents is empty Set, we produce an empty stageDir (no agents for this profile)
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  STAGED_DIRS.add(stageDir);
  ensureExitCleanup();
  return stageDir;
}

function stageSkillsForRuntimeAsSkills(
  srcCommandsDir: string,
  resolvedProfile: ResolvedProfile,
  converter: (content: string, skillName: string) => string,
  prefix: string,
): string {
  if (!fs.existsSync(srcCommandsDir)) return srcCommandsDir;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-profile-runtime-skills-'));
  try {
    const entries = fs.readdirSync(srcCommandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (resolvedProfile.skills !== '*' && !(resolvedProfile.skills).has(stem)) continue;
      const content = fs.readFileSync(path.join(srcCommandsDir, entry.name), 'utf8');
      const skillName = `${prefix}${stem}`;
      const converted = converter(content, skillName);
      const destDir = path.join(stageDir, skillName);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'SKILL.md'), converted);
    }
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  STAGED_DIRS.add(stageDir);
  ensureExitCleanup();
  return stageDir;
}

// ---------------------------------------------------------------------------
// Profile marker persistence
// ---------------------------------------------------------------------------

const PROFILE_MARKER_NAME = '.gsd-profile';

/**
 * Read the active profile from a runtime config directory.
 */
function readActiveProfile(runtimeConfigDir: string): string | null {
  const markerPath = path.join(runtimeConfigDir, PROFILE_MARKER_NAME);
  try {
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    if (!raw) return null;
    // Validate that it looks like a profile name (alphanumeric + hyphens + commas)
    if (!/^[a-z0-9,_-]+$/i.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist the active profile to a runtime config directory.
 */
function writeActiveProfile(runtimeConfigDir: string, profileName: string): void {
  platformWriteSync(path.join(runtimeConfigDir, PROFILE_MARKER_NAME), profileName + '\n');
}

// ---------------------------------------------------------------------------
// Profile resolution helpers for install / update flows
// ---------------------------------------------------------------------------

/**
 * Rank ordering for profiles (lower index = more restrictive / smaller skill set).
 * Unknown profiles default to the permissive end (treated as 'full').
 */
const PROFILE_RANK = Object.freeze(['core', 'standard', 'full'] as const);

/**
 * Given an array of profile names (one per runtime), return the most-restrictive
 * profile — i.e. the one with the smallest effective skill set.
 *
 * Ordering (most to least restrictive): core < standard < full.
 * Composed profiles (e.g. 'core,audit') and unknown profiles are treated as
 * 'full' for this comparison.
 */
function mostRestrictiveProfile(profileNames: string[]): string {
  if (!profileNames || profileNames.length === 0) return 'full';
  // Initialize with the least-restrictive rank (one past the end of PROFILE_RANK)
  let bestRank: number = PROFILE_RANK.length;
  let bestName = 'full';
  for (const name of profileNames) {
    const rank = PROFILE_RANK.indexOf(name as ProfileName);
    // Unknown/composed profiles are treated as the permissive 'full' rank.
    const effectiveRank = rank === -1 ? PROFILE_RANK.indexOf('full') : rank;
    if (effectiveRank < bestRank) {
      bestRank = effectiveRank;
      bestName = rank === -1 ? 'full' : name;
    }
  }
  return bestName;
}

interface ResolveEffectiveProfileOpts {
  requestedProfileName: string | null;
  targetDir: string;
}

/**
 * Resolve the effective profile name for an install() run.
 *
 * Priority:
 *   1. Explicit flag (requestedProfileName != null) → use it as-is.
 *   2. Marker exists in targetDir and is not 'full' → use marker.
 *   3. Else → 'full' (back-compat for fresh non-interactive installs).
 */
function resolveEffectiveProfile({ requestedProfileName, targetDir }: ResolveEffectiveProfileOpts): string {
  // 1. Explicit flag overrides everything
  if (requestedProfileName != null) return requestedProfileName;
  // 2. Marker-driven (gsd update path)
  const marker = readActiveProfile(targetDir);
  if (marker && marker !== 'full') return marker;
  // 3. Default
  return 'full';
}

// ---------------------------------------------------------------------------
// Back-compat shims (deprecated — use profile-based API instead)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use PROFILES.core instead.
 * Preserved for callers in install.js and existing tests.
 */
const MINIMAL_SKILL_ALLOWLIST = Object.freeze([...PROFILES.core]);

const MINIMAL_ALLOWLIST_SET = new Set(MINIMAL_SKILL_ALLOWLIST);

/**
 * @deprecated Use resolveProfile({ modes: ['core'] }) instead.
 */
function isMinimalMode(mode: string): boolean {
  return mode === 'minimal' || mode === 'core-only';
}

/**
 * Overloaded for back-compat.
 * - If resolvedProfileOrMode is a string: legacy mode check (full/minimal)
 * - If resolvedProfileOrMode is an object with .skills: new profile API
 *
 * @deprecated String-mode form; use resolvedProfile object form instead.
 */
function shouldInstallSkill(skillBaseName: string, resolvedProfileOrMode: ResolvedProfile | string): boolean {
  if (typeof resolvedProfileOrMode === 'object' && resolvedProfileOrMode !== null) {
    const { skills } = resolvedProfileOrMode;
    if (skills === '*') return true;
    return skills instanceof Set && skills.has(skillBaseName);
  }
  // Legacy string mode
  const mode = resolvedProfileOrMode;
  if (!isMinimalMode(mode)) return true;
  return MINIMAL_ALLOWLIST_SET.has(skillBaseName);
}

/**
 * Stage a filtered copy of the source commands/gsd directory.
 * Back-compat wrapper: maps 'minimal' → core profile, 'full' → full.
 *
 * @deprecated Use stageSkillsForProfile with a resolved profile instead.
 */
function stageSkillsForMode(srcDir: string, mode: string): string {
  if (!isMinimalMode(mode)) return srcDir;
  if (!fs.existsSync(srcDir)) return srcDir;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-minimal-skills-'));
  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const baseName = entry.name.replace(/\.md$/, '');
      if (!shouldInstallSkill(baseName, mode)) continue;
      fs.copyFileSync(
        path.join(srcDir, entry.name),
        path.join(stageDir, entry.name),
      );
    }
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  STAGED_DIRS.add(stageDir);
  ensureExitCleanup();
  return stageDir;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  // New profile API (ADR-0011)
  PROFILES,
  PROFILE_RANK,
  loadSkillsManifest,
  resolveProfile,
  resolveEffectiveProfile,
  mostRestrictiveProfile,
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageSkillsForRuntimeAsSkills,
  STAGED_DIRS,
  readActiveProfile,
  writeActiveProfile,
  // Shared internals
  cleanupStagedSkills,
  // Back-compat / deprecated
  MINIMAL_SKILL_ALLOWLIST,
  isMinimalMode,
  shouldInstallSkill,
  stageSkillsForMode,
};

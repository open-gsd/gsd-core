/**
 * Gate phase context — path/phase resolution shared by the gate modules (#5139, epic #5056,
 * ADR-5057 §4 first bullet, design D3).
 *
 * Owns the containment helper (a caller-supplied path argument is resolved against the project
 * directory and must stay inside it; it RETURNS a `GateUsageFailure` on an escape — a gate module
 * never calls `error()` — and the router turns that failure into the same `error(message,
 * 'usage')` the pre-move router raised), the phase-directory / ROADMAP lookups and the degraded
 * verdict of the two verify probes.
 *
 * Every lookup answers with typed evidence (#5170, ADR-5057 §4): an absent thing is `none`, a thing
 * that exists but could not be read is `unreadable`, and nothing here collapses either into `''`.
 * The tolerant `readIfExists` reader is deleted; a gate reads through `gate-evidence.cts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { gateUsageFailure, gateUnreadable, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateUsageFailure, UnreadableVerdict } from './gate-verdict.cjs';
import {
  evidenceFound,
  evidenceNone,
  evidenceFromError,
  readDirEvidence,
  readTextEvidence,
  statEvidence,
} from './gate-evidence.cjs';
import type { Evidence } from './gate-evidence.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal, resolvePhaseDirectoryLookup, matchPhaseDirsForLookup } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapModule = require('./roadmap.cjs');
const { getRoadmapPhaseWithFallback } = roadmapModule;

/**
 * Resolve a caller-supplied path (absolute, or relative to `projectDir`) and require the result to
 * stay inside `projectDir` (realpath containment, ADR-4650). Returns the contained path the
 * predicate produced, or a `GateUsageFailure` (`usage`, `path escapes its allowed directory: <arg>`).
 */
export function resolveContainedPath(inputPath: string, projectDir: string): string | GateUsageFailure {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(projectDir, inputPath);
  const contained = tryWithinRoot(candidate, projectDir, PathAcceptance.AbsoluteInsideRoot);
  if (contained === null) {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `path escapes its allowed directory: ${inputPath}`);
  }
  return contained;
}

/**
 * The verdict of the two verify probes (`verify-command-paths`, `verify-failure-directions`) when
 * they cannot look: status/commands/counts zeroed, `readError` naming why. The payload is what the
 * plan-checker parses and must tell "nothing to report" from "could not look" by; the OUTCOME is
 * `unreadable` (#5170), so the exit status is `UNAVAILABLE` — "could not look" is never a pass and
 * never exit 0. `block` stays false (the probe's documented policy is unchanged).
 */
export function unresolvableProbeVerdict(readError: string): UnreadableVerdict {
  return gateUnreadable(false, {
    status: 'unresolvable',
    commands: [],
    counts: { blocker: 0, warning: 0, total: 0 },
    readError,
  });
}

/**
 * Resolve a phase argument to an absolute phase directory. The ONE owner of what three gates
 * (`ui-plan-gate`, `ui-safety-gate`, `tdd-review-checkpoint`) and the two verify probes each
 * inlined before #5139. `found` is the absolute directory; `none` is "no such phase"; `unreadable`
 * is a locator that failed while looking (a gate must not read that as "no phase").
 */
export function resolvePhaseDir(projectDir: string, phase: string): Evidence<string> {
  let result: ReturnType<typeof findPhaseInternal> | string;
  try {
    result = findPhaseInternal(projectDir, phase);
  } catch (err) {
    return evidenceFromError<string>(err, `phase ${phase}`);
  }
  if (result && typeof result === 'object') {
    // findPhaseInternal returns { directory: '<relative-posix-path>', ... }
    // directory is relative to cwd — resolve it to absolute.
    const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
    if (relDir) return evidenceFound(path.resolve(projectDir, relDir));
  } else if (typeof result === 'string' && result !== '') {
    return evidenceFound(result);
  }
  return evidenceNone<string>();
}

/**
 * Resolve a phase argument to its directory DIRECTLY under a given `phasesDir`, for the two drift
 * gates (schema-drift, context-drift; #1571, #2528, #5219).
 *
 * It is NOT `resolvePhaseDir`: that one asks the phase locator (`findPhaseInternal`), which looks
 * through the current milestone's phases AND the milestone archives and reads the active workstream.
 * The drift gates are handed ONE phases directory and must look nowhere else, and they resolve
 * through the canonical phase-directory matcher (`matchPhaseDirs`, never a naive substring test: a
 * bare `.includes(phaseArg)` lets a non-existent phase match a different phase whose directory merely
 * contains the token, e.g. "1" matching "11-expansion"), then fall back to an exact directory name
 * contained in `phasesDir` (a name escaping it resolves to nothing). Folding it into
 * `resolvePhaseDir` would widen what those gates inspect, so the two stay apart and each states its
 * scope. Throws when `phasesDir` cannot be listed; both callers sit inside their non-blocking catch.
 */
export function resolvePhaseDirByToken(cwd: string, phasesDir: string, phaseArg: string): string | null {
  const lookup = resolvePhaseDirectoryLookup(cwd, phaseArg);
  const dirEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
  const dirNames = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  // #4304: both drift gates resolve a directory in the current checkout.
  // Bracket is the only opt-in grammar; all other conventions remain legacy.
  const matched = matchPhaseDirsForLookup(dirNames, lookup).matches[0];
  if (matched) return path.join(phasesDir, matched);
  const contained = tryWithinRoot(phaseArg, phasesDir);
  if (contained !== null && statEvidence(contained).kind === 'found') return contained;
  return null;
}

/** The `*-UI-SPEC.md` inside `phaseDir` (absolute path): `none` when the directory or the spec is absent. */
export function findUiSpecInDir(phaseDir: string): Evidence<string> {
  const entries = readDirEvidence(phaseDir);
  if (entries.kind !== 'found') return entries;
  const found = entries.value.find((f) => /-UI-SPEC\.md$/.test(f));
  return found ? evidenceFound(path.join(phaseDir, found)) : evidenceNone<string>();
}

/**
 * The phase's `*-UI-SPEC.md`: `found` (absolute path), `none` (no phase directory, or no spec in
 * it), or `unreadable` (the phase lookup or the directory read failed — the spec may exist).
 */
export function locateUiSpec(projectDir: string, phase: string): Evidence<string> {
  const phaseDir = resolvePhaseDir(projectDir, phase);
  if (phaseDir.kind !== 'found') return phaseDir;
  return findUiSpecInDir(phaseDir.value);
}

/** The ROADMAP phase lookup both UI gates share. */
export interface RoadmapPhaseLookup {
  /** The phase's ROADMAP section text; '' when there is no ROADMAP.md or the phase is absent. */
  phaseSection: string;
  /** True only when ROADMAP.md exists but no phase header matched (surfaced so a missing phase cannot silently bypass). */
  phaseLookupFailed: boolean;
  /** Present only when the ROADMAP lookup itself failed: why. Never conflated with an absent ROADMAP. */
  readError?: string;
}

/**
 * The ROADMAP phase section for `phase`, through the same two-pass lookup as `roadmap.get-phase`
 * (current milestone, then the full roadmap). A missing ROADMAP.md means "no roadmap, cannot be
 * frontend" (`phaseLookupFailed` stays false); a present ROADMAP.md without the phase sets it. A
 * lookup that FAILED (the reader threw, or ROADMAP.md exists but cannot be read) carries `readError`
 * — "could not look" — instead of reading as an empty, non-frontend roadmap. Shared by
 * `ui-plan-gate` and `ui-safety-gate`.
 */
export function lookupRoadmapPhase(projectDir: string, phase: string): RoadmapPhaseLookup {
  let section: string | null;
  try {
    section = getRoadmapPhaseWithFallback(projectDir, phase);
  } catch (err) {
    const failure = evidenceFromError<string>(err, 'ROADMAP.md');
    if (failure.kind === 'unreadable') {
      return { phaseSection: '', phaseLookupFailed: false, readError: failure.reason };
    }
    return { phaseSection: '', phaseLookupFailed: false };
  }
  if (section !== null) return { phaseSection: section, phaseLookupFailed: false };
  // Distinguish: ROADMAP.md missing (no-roadmap project) vs phase not found in ROADMAP.
  const roadmap = readTextEvidence(path.join(planningDir(projectDir), 'ROADMAP.md'));
  if (roadmap.kind === 'unreadable') {
    return { phaseSection: '', phaseLookupFailed: false, readError: roadmap.reason };
  }
  return { phaseSection: '', phaseLookupFailed: roadmap.kind === 'found' };
}

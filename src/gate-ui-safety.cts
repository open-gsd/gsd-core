/**
 * `check ui-safety-gate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns
 * a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * Post-wave check that verifies UI-changed files conform to the active UI-SPEC for the phase.
 * Uses `checkUiPresence` from `ui-safety-gate.cjs` (frontend detection is not reimplemented) and
 * looks for frontend files in the phase's evaluation scope (#5164, ADR-5057 §4): the union of the
 * phase's own commits' file sets from `gate-evaluation-scope`, not the last commit. A scope the
 * resolver could not read, or had to widen, is reported (`scopeStatus` / `scopeReason`), never
 * silently treated as "no UI files".
 *
 * Argv after the verb: `<phase>`.
 */

import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { locateUiSpec, lookupRoadmapPhase } from './gate-phase-context.cjs';
import { resolveEvaluationScope } from './gate-evaluation-scope.cjs';
import { runtimeCommand } from './runtime-slash.cjs';
import type { ScopeStatus } from './gate-evaluation-scope.cjs';
import { checkUiPresence } from './ui-safety-gate.cjs';
import { readStaticFrontendEvidence } from './ui-frontend-evidence.cjs';
import { evidenceNone } from './gate-evidence.cjs';

const UI_FILE_EXTENSIONS_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const UI_PATH_PATTERNS_RE = /\/(components|pages|views|screens|layouts|ui|frontend)\//i;

export interface UiSafetyGateResult {
  frontend: boolean;
  hasUiFiles: boolean;
  /** Static frontend evidence in the project tree, by the definition `ui-plan-gate` uses (#5646). */
  hasFrontendEvidence: boolean;
  hasUiSpec: boolean;
  block: boolean;
  message?: string;
  phaseLookupFailed?: boolean;
  /** Present only when the scope was widened (`degraded`) or unreadable (`unresolvable`). */
  scopeStatus?: Exclude<ScopeStatus, 'resolved'>;
  scopeReason?: string;
  /**
   * Present only when the ROADMAP, the phase directory, or (for a frontend phase with UI files and no
   * UI-SPEC) the static frontend evidence could not be read (#5170): the verdict is `unreadable`.
   */
  readError?: string;
}

/**
 * Pure logic for ui-safety-gate — exposed for direct behavioral testing.
 *
 *   (a) ROADMAP phase section via the shared lookup (same as ui-plan-gate) → is this a frontend phase.
 *   (b) checkUiPresence (frontend detection).
 *   (c) UI files among the phase's evaluation scope (`resolveEvaluationScope`, phase unit; every
 *       git call is bounded by the resolver's seam; an unreadable scope is reported, not "clean").
 *   (d) Phase directory → `*-UI-SPEC.md`.
 *
 *   (c') Static frontend evidence (`readStaticFrontendEvidence`, the definition `computeUiPlanGate` uses),
 *       probed only for a frontend phase that changed UI files (#5646).
 *
 * `block = frontend && hasUiFiles && hasFrontendEvidence && !hasUiSpec`.
 */
export function computeUiSafetyGate(projectDir: string, phase: string): UiSafetyGateResult {
  // (a) phase section text (same two-pass lookup as computeUiPlanGate)
  const { phaseSection, phaseLookupFailed, readError: roadmapReadError } = lookupRoadmapPhase(projectDir, phase);

  // (b) frontend detection — reuse the existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (c) any UI files in the phase's own commits? (deleted paths count: a removed component is a UI change)
  const scope = resolveEvaluationScope(projectDir, { kind: 'phase', phase });
  const hasUiFiles = scope.changedFiles.some((f) =>
    f.trim() && (UI_FILE_EXTENSIONS_RE.test(f) || UI_PATH_PATTERNS_RE.test(f)),
  );

  // (c') #5646 — static structural corroboration, the same evidence `computeUiPlanGate` requires (#3312):
  // `hasUiFiles` is a weak signal (an `.html` fixture, or any file under a `ui/` directory in any
  // language), so on its own it halted projects with no frontend that the plan gate had cleared. Only
  // probed when it could change the answer. `unreadable` (#5170) is a manifest or tree the probe could
  // not look at: absence of evidence is then not established, and the verdict says so (below).
  const frontendEvidence = frontend && hasUiFiles ? readStaticFrontendEvidence(projectDir) : evidenceNone<true>();
  const hasFrontendEvidence = frontendEvidence.kind === 'found';

  // (d) phase directory and *-UI-SPEC.md
  // `none` is "no spec"; `unreadable` is "could not look" (#5170) and is carried to the verdict.
  const uiSpec = locateUiSpec(projectDir, phase);
  const hasUiSpec = uiSpec.kind === 'found';
  // Unreadable frontend evidence only matters when it could flip the verdict: with a UI-SPEC present the
  // gate does not block whatever the tree holds.
  const frontendReadError = frontendEvidence.kind === 'unreadable' && !hasUiSpec
    ? `static frontend evidence could not be read (${frontendEvidence.reason})`
    : undefined;
  const readError = roadmapReadError ?? (uiSpec.kind === 'unreadable' ? uiSpec.reason : undefined) ?? frontendReadError;

  // block only when: this is a frontend phase AND UI files were changed AND the project has static
  // frontend evidence AND no UI-SPEC exists
  const block = frontend && hasUiFiles && hasFrontendEvidence && !hasUiSpec;

  const result: UiSafetyGateResult = { frontend, hasUiFiles, hasFrontendEvidence, hasUiSpec, block };
  if (block) {
    result.message = `UI files changed in this wave but no UI-SPEC.md exists for Phase ${phase}. ` +
      `Run ${runtimeCommand(projectDir, `ui-phase ${phase}`)} to generate the design contract before continuing.`;
  }
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  if (scope.status !== 'resolved') {
    result.scopeStatus = scope.status;
    result.scopeReason = scope.reason ?? '';
  }
  if (readError !== undefined) result.readError = readError;
  return result;
}

export function evaluateUiSafetyGate(input: { projectDir: string; args: readonly string[] }): GateResult {
  const phase = input.args[0] || '';
  if (!phase) {
    return gateUsageFailure(GATE_FAILURE_CODE.SDK_MISSING_ARG, 'ui-safety-gate requires a phase argument: check ui-safety-gate <phase>');
  }
  const result = computeUiSafetyGate(input.projectDir, phase);
  // A scope the resolver could not read, or a ROADMAP / phase directory that could not be read, is
  // "could not look", never a pass (ADR-5057 §4): the outcome is `unreadable` and the exit status
  // follows it. `block` is the gate's own policy and is unchanged.
  if (result.scopeStatus === 'unresolvable' || result.readError !== undefined) {
    return gateUnreadable(result.block, { ...result });
  }
  return gateVerdict(result.block ? 'block' : 'pass', result.block, { ...result });
}

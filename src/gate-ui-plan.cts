/**
 * `check ui-plan-gate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns a
 * `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * Given a phase number, checks whether the phase has frontend indicators and whether a
 * `*-UI-SPEC.md` already exists in the phase directory. Uses `checkUiPresence` from
 * `ui-safety-gate.cjs` (frontend detection is not reimplemented) and the shared phase-context
 * helpers for the ROADMAP lookup and the phase directory.
 *
 * Argv after the verb: `<phase>`.
 */

import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { locateUiSpec, lookupRoadmapPhase } from './gate-phase-context.cjs';
import { checkUiPresence } from './ui-safety-gate.cjs';
import { readStaticFrontendEvidence } from './ui-frontend-evidence.cjs';
import { evidenceNone } from './gate-evidence.cjs';

export interface UiPlanGateResult {
  frontend: boolean;
  hasFrontendEvidence: boolean;
  hasUiSpec: boolean;
  block: boolean;
  uiSpecPath: string | null;
  matchedToken: string | null;
  matchedLine: string | null;
  phaseLookupFailed?: boolean;
  /**
   * Present only when the ROADMAP, the phase directory, or (for a frontend phase with no UI-SPEC) the static
   * frontend evidence could not be read (#5170): the verdict is `unreadable`.
   */
  readError?: string;
}

/**
 * Pure logic for ui-plan-gate — exposed for direct behavioral testing.
 *
 * Given a projectDir and phase number:
 *   (a) Reads the phase section from ROADMAP.md via the two-pass lookup `roadmap.get-phase` uses
 *       (current milestone → full roadmap). ROADMAP.md missing = project has no roadmap = cannot
 *       be frontend. Phase absent from a present ROADMAP.md sets `phaseLookupFailed` so callers
 *       can surface the miss — we do NOT silently degrade to frontend:false.
 *   (b) Runs checkUiPresence (frontend detection).
 *   (c) Resolves the phase directory; checks for *-UI-SPEC.md.
 *
 * `block = frontend && hasFrontendEvidence && !hasUiSpec` (#3312): `frontend` is a vocabulary
 * signal only (a hyphen is a word boundary, so a repo named `dashboard-financeiro` matches the
 * token `dashboard`; the boundary rule of #3718 is intentional), so the gate blocks only when the
 * token match is corroborated by static frontend evidence in the repo tree
 * (`hasStaticFrontendEvidence`). matchedToken/matchedLine surface what tripped the sniffer.
 */
export function computeUiPlanGate(projectDir: string, phase: string): UiPlanGateResult {
  // (a) phase section text
  const { phaseSection, phaseLookupFailed, readError: roadmapReadError } = lookupRoadmapPhase(projectDir, phase);

  // (b) frontend detection — reuse the existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (b') #3312 — static structural corroboration. Only probed when the sniffer matched. `unreadable`
  // (#5170) is a manifest or tree the probe could not look at: absence of evidence is then not
  // established, and the verdict says so (below) instead of reading it as "no frontend".
  const frontendEvidence = frontend ? readStaticFrontendEvidence(projectDir) : evidenceNone<true>();
  const hasFrontendEvidence = frontendEvidence.kind === 'found';

  // (c) phase directory and *-UI-SPEC.md. `none` is "no spec"; `unreadable` is "could not look"
  // (#5170) and is carried to the verdict, never read as "no spec".
  const uiSpec = locateUiSpec(projectDir, phase);
  const uiSpecPath = uiSpec.kind === 'found' ? uiSpec.value : '';
  const hasUiSpec = uiSpecPath !== '';
  // Unreadable frontend evidence only matters when it could flip the verdict: with a UI-SPEC present the
  // gate does not block whatever the tree holds.
  const frontendReadError = frontendEvidence.kind === 'unreadable' && !hasUiSpec
    ? `static frontend evidence could not be read (${frontendEvidence.reason})`
    : undefined;
  const readError = roadmapReadError ?? (uiSpec.kind === 'unreadable' ? uiSpec.reason : undefined) ?? frontendReadError;

  // block = frontend phase with structural frontend evidence and no UI-SPEC (#3312)
  const block = frontend && hasFrontendEvidence && !hasUiSpec;

  const result: UiPlanGateResult = {
    frontend, hasFrontendEvidence, hasUiSpec, block,
    uiSpecPath: hasUiSpec ? uiSpecPath : null,
    matchedToken: presenceResult.matchedToken,
    matchedLine: presenceResult.matchedLine,
  };
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  if (readError !== undefined) result.readError = readError;
  return result;
}

export function evaluateUiPlanGate(input: { projectDir: string; args: readonly string[] }): GateResult {
  const phase = input.args[0] || '';
  if (!phase) {
    return gateUsageFailure(GATE_FAILURE_CODE.SDK_MISSING_ARG, 'ui-plan-gate requires a phase argument: check ui-plan-gate <phase>');
  }
  const result = computeUiPlanGate(input.projectDir, phase);
  // Evidence the gate could not read is "could not look", never a pass (ADR-5057 §4). `block` is
  // the gate's own policy and is unchanged; the exit status follows the outcome.
  if (result.readError !== undefined) return gateUnreadable(result.block, { ...result });
  return gateVerdict(result.block ? 'block' : 'pass', result.block, { ...result });
}

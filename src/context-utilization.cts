/**
 * Context-utilization classifier for `gsd-health --context` (ADR-457
 * build-at-publish: the hand-written bin/lib/context-utilization.cjs collapsed
 * to a TypeScript source of truth). Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 *
 * Pure function. Callers pass tokensUsed + contextWindow; the
 * classifier returns the percent and one of three states. Recommendation
 * strings are NOT in this module — formatting is the renderer's job
 * (see `validate context` in gsd-tools.cjs). That separation lets the
 * copy change without touching this module's tests.
 *
 * Thresholds:
 *   < 60%   healthy   no action
 *   60–70%  warning   approaching the fracture zone
 *   ≥ 70%   critical  reasoning quality may degrade
 *
 * State boundaries use the exact ratio. The displayed `percent` is
 * rounded for human reading and may differ from the boundary by ±1 in
 * edge cases (e.g. 59.999% displays as 60 but classifies as healthy).
 */

export type ContextState = 'healthy' | 'warning' | 'critical';

export interface ContextUtilizationResult {
  percent: number;
  state: ContextState;
}

export const STATES: Readonly<{ HEALTHY: 'healthy'; WARNING: 'warning'; CRITICAL: 'critical' }> =
  Object.freeze({
    HEALTHY: 'healthy' as const,
    WARNING: 'warning' as const,
    CRITICAL: 'critical' as const,
  });

export function classifyContextUtilization(
  tokensUsed: number,
  contextWindow: number,
): ContextUtilizationResult {
  if (!Number.isInteger(tokensUsed) || tokensUsed < 0) {
    throw new TypeError(
      `tokensUsed must be a non-negative integer, got: ${tokensUsed} (${typeof tokensUsed})`,
    );
  }
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TypeError(
      `contextWindow must be a positive integer, got: ${contextWindow} (${typeof contextWindow})`,
    );
  }

  const ratio = Math.min(tokensUsed / contextWindow, 1);
  const percent = Math.min(Math.round(ratio * 100), 100);

  let state: ContextState;
  if (ratio < 0.60) state = STATES.HEALTHY;
  else if (ratio < 0.70) state = STATES.WARNING;
  else state = STATES.CRITICAL;

  return { percent, state };
}

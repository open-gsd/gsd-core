/**
 * dispatch-isolation.cts — the single owner of the dispatch-isolation
 * vocabulary (#4561).
 *
 * ADR-1239's Codex-binding amendment (#2584) declares how a host isolates
 * concurrent same-wave executors as a closed three-member vocabulary:
 *
 *   `harness-worktree`      — the host's own harness creates + binds a git
 *                             worktree per executor (host-driven fan-out).
 *   `orchestrator-worktree` — GSD itself creates the worktree and
 *                             process-spawns the executor into it
 *                             (GSD-driven fan-out).
 *   `none`                  — no isolation primitive; same-wave plans run
 *                             inline, sequentially.
 *
 * Until #4561 that set — and its two-member "who creates the worktree"
 * subset the #683 base-check keys on — was hand-written at eight independent
 * sites (`gsd-tools.cjs` ×2, `capability-validator.cjs`,
 * `hooks/lib/isolation-sentinel.js`, `host-integration.cts` ×2,
 * `worktree-base-ref.cts` ×2) with nothing asserting they agreed. Half of
 * them sit outside the TypeScript project, so the compiler related only the
 * `.cts` half to itself. A fourth mode added at one site would have been
 * written to the sentinel, rejected as malformed by the sentinel reader's
 * own copy, and silently degraded to `none` by the guard's registry
 * fallback — a permitted, unisolated dispatch decided three sites away from
 * the one that introduced the mode.
 *
 * This module is the one declaration. Every other runtime site consumes it,
 * and the `.cts` types are DERIVED from the tuple rather than restated —
 * with one deliberate exception: `hooks/lib/isolation-sentinel.js` keeps a
 * literal copy, because the guard hooks must load on a raw plugin-marketplace
 * install where the compiled `gsd-core/bin/lib/` is absent and the
 * self-healing build seam has not yet run (a hook that dies at module load
 * is worse than one carrying a mirror). That mirror is pinned to this module
 * by `tests/host-integration-validator-parity.test.cjs`, so a fourth mode
 * turns into a red test rather than a silent degrade.
 *
 * Pure: no I/O, no config, nothing to throw.
 */

/**
 * The closed vocabulary, in ADR-1239's declaration order. `as const` makes it
 * the source the `DispatchIsolation` type is derived from.
 */
export const DISPATCH_ISOLATION_MODES = Object.freeze(['harness-worktree', 'orchestrator-worktree', 'none'] as const);

export type DispatchIsolation = (typeof DISPATCH_ISOLATION_MODES)[number];

/**
 * Set view for membership tests over untrusted strings (CLI arguments, a
 * sentinel payload read back from disk, a registry descriptor).
 */
export const DISPATCH_ISOLATION_VOCABULARY: ReadonlySet<string> = new Set<string>(DISPATCH_ISOLATION_MODES);

/**
 * The worktree-CREATING members — everything but `none`, which creates no
 * worktree and never reaches a base-check. Defined by exclusion from the
 * tuple above, not as a second list, so a fourth worktree-creating mode is a
 * member here the moment it is a member there.
 */
export type BaseCheckIsolationMode = Exclude<DispatchIsolation, 'none'>;

export const BASE_CHECK_ISOLATION_MODES: readonly BaseCheckIsolationMode[] = Object.freeze(
  DISPATCH_ISOLATION_MODES.filter((mode): mode is BaseCheckIsolationMode => mode !== 'none'),
);

export const BASE_CHECK_ISOLATION_VOCABULARY: ReadonlySet<string> = new Set<string>(BASE_CHECK_ISOLATION_MODES);

/** Type guard: is `value` a member of the dispatch-isolation vocabulary? */
export function isDispatchIsolation(value: unknown): value is DispatchIsolation {
  return typeof value === 'string' && DISPATCH_ISOLATION_VOCABULARY.has(value);
}

/** Type guard: is `value` a worktree-creating member (a mode the #683 base-check applies to)? */
export function isBaseCheckIsolationMode(value: unknown): value is BaseCheckIsolationMode {
  return typeof value === 'string' && BASE_CHECK_ISOLATION_VOCABULARY.has(value);
}

/**
 * dispatch-isolation.cts — the single owner of the dispatch-isolation vocabulary
 * (#4561): ADR-1239's closed three-member set (#2584) for how a host isolates
 * concurrent same-wave executors. `harness-worktree`: the host's harness creates
 * and binds a worktree per executor. `orchestrator-worktree`: GSD creates the
 * worktree and process-spawns the executor into it. `none`: no primitive;
 * same-wave plans run inline, sequentially.
 *
 * Until #4561 the set and its "who creates the worktree" subset were hand-written
 * at eight sites with nothing asserting they agreed. Every other JavaScript site now
 * consumes this module, and the `.cts` types derive from the tuple, except
 * `hooks/lib/isolation-sentinel.js`, which must load where `gsd-core/bin/lib/` is
 * absent; it and the workflow-shell validity lists are pinned copies (ADR-4630
 * Decision 3). Pure: no I/O, no config, nothing to throw.
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

/**
 * The decision time a dispatch site passes back with `--renew-held <ms>`
 * (#4904): the `decidedAt` its held answer reported, in epoch milliseconds.
 * Only 1 to 16 decimal digits whose value is a safe integer parse; leading
 * zeros read as decimal. Anything else is null, and the re-record is then a
 * fresh decision.
 */
export function parseRenewHeldMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const ms = Number(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

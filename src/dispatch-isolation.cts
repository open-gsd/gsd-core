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
 * A read-only Set VIEW. `ReadonlySet` is a compile-time annotation that erases
 * to an ordinary, mutable `Set` in the emitted .cjs, and every runtime consumer
 * of this module is plain CommonJS with no compiler in the loop — so a
 * `VALID_DISPATCH_ISOLATION.add('x')` anywhere would split the Set view from
 * the tuple and the type guards inside one process (found by the pre-create
 * adversarial review of #4561, driven). Shadowing `add`/`delete`/`clear` on a
 * real Set is NOT enough: `Set.prototype.add.call(set, 'x')` reaches the
 * internal storage regardless (the same review's continuation drove that too).
 * So the backing Set never leaves this closure; what is exported is a frozen
 * plain object implementing the `ReadonlySet` surface — `has`, `size`,
 * `forEach`, `keys`/`values`/`entries`, iteration and spread all work, while a
 * native Set method applied to it throws "incompatible receiver" because the
 * object carries no Set internals at all. The Set methods the view delegates
 * to are captured HERE, at module load, so the view never performs a dynamic
 * `Set.prototype` lookup at call time — a later `Set.prototype.has = …` patch
 * cannot use the view as a channel to the backing Set.
 *
 * Contract boundary, stated so nobody reads more into this than it holds: the
 * seal defends the vocabulary against ordinary in-process mutation — a stray
 * `.add`, a `Set.prototype.*.call`, a well-meaning "let me just extend the
 * set here". It is not, and cannot be, a defense against code that has
 * already rewritten the language built-ins this module loaded against; such
 * code owns the process and needs no channel through this file. (Raised by
 * the review's second continuation, which patched `Set.prototype.has` before
 * the first call; declared out of contract rather than chased into
 * `Function.prototype.call`.)
 */
// Captured unbound on purpose — each is invoked below with an explicit
// `.call(backing, …)`; holding the reference is what pins the method against a
// later prototype patch. Read through a plain record so the capture is a
// property read, not a method access (no lint carve-out needed — the emitted
// .cjs is linted too, under a config without the TypeScript rule set).
type StringSet = Set<string>;
const SET_PROTO = Set.prototype as unknown as Record<string, unknown>;
const SET_HAS = SET_PROTO.has as (this: StringSet, value: string) => boolean;
const SET_FOR_EACH = SET_PROTO.forEach as (this: StringSet, cb: (value: string) => void) => void;
const SET_KEYS = SET_PROTO.keys as (this: StringSet) => SetIterator<string>;
const SET_VALUES = SET_PROTO.values as (this: StringSet) => SetIterator<string>;
const SET_ENTRIES = SET_PROTO.entries as (this: StringSet) => SetIterator<[string, string]>;
const SET_SIZE = (Object.getOwnPropertyDescriptor(Set.prototype, 'size') as unknown as { get: (this: StringSet) => number }).get;

function sealedSet(values: readonly string[]): ReadonlySet<string> {
  const backing = new Set<string>(values);
  const view: ReadonlySet<string> = {
    get size() { return SET_SIZE.call(backing); },
    has: (value: string) => SET_HAS.call(backing, value),
    forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      SET_FOR_EACH.call(backing, (value: string) => callback.call(thisArg, value, value, view));
    },
    keys: () => SET_KEYS.call(backing),
    values: () => SET_VALUES.call(backing),
    entries: () => SET_ENTRIES.call(backing),
    [Symbol.iterator]: () => SET_VALUES.call(backing),
  };
  return Object.freeze(view);
}

/**
 * Set view for membership tests over untrusted strings (CLI arguments, a
 * sentinel payload read back from disk, a registry descriptor). Sealed — see
 * `sealedSet`.
 */
export const DISPATCH_ISOLATION_VOCABULARY: ReadonlySet<string> = sealedSet(DISPATCH_ISOLATION_MODES);

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

export const BASE_CHECK_ISOLATION_VOCABULARY: ReadonlySet<string> = sealedSet(BASE_CHECK_ISOLATION_MODES);

/** Type guard: is `value` a member of the dispatch-isolation vocabulary? */
export function isDispatchIsolation(value: unknown): value is DispatchIsolation {
  return typeof value === 'string' && DISPATCH_ISOLATION_VOCABULARY.has(value);
}

/** Type guard: is `value` a worktree-creating member (a mode the #683 base-check applies to)? */
export function isBaseCheckIsolationMode(value: unknown): value is BaseCheckIsolationMode {
  return typeof value === 'string' && BASE_CHECK_ISOLATION_VOCABULARY.has(value);
}

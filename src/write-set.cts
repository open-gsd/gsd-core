/**
 * Write-Set — shared fail-loud parse `Result` and per-surface write-set
 * contracts (ADR-2143, epic #2143). Pure, Node built-ins only, no I/O.
 * Compiled by tsc to gsd-core/bin/lib/write-set.cjs.
 *
 * ADR-2143 §5 (fail-loud parsing, no null-swallow): seam parse operations
 * and document-model accessors return a typed `Result<T>` — never a bare
 * `null` a caller can mistake for "empty but fine." This is the same
 * `{ ok: true; value: T } | { ok: false; reason: string }` shape
 * `markdown-table.cts` already defined for `parseMarkdownTable` /
 * `appendQuickTaskRow`; this module is now the single source of truth for
 * it and `markdown-table.cjs` re-exports the type so existing importers of
 * `Result` from that module keep working unchanged.
 *
 * NOTE: deliberately distinct from command-routing-hub's dispatch `Result`
 * (`{ok,data}|{ok:false,kind}`) — the two never mix (different modules,
 * different shapes, different purposes).
 *
 * ADR-2143 §6 (write-set results for multi-surface commands, no
 * OR-into-one-flag): a command that mutates more than one surface returns
 * an explicit per-surface write-set — `{ surface, applied }` outcomes — and
 * its top-level "did this fully succeed" signal is true only if EVERY
 * surface in the set applied. ORing independent surfaces into a single
 * boolean is the direct anti-pattern that let a checkbox-only partial
 * write (#2140) report full success.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * One surface's outcome within a multi-surface write (ADR-2143 §6).
 *
 * `requirement` identifies which entity/ID this surface outcome belongs to,
 * so a multi-entity command's write-set does not collapse independent
 * entities into one aggregate — the §6 "no OR into one flag" rule applies
 * per entity too, not just per surface.
 */
export interface WriteOutcome {
  surface: string;
  applied: boolean;
  requirement?: string;
}

/** The full set of per-surface outcomes for one multi-surface write. */
export type WriteSet = WriteOutcome[];

/**
 * True only if the write-set is non-empty AND every surface in it applied.
 * An empty write-set is never "complete" — there is nothing to be complete
 * about, so treating it as vacuously true would let a no-op masquerade as
 * a full success (the same OR-into-one-flag class ADR-2143 §6 prohibits).
 */
export function writeSetComplete(ws: WriteSet): boolean {
  return ws.length > 0 && ws.every((o) => o.applied);
}

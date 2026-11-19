"use strict";
/**
 * Recorded executor type (#6213). A plan's `agent_hint` can route it to a hinted executor; the
 * dispatch-isolation record (ADR-4630) carries that type as `executor_type` so both isolation
 * guards check the executor the record names.
 *
 * The rule is the bare-name grammar agent hints already follow: no path separators, no `..`, no
 * leading `-`, at most 128 characters. `hooks/lib/isolation-sentinel.js` carries the reader-side
 * copy, kept so the hooks' sentinel read path needs no `gsd-core/bin/lib` require;
 * `tests/hinted-executor-record.test.cjs` asserts the two accept and reject identically.
 */
const EXECUTOR_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * A phase-level record (no plan) names every hinted executor routable in its phase as
 * `executor_types`: at most this many entries, each passing `isValidExecutorType`. The reader copy
 * (`MAX_EXECUTOR_TYPES` in `hooks/lib/isolation-sentinel.js`) applies the same bound.
 */
const MAX_EXECUTOR_TYPES = 64;
/** True iff `v` is a string an executor type may be recorded as. */
function isValidExecutorType(v) {
    return typeof v === 'string' && EXECUTOR_TYPE_RE.test(v) && !v.includes('..');
}
/**
 * The `executor_types` list a record may carry: a non-array is empty, invalid entries are dropped,
 * entries are de-duplicated and sorted, and at most `MAX_EXECUTOR_TYPES` are kept. Mirrors the
 * reader's `executorTypes` parse (same validity rule and bound).
 */
function normalizeExecutorTypes(v) {
    return uniqueExecutorTypes(v).slice(0, MAX_EXECUTOR_TYPES);
}
/**
 * The valid, de-duplicated, sorted entries of `v`, with NO cap. The record writer applies the
 * `MAX_EXECUTOR_TYPES` cap itself so it can report the names that were capped out.
 */
function uniqueExecutorTypes(v) {
    if (!Array.isArray(v))
        return [];
    return [...new Set(v.filter(isValidExecutorType))].sort();
}
module.exports = { isValidExecutorType, normalizeExecutorTypes, uniqueExecutorTypes, MAX_EXECUTOR_TYPES };

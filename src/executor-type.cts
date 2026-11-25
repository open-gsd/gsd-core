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
function isValidExecutorType(v: unknown): v is string {
  return typeof v === 'string' && EXECUTOR_TYPE_RE.test(v) && !v.includes('..');
}

/**
 * The `executor_types` list a record may carry: a non-array is empty, invalid entries are dropped,
 * entries are de-duplicated and sorted, and at most `MAX_EXECUTOR_TYPES` are kept. Mirrors the
 * reader's `executorTypes` parse (same validity rule and bound).
 */
function normalizeExecutorTypes(v: unknown): string[] {
  return uniqueExecutorTypes(v).slice(0, MAX_EXECUTOR_TYPES);
}

/**
 * The valid, de-duplicated, sorted entries of `v`, with NO cap. The record writer applies the
 * `MAX_EXECUTOR_TYPES` cap itself so it can report the names that were capped out.
 */
function uniqueExecutorTypes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter(isValidExecutorType))].sort();
}

/**
 * #4904 (option (c), ADR-4630): a plain `dispatch-isolation` query that HOLDS a caller's `none` writes no
 * decision record, so it writes the executor identity it derived to a record of its own under
 * `.gsd/<EXECUTOR_IDENTITY_DIR>/`, one file per query scope. The guards' classification reads these records
 * beside the decision records (`isExecutorDispatch`), and nothing reads them for enforcement. A sibling of
 * `.gsd/dispatch-isolation/`, never inside it: the keyed scan there treats a file that does not match its own
 * phase/plan key as unusable and fails classification closed. `hooks/lib/isolation-sentinel.js` mirrors this
 * name, `MAX_EXECUTOR_TYPES` and `EXECUTOR_IDENTITY_MAX_BYTES` as literals, and
 * `tests/held-query-executor-identity.test.cjs` asserts the two sides agree.
 */
const EXECUTOR_IDENTITY_DIR = 'dispatch-isolation-identity';

/** Byte budget of one serialized identity record: the decision record's `SENTINEL_MAX_BYTES`, the reader's read bound. */
const EXECUTOR_IDENTITY_MAX_BYTES = 4096;

/** The identity record's `schema` value; the reader accepts no other. */
const EXECUTOR_IDENTITY_SCHEMA = 1;

interface ExecutorIdentityRecord {
  schema: number;
  phase: string | null;
  plan: string | null;
  executor_type: string | null;
  executor_types: string[];
  executor_types_truncated: boolean;
  written_at: number;
}

/**
 * The identity record a held query writes for its scope, as a full snapshot: `executor_type` is the scope's
 * routed executor (a plan scope) or null, `executor_types` the valid, de-duplicated, sorted names (a phase or
 * unscoped scope), at most `MAX_EXECUTOR_TYPES`, and then only as many as keep the serialized record within
 * `EXECUTOR_IDENTITY_MAX_BYTES`, dropped from the end. `executor_types_truncated` is true exactly when a name
 * was dropped, and `dropped` lists them for the caller's warning. An empty list is a valid snapshot: it
 * replaces whatever the scope's record named before.
 */
function buildExecutorIdentityRecord(
  scope: { phase: string | null; plan: string | null },
  executorType: unknown,
  executorTypes: unknown,
  writtenAt: number,
): { record: ExecutorIdentityRecord; dropped: string[] } {
  const types = uniqueExecutorTypes(executorTypes);
  const record: ExecutorIdentityRecord = {
    schema: EXECUTOR_IDENTITY_SCHEMA,
    phase: scope.phase,
    plan: scope.plan,
    executor_type: isValidExecutorType(executorType) ? executorType : null,
    executor_types: types.slice(0, MAX_EXECUTOR_TYPES),
    executor_types_truncated: types.length > MAX_EXECUTOR_TYPES,
    written_at: writtenAt,
  };
  while (record.executor_types.length > 0 && Buffer.byteLength(JSON.stringify(record)) > EXECUTOR_IDENTITY_MAX_BYTES) {
    record.executor_types = record.executor_types.slice(0, -1);
    record.executor_types_truncated = true;
  }
  return { record, dropped: types.slice(record.executor_types.length) };
}

export = {
  isValidExecutorType,
  normalizeExecutorTypes,
  uniqueExecutorTypes,
  MAX_EXECUTOR_TYPES,
  EXECUTOR_IDENTITY_DIR,
  EXECUTOR_IDENTITY_MAX_BYTES,
  EXECUTOR_IDENTITY_SCHEMA,
  buildExecutorIdentityRecord,
};

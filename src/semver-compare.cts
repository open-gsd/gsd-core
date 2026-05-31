/**
 * Shared semver comparison utility (ADR-457 pilot: first hand-written
 * bin/lib/*.cjs collapsed to a TypeScript source of truth).
 *
 * Logic is preserved byte-for-behaviour from the prior hand-written
 * `get-shit-done/bin/lib/semver-compare.cjs`; only types are added. The
 * normalization policy here is locked by `tests/semver-compare.test.cjs` and
 * consumed by update-check, statusline dev-install detection, and changeset
 * range compare (`scripts/changeset/cli.cjs`).
 */

/** [major, minor, patch] — non-negative integers, never NaN. */
export type SemverTuple = [number, number, number];

/** Comparison result: -1 (a < b), 0 (equal), 1 (a > b). */
export type CompareResult = -1 | 0 | 1;

/**
 * What callers actually pass: a version string (`"1.2.3"`, `"v1.2.3-rc.1"`), a
 * bare number, or a missing value. The old hand-written `.cjs` typed these as
 * `unknown` and leaned on `String()` — which the type-aware lint flagged as an
 * `[object Object]` hazard. Narrowing to the real domain type is the fix.
 */
export type VersionInput = string | number | null | undefined;

export function toNumericTuple(input: VersionInput): SemverTuple {
  const cleaned = String(input == null ? '' : input).trim().replace(/^v/, '');
  const base = cleaned.replace(/[-+].*$/, '');
  const parts = base.split('.');
  const major = Number.parseInt(parts[0], 10) || 0;
  const minor = Number.parseInt(parts[1], 10) || 0;
  const patch = Number.parseInt(parts[2], 10) || 0;
  return [major, minor, patch];
}

export function compareSemverCore(a: VersionInput, b: VersionInput): CompareResult {
  const [a0, a1, a2] = toNumericTuple(a);
  const [b0, b1, b2] = toNumericTuple(b);
  if (a0 !== b0) return a0 > b0 ? 1 : -1;
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  return 0;
}

export function isSemverNewer(a: VersionInput, b: VersionInput): boolean {
  return compareSemverCore(a, b) > 0;
}

export function isStableTripletSemver(v: VersionInput): boolean {
  return /^\d+\.\d+\.\d+$/.test(String(v || '').replace(/^v/, ''));
}

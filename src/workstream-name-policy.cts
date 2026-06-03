/**
 * Canonical workstream name validation and slug normalization
 * (ADR-457 build-at-publish: the hand-written bin/lib/workstream-name-policy.cjs
 * collapsed to a TypeScript source of truth). Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Used by active-workstream-store.cjs, planning-workspace.cjs, workstream.cjs.
 */

export const INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE =
  'Invalid workstream name: must be alphanumeric, hyphens, underscores, or dots';

const ACTIVE_WORKSTREAM_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Result of validateActiveWorkstreamName. */
export interface WorkstreamValidationResult {
  ok: boolean;
  reason: 'empty' | 'invalid' | null;
  value: string | null;
}

export function normalizeWorkstreamNameInput(name: string | null | undefined): string | null {
  const value = String(name ?? '').trim();
  return value || null;
}

/**
 * Returns true when `name` contains a path separator, a bare dot, or a
 * dot-dot sequence — any of which would make the name unsafe for use as a
 * filesystem path segment.
 */
export function hasInvalidPathSegment(name: string | null | undefined): boolean {
  const value = String(name ?? '');
  return /[/\\]/.test(value) || value === '.' || value === '..' || value.includes('..');
}

export function validateActiveWorkstreamName(name: string | null | undefined): WorkstreamValidationResult {
  const value = normalizeWorkstreamNameInput(name);
  if (!value) {
    return {
      ok: false,
      reason: 'empty',
      value: null,
    };
  }
  if (hasInvalidPathSegment(value) || !ACTIVE_WORKSTREAM_RE.test(value)) {
    return {
      ok: false,
      reason: 'invalid',
      value,
    };
  }
  return {
    ok: true,
    reason: null,
    value,
  };
}

/**
 * Validate a workstream name.
 * Allowed: alphanumeric, hyphens, underscores, dots.
 * Disallowed: empty, spaces, slashes, special chars, path traversal.
 *
 * Alias for isValidActiveWorkstreamName; provided for SDK-layer callers.
 */
export function validateWorkstreamName(name: string | null | undefined): boolean {
  return isValidActiveWorkstreamName(name);
}

/**
 * Convert a display name to a URL/filesystem-safe workstream slug.
 * Lowercases, collapses non-alphanumeric runs to hyphens, strips leading/trailing hyphens.
 */
export function toWorkstreamSlug(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Returns true when `name` is a valid active workstream name:
 * - Must start with alphanumeric
 * - May contain alphanumeric, dots, underscores, hyphens
 * - Must not contain path traversal sequences (..)
 */
export function isValidActiveWorkstreamName(name: string | null | undefined): boolean {
  return validateActiveWorkstreamName(name).ok;
}

export function assertValidActiveWorkstreamName(
  name: string | null | undefined,
  errorMessage: string = INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
): string {
  const validation = validateActiveWorkstreamName(name);
  if (!validation.ok) {
    throw new Error(errorMessage);
  }
  return validation.value!;
}

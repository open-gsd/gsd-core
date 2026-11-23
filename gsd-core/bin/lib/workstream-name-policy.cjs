"use strict";
/**
 * Canonical workstream name validation and slug normalization
 * (ADR-457 build-at-publish: the hand-written bin/lib/workstream-name-policy.cjs
 * collapsed to a TypeScript source of truth). Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Used by active-workstream-store.cjs, planning-workspace.cjs, workstream.cjs.
 *
 * #3883 (ADR-3473 §8.3): toWorkstreamSlug delegates to core-utils.cjs's
 * generateSlugInternal (the canonical slug formula), passing `maxLen: null`
 * to preserve this site's pre-migration untruncated contract — the 60-char
 * default collided distinct >60-char workstream names onto the same slug
 * (verified: `"a".repeat(60)+"alpha"` and `"a".repeat(60)+"beta"` truncated
 * identically). core-utils.cjs already
 * requires (transitively, at module-init time) THIS module:
 * core-utils.cjs -> planning-workspace.cjs -> active-workstream-store.cjs ->
 * workstream-name-policy.cjs. A top-level require of core-utils.cjs here
 * would therefore close that cycle and — per this codebase's compiled-.cjs
 * convention of a single `module.exports = {...}` reassignment at the bottom
 * of core-utils.cjs — capture a stale, still-empty exports object forever
 * (verified live: "generateSlugInternal is not a function" whichever module
 * loads first). The require is deferred (lazy, inside toWorkstreamSlug's
 * body) instead, mirroring the same cycle-break already used by
 * core-utils.cts's own getPhaseFileStats/plan-scan.cjs seam and by
 * phase-id.cts's toDir/getPhaseDirFromPhaseId.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_WORKSTREAM_NAMES = exports.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE = void 0;
exports.isReservedWorkstreamName = isReservedWorkstreamName;
exports.reservedWorkstreamNameMessage = reservedWorkstreamNameMessage;
exports.normalizeWorkstreamNameInput = normalizeWorkstreamNameInput;
exports.hasInvalidPathSegment = hasInvalidPathSegment;
exports.validateActiveWorkstreamName = validateActiveWorkstreamName;
exports.validateWorkstreamName = validateWorkstreamName;
exports.toWorkstreamSlug = toWorkstreamSlug;
exports.isValidActiveWorkstreamName = isValidActiveWorkstreamName;
exports.assertValidActiveWorkstreamName = assertValidActiveWorkstreamName;
exports.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE = 'Invalid workstream name: must be alphanumeric, hyphens, underscores, or dots';
const ACTIVE_WORKSTREAM_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/**
 * Names that pass the charset check but can never name a workstream (#4772).
 * `none` reads as "no workstream" to every caller that types it, yet the path
 * layer treated it as a literal directory, so `--ws none` silently resolved
 * `.planning/workstreams/none/...` (and fell back to the root config). Single
 * owner: resolveActiveWorkstream and workstream create/set all consume this list.
 */
exports.RESERVED_WORKSTREAM_NAMES = Object.freeze(['none']);
/** True when `name` (trimmed, case-insensitive) is a reserved workstream name. */
function isReservedWorkstreamName(name) {
    const value = normalizeWorkstreamNameInput(name);
    return value !== null && exports.RESERVED_WORKSTREAM_NAMES.includes(value.toLowerCase());
}
/**
 * The error text shared by every site that rejects a reserved name. `source`
 * (where the name came from: 'cli' | 'env' | 'store') picks a remedy that can
 * actually be carried out: the rejection happens in the gsd-tools bootstrap
 * before any verb runs, so advising `workstream set --clear` would fail too.
 */
function reservedWorkstreamNameMessage(name, source = null) {
    const value = normalizeWorkstreamNameInput(name) ?? '';
    const remedy = source === 'env'
        ? 'unset GSD_WORKSTREAM for flat mode'
        : source === 'store'
            ? 'delete the stale active-workstream pointer for flat mode'
            : 'omit --ws for flat mode';
    return `Workstream name '${value}' is reserved and cannot name a workstream; ${remedy}`;
}
function normalizeWorkstreamNameInput(name) {
    const value = String(name ?? '').trim();
    return value || null;
}
/**
 * Returns true when `name` contains a path separator, a bare dot, or a
 * dot-dot sequence — any of which would make the name unsafe for use as a
 * filesystem path segment.
 */
function hasInvalidPathSegment(name) {
    const value = String(name ?? '');
    return /[/\\]/.test(value) || value === '.' || value === '..' || value.includes('..');
}
function validateActiveWorkstreamName(name) {
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
function validateWorkstreamName(name) {
    return isValidActiveWorkstreamName(name);
}
/**
 * Convert a display name to a URL/filesystem-safe workstream slug.
 * Lowercases, collapses non-alphanumeric runs to hyphens, strips leading/trailing hyphens.
 */
function toWorkstreamSlug(name) {
    // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
    // (generateSlugInternal, core-utils.cts) rather than re-implementing it —
    // this call site previously diverged from it (no transliteration, no
    // 60-char truncation). Lazy require to break the core-utils.cjs cycle
    // (see the module dependency doc comment above).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return require('./core-utils.cjs').generateSlugInternal(String(name ?? ''), null) ?? '';
}
/**
 * Returns true when `name` is a valid active workstream name:
 * - Must start with alphanumeric
 * - May contain alphanumeric, dots, underscores, hyphens
 * - Must not contain path traversal sequences (..)
 */
function isValidActiveWorkstreamName(name) {
    return validateActiveWorkstreamName(name).ok;
}
function assertValidActiveWorkstreamName(name, errorMessage = exports.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE) {
    const validation = validateActiveWorkstreamName(name);
    if (!validation.ok) {
        throw new Error(errorMessage);
    }
    return validation.value;
}

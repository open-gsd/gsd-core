"use strict";
/**
 * Shared semver comparison utility (ADR-457 pilot: first hand-written
 * bin/lib/*.cjs collapsed to a TypeScript source of truth).
 *
 * Logic is preserved byte-for-behaviour from the prior hand-written
 * `gsd-core/bin/lib/semver-compare.cjs`; only types are added. The
 * normalization policy here is locked by `tests/semver-compare.test.cjs` and
 * consumed by update-check, statusline dev-install detection, and changeset
 * range compare (`scripts/changeset/cli.cjs`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toNumericTuple = toNumericTuple;
exports.compareSemverCore = compareSemverCore;
exports.isSemverNewer = isSemverNewer;
exports.isStableTripletSemver = isStableTripletSemver;
exports.semverSatisfies = semverSatisfies;
function toNumericTuple(input) {
    const cleaned = String(input == null ? '' : input).trim().replace(/^v/, '');
    const base = cleaned.replace(/[-+].*$/, '');
    const parts = base.split('.');
    const major = Number.parseInt(parts[0], 10) || 0;
    const minor = Number.parseInt(parts[1], 10) || 0;
    const patch = Number.parseInt(parts[2], 10) || 0;
    return [major, minor, patch];
}
function compareSemverCore(a, b) {
    const [a0, a1, a2] = toNumericTuple(a);
    const [b0, b1, b2] = toNumericTuple(b);
    if (a0 !== b0)
        return a0 > b0 ? 1 : -1;
    if (a1 !== b1)
        return a1 > b1 ? 1 : -1;
    if (a2 !== b2)
        return a2 > b2 ? 1 : -1;
    return 0;
}
function isSemverNewer(a, b) {
    return compareSemverCore(a, b) > 0;
}
function isStableTripletSemver(v) {
    return /^\d+\.\d+\.\d+$/.test(String(v || '').replace(/^v/, ''));
}
function compareTuples(a, b) {
    if (a[0] !== b[0])
        return a[0] > b[0] ? 1 : -1;
    if (a[1] !== b[1])
        return a[1] > b[1] ? 1 : -1;
    if (a[2] !== b[2])
        return a[2] > b[2] ? 1 : -1;
    return 0;
}
// Parse a version-ish token into a tuple + how many leading numeric parts were
// specified (0 = bare wildcard "*"/"x", 1 = "1", 2 = "1.2", 3 = "1.2.3").
// Returns null if the token is not a parseable partial/full version.
function parseVersionToken(token) {
    const clean = token.trim().replace(/^v/, '').replace(/[-+].*$/, '');
    if (clean === '' || clean === '*' || clean === 'x' || clean === 'X')
        return { tuple: [0, 0, 0], specified: 0 };
    const parts = clean.split('.');
    if (parts.length > 3)
        return null;
    const nums = [];
    let sawWildcard = false;
    for (const p of parts) {
        if (p === 'x' || p === 'X' || p === '*') {
            sawWildcard = true;
            continue;
        }
        // A concrete segment after a wildcard ("1.x.2", "1.*.2") is malformed → fail closed.
        if (sawWildcard)
            return null;
        if (!/^\d+$/.test(p))
            return null;
        nums.push(Number.parseInt(p, 10));
    }
    if (nums.length === 0)
        return { tuple: [0, 0, 0], specified: 0 };
    return { tuple: [nums[0] || 0, nums[1] || 0, nums[2] || 0], specified: nums.length };
}
// Expand a single comparator into primitive (op, tuple) constraints, or null if
// unparseable (→ fail closed).
function expandComparator(c) {
    const trimmed = c.trim();
    if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X')
        return [{ op: '>=', t: [0, 0, 0] }];
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);
    if (!m)
        return null;
    const op = m[1] || '';
    const pv = parseVersionToken(m[2]);
    if (!pv)
        return null;
    const { tuple, specified } = pv;
    const [maj, min, pat] = tuple;
    if (op === '^') {
        let upper;
        if (maj > 0)
            upper = [maj + 1, 0, 0];
        else if (min > 0)
            upper = [0, min + 1, 0];
        else
            upper = [0, 0, pat + 1];
        return [{ op: '>=', t: tuple }, { op: '<', t: upper }];
    }
    if (op === '~') {
        const upper = specified >= 2 ? [maj, min + 1, 0] : [maj + 1, 0, 0];
        return [{ op: '>=', t: tuple }, { op: '<', t: upper }];
    }
    if (op === '' || op === '=') {
        if (specified === 0)
            return [{ op: '>=', t: [0, 0, 0] }]; // "*" → any
        if (specified === 3)
            return [{ op: '=', t: tuple }];
        const upper = specified === 1 ? [maj + 1, 0, 0] : [maj, min + 1, 0];
        return [{ op: '>=', t: tuple }, { op: '<', t: upper }];
    }
    // >= <= > < with an explicit version
    if (specified === 0)
        return null; // e.g. ">=*" is meaningless → fail closed
    return [{ op: op, t: tuple }];
}
function satisfiesPrimitive(v, prim) {
    const cmp = compareTuples(v, prim.t);
    switch (prim.op) {
        case '>=': return cmp >= 0;
        case '<=': return cmp <= 0;
        case '>': return cmp > 0;
        case '<': return cmp < 0;
        case '=': return cmp === 0;
        default: return false;
    }
}
// One whitespace-separated comparator set (ANDed). Fail closed if any comparator
// is unparseable.
function satisfiesSet(v, set) {
    const trimmed = set.trim();
    if (trimmed === '')
        return false;
    const comparators = trimmed.split(/\s+/).filter(Boolean);
    if (comparators.length === 0)
        return false;
    for (const c of comparators) {
        const prims = expandComparator(c);
        if (prims === null)
            return false; // unparseable → fail closed
        for (const prim of prims) {
            if (!satisfiesPrimitive(v, prim))
                return false;
        }
    }
    return true;
}
/**
 * Does `version` satisfy the semver `range`? OR-composed across `||`, AND-composed
 * across whitespace. Fail-closed: an empty range, or any comparator this minimal
 * implementation cannot parse, returns false. Comparison is on the numeric
 * major.minor.patch core (prerelease tags are stripped, per `toNumericTuple`).
 */
function semverSatisfies(version, range) {
    const r = String(range == null ? '' : range).trim();
    if (r === '')
        return false;
    const v = toNumericTuple(version);
    const orSets = r.split('||').map((s) => s.trim()).filter((s) => s.length > 0);
    if (orSets.length === 0)
        return false;
    return orSets.some((set) => satisfiesSet(v, set));
}

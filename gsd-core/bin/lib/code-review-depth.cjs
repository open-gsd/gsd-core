"use strict";
/**
 * Path-scoped code-review depth resolution for #2554 (ADR-457 build-at-publish:
 * a pure TypeScript source of truth compiled to
 * gsd-core/bin/lib/code-review-depth.cjs).
 *
 * Zero I/O, zero clock, zero deps. Resolves the effective review depth
 * (`quick` | `standard` | `deep`) from, in priority order: the `--depth=`
 * invocation flag, the strongest matching path-scoped rule in
 * `workflow.code_review_depth_overrides`, the global `workflow.code_review_depth`
 * config value, and finally the `standard` default — then applies the
 * pre-existing large-scope `deep` → `standard` downgrade.
 *
 * See .gsd/phase/feat-2554-support-path-scoped-code-review-depth-ov/40-design.md
 * for the full behavior table and negative-space notes this module encodes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LARGE_SCOPE_THRESHOLD = exports.DEPTH_TIERS = exports.REASON = void 0;
exports.normalizeRelPath = normalizeRelPath;
exports.ruleMatchesFile = ruleMatchesFile;
exports.resolveCodeReviewDepth = resolveCodeReviewDepth;
exports.REASON = Object.freeze({
    NOT_AN_ARRAY: 'not_an_array',
    RULE_NOT_OBJECT: 'rule_not_object',
    PATHS_MALFORMED: 'paths_malformed',
    INVALID_DEPTH: 'invalid_depth',
    GLOB_UNSUPPORTED: 'glob_unsupported',
    PATH_CONTROL_CHAR: 'path_control_char',
    PATH_TRAVERSAL: 'path_traversal',
    PATH_ABSOLUTE: 'path_absolute',
    PATH_EMPTY: 'path_empty',
});
/** Depth tiers, weakest → strongest. Frozen. */
exports.DEPTH_TIERS = Object.freeze(['quick', 'standard', 'deep']);
/**
 * A `deep` resolution over more than this many changed files downgrades to
 * `standard` (pre-existing scope guard; see gsd-core/workflows/code-review.md).
 */
exports.LARGE_SCOPE_THRESHOLD = 50;
/** True for a non-null, non-array object — the shape a JSON rule entry must have. */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Normalize a repo-relative-ish path for matching: coerce non-strings to '',
 * trim whitespace/CR, convert `\` to `/` unconditionally
 * (RULESET.CONTENT-PATH-NORMALIZATION — never conditional on platform), collapse
 * repeated `/`, strip a leading `repoRoot/` prefix, strip leading `./` segments
 * (repeatably), and strip leading/trailing `/` — but ONLY when the path was
 * relativized against `repoRoot` (or was never absolute to begin with). An
 * absolute input (POSIX `/…` or a Windows drive-absolute `C:/…`) that is not
 * under `repoRoot` stays absolute, so it can never spuriously match a
 * repo-relative rule path in `ruleMatchesFile`. Idempotent.
 */
function normalizeRelPath(p, repoRoot) {
    let value = typeof p === 'string' ? p : '';
    value = value.trim();
    value = value.replace(/\\/g, '/');
    value = value.replace(/\/+/g, '/');
    const isAbsolute = value.startsWith('/') || /^[A-Za-z]:\//.test(value);
    let relativized = false;
    if (typeof repoRoot === 'string' && repoRoot !== '') {
        const rootNormalized = repoRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        if (rootNormalized !== '' && value.startsWith(`${rootNormalized}/`)) { // allow-handrolled-containment: display-path normalization — strips a caller-declared repoRoot prefix so a path renders repo-relative, not a security root-confinement decision
            value = value.slice(rootNormalized.length + 1);
            relativized = true;
        }
    }
    let prev;
    do {
        prev = value;
        if (value.startsWith('./')) {
            value = value.slice(2);
        }
    } while (value !== prev);
    if ((relativized || !isAbsolute) && value.startsWith('/')) {
        value = value.slice(1);
    }
    if (value.endsWith('/') && value !== '/') {
        value = value.slice(0, -1);
    }
    return value;
}
/**
 * Segment-aware match: true iff `filePath === rulePath` or `filePath` starts
 * with `rulePath + '/'`. Both arguments must already be normalized. Case-sensitive.
 */
function ruleMatchesFile(rulePath, filePath) {
    return filePath === rulePath || filePath.startsWith(`${rulePath}/`); // allow-handrolled-containment: rule-to-file segment match for selecting which review-depth rule applies — not a filesystem root-confinement gate
}
/**
 * Validate + normalize a single rule path (not yet matched against files).
 * Check order: glob syntax, interior control character (U+0000-U+001F or
 * U+007F, surviving the leading/trailing trim), `..` traversal segment,
 * absolute (leading `/` with real content, or a Windows drive letter), then
 * empty-after-normalization (covers a bare `/`, `.`, `./`, or whitespace-only
 * path).
 */
function validateRulePath(rawPath) {
    const trimmed = rawPath.trim();
    const slashified = trimmed.replace(/\\/g, '/');
    if (/[*?]/.test(slashified)) {
        return { error: 'GLOB_UNSUPPORTED' };
    }
    if (/[\x00-\x1f\x7f]/.test(slashified)) {
        return { error: 'PATH_CONTROL_CHAR' };
    }
    const collapsed = slashified.replace(/\/+/g, '/');
    const segments = collapsed.split('/');
    if (segments.includes('..')) {
        return { error: 'PATH_TRAVERSAL' };
    }
    const looksAbsolute = slashified.startsWith('/') || /^[A-Za-z]:/.test(slashified);
    let normalized = collapsed;
    let prev;
    do {
        prev = normalized;
        if (normalized.startsWith('./')) {
            normalized = normalized.slice(2);
        }
    } while (normalized !== prev);
    if (normalized.startsWith('/')) {
        normalized = normalized.slice(1);
    }
    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    if (looksAbsolute && normalized !== '' && normalized !== '.') {
        return { error: 'PATH_ABSOLUTE' };
    }
    if (normalized === '' || normalized === '.') {
        return { error: 'PATH_EMPTY' };
    }
    return { error: null, normalized };
}
/** Validate the full `overrides` value. Collects every malformed-rule error, in rule order. */
function validateOverrides(overridesInput) {
    const overridesValue = overridesInput === undefined ? [] : overridesInput;
    if (!Array.isArray(overridesValue)) {
        return { ok: false, errors: [{ reason: exports.REASON.NOT_AN_ARRAY }] };
    }
    const errors = [];
    const rules = [];
    for (let index = 0; index < overridesValue.length; index += 1) {
        const rule = overridesValue[index];
        if (!isPlainObject(rule)) {
            errors.push({ reason: exports.REASON.RULE_NOT_OBJECT, ruleIndex: index });
            continue;
        }
        const hasPaths = Object.prototype.hasOwnProperty.call(rule, 'paths');
        const rawPaths = hasPaths ? rule.paths : undefined;
        if (!Array.isArray(rawPaths)
            || rawPaths.length === 0
            || rawPaths.some((entry) => typeof entry !== 'string')) {
            errors.push({ reason: exports.REASON.PATHS_MALFORMED, ruleIndex: index });
            continue;
        }
        let pathError = null;
        const normalizedPaths = [];
        for (const rawPath of rawPaths) {
            const validation = validateRulePath(rawPath);
            if (validation.error) {
                pathError = { reason: exports.REASON[validation.error], ruleIndex: index, path: rawPath };
                break;
            }
            normalizedPaths.push(validation.normalized);
        }
        if (pathError) {
            errors.push(pathError);
            continue;
        }
        const hasDepth = Object.prototype.hasOwnProperty.call(rule, 'depth');
        const depthValue = hasDepth ? rule.depth : undefined;
        if (typeof depthValue !== 'string' || !exports.DEPTH_TIERS.includes(depthValue)) {
            errors.push({ reason: exports.REASON.INVALID_DEPTH, ruleIndex: index, value: depthValue });
            continue;
        }
        rules.push({ index, paths: normalizedPaths, depth: depthValue });
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true, rules };
}
/** Applies the large-scope `deep` → `standard` downgrade and assembles the ok result. */
function finalize(input) {
    const downgraded = input.resolvedDepth === 'deep' && input.fileCount > exports.LARGE_SCOPE_THRESHOLD;
    const result = {
        ok: true,
        depth: downgraded ? 'standard' : input.resolvedDepth,
        resolvedDepth: input.resolvedDepth,
        source: input.source,
        matchedRule: input.matchedRule,
        downgraded,
        fileCount: input.fileCount,
    };
    if (input.invalidFlagDepth)
        result.invalidFlagDepth = true;
    if (input.invalidConfigDepth)
        result.invalidConfigDepth = true;
    return result;
}
/**
 * Resolve the effective code-review depth. Overrides are always validated
 * first, even when the `--depth=` flag would win outright — a malformed
 * config must never silently pass through unreported. See the design doc's
 * behavior table for the full row-by-row contract.
 */
function resolveCodeReviewDepth(input) {
    const { flagDepth, configDepth, overrides, files, repoRoot } = input;
    const validated = validateOverrides(overrides);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }
    const rules = validated.rules;
    if (typeof flagDepth === 'string' && flagDepth !== '') {
        if (exports.DEPTH_TIERS.includes(flagDepth)) {
            return finalize({
                resolvedDepth: flagDepth,
                source: 'flag',
                matchedRule: null,
                fileCount: files.length,
            });
        }
        return finalize({
            resolvedDepth: 'standard',
            source: 'flag',
            matchedRule: null,
            fileCount: files.length,
            invalidFlagDepth: true,
        });
    }
    const normalizedFiles = files.map((f) => normalizeRelPath(f, repoRoot));
    let best = null;
    let bestTierIndex = -1;
    for (const rule of rules) {
        const tierIndex = exports.DEPTH_TIERS.indexOf(rule.depth);
        let matchedPath = null;
        for (const rulePath of rule.paths) {
            if (normalizedFiles.some((file) => ruleMatchesFile(rulePath, file))) {
                matchedPath = rulePath;
                break;
            }
        }
        if (matchedPath === null)
            continue;
        if (best === null || tierIndex > bestTierIndex) {
            best = { index: rule.index, path: matchedPath, depth: rule.depth };
            bestTierIndex = tierIndex;
        }
    }
    if (best !== null) {
        return finalize({
            resolvedDepth: best.depth,
            source: 'rule',
            matchedRule: best,
            fileCount: files.length,
        });
    }
    // No rule matched this file set. Provenance depends solely on whether a
    // global config depth was configured — the presence, absence, or emptiness
    // of `overrides` has no bearing here (a validly-configured rule set that
    // simply didn't match this review is indistinguishable, for provenance
    // purposes, from no rule set at all).
    if (typeof configDepth === 'string' && configDepth !== '') {
        if (exports.DEPTH_TIERS.includes(configDepth)) {
            return finalize({
                resolvedDepth: configDepth,
                source: 'config',
                matchedRule: null,
                fileCount: files.length,
            });
        }
        return finalize({
            resolvedDepth: 'standard',
            source: 'config',
            matchedRule: null,
            fileCount: files.length,
            invalidConfigDepth: true,
        });
    }
    return finalize({
        resolvedDepth: 'standard',
        source: 'default',
        matchedRule: null,
        fileCount: files.length,
    });
}

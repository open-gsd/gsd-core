"use strict";
/**
 * Review Reviewer Selection Module (ADR-457 build-at-publish: the hand-written
 * bin/lib/review-reviewer-selection.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Owns reviewer-selection policy projection for /gsd:review:
 * explicit flags > --all > review.default_reviewers > all detected.
 *
 * Reviewer instances (#1517): a bounded config surface
 * `review.reviewer_instances.<name> = {cli, model?, agent?}` lets one
 * model-capable adapter (e.g. opencode) run as several independent reviewer
 * identities. Instances participate ONLY in the config_default branch (no
 * per-instance CLI flags). An instance is available iff its base `cli` is
 * detected. The instance→cli mapping lives HERE (single source; see the parity
 * test in tests/review-reviewer-instances.test.cjs — DEFECT.GENERATIVE-FIX).
 *
 * KNOWN_REVIEWER_SLUGS (ADR-2782 D9, Phase 5a #2798): derived from declared
 * `reviewer` bodies in the capability registry, not a hand-maintained tail.
 * A capability of EITHER `role: "runtime"` (the six dual-purpose hosts —
 * antigravity/claude/codex/cursor/opencode/qwen) or the lane-only
 * `role: "reviewer"` (coderabbit/ollama/lm_studio/llama_cpp) may carry
 * a `reviewer` body, and it is the body's `reviewer.slug` — NOT the capability
 * id — that becomes the roster entry: the two differ for `lm-studio` (id) /
 * `lm_studio` (slug) and `llama-cpp` (id) / `llama_cpp` (slug), ADR-2782's
 * three-namespace trap (`id` must be kebab; `slug` keeps the shipped roster's
 * snake form).
 *
 * `runtime.hostBehaviors.reviewerCli` is GONE (Phase 7, #2801). It survived one
 * release as a derived legacy alias — a capability setting only the flag
 * contributed its capability id as a slug — and that window closed when 1.10.0
 * shipped after Phase 5a's 1.9.0. A declared `reviewer` body is now the ONLY
 * route onto the roster. A manifest still carrying the key contributes no lane
 * and is told so: `collectReviewerWarnings`
 * (`gsd-core/bin/lib/capability-validator.cjs`) emits a removal notice on both
 * the build-time registry generation and the third-party overlay load path.
 *
 * Before this phase the five non-runtime reviewers (`gemini`, `coderabbit`,
 * `ollama`, `lm_studio`, `llama_cpp`) had no `capabilities/<id>/` descriptor at
 * all and were a hardcoded `NON_RUNTIME_REVIEWER_SLUGS` tail. Phase 5a gives
 * each one a lane-only `role: "reviewer"` capability (ADR-2782 D3), so the
 * tail is deleted outright. See
 * `docs/adr/2782-reviewer-lane-capability-surface.md`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.INSTANCE_NAME_PATTERN = exports.KNOWN_REVIEWER_SLUGS = void 0;
exports.deriveReviewerSlugs = deriveReviewerSlugs;
exports.normalizeConfiguredDefaultReviewers = normalizeConfiguredDefaultReviewers;
exports.normalizeReviewerInstances = normalizeReviewerInstances;
exports.resolveReviewerSelection = resolveReviewerSelection;
/**
 * Derive the reviewer-slug roster from a capability registry.
 *
 * Exported (rather than a require()-time-only side effect) so tests can
 * exercise the derivation directly against a synthetic registry — the real
 * roster below is a single call against the generated
 * `capability-registry.cjs`, and `tests/review-lane-descriptor.test.cjs`'s
 * `checkReviewerLaneParity` separately guards that the real roster still
 * agrees with `src/review-lane-descriptor.cts` and the workflow.
 *
 * Reads `registry.capabilities` — every declared capability regardless of
 * role — because a `role: "reviewer"` lane-only capability is never stored in
 * `registry.runtimes` (that map is role:"runtime" only). A capability
 * contributes exactly one slug — its declared `reviewer.slug` — or none. The
 * result is collected into a Set (so a slug can never appear twice, even if
 * two distinct capabilities somehow named the same one) and returned as a
 * SORTED array, so the roster's order never depends on `Object.values()`
 * iteration / registry build order.
 */
function deriveReviewerSlugs(registry) {
    const capabilities = registry.capabilities || {};
    const slugs = new Set();
    for (const cap of Object.values(capabilities)) {
        // Trim before the emptiness test: `length > 0` alone admits a whitespace-only
        // slug ("   ") verbatim into the roster, where it can never match a real lane
        // but still occupies a roster entry. Unreachable through the checked-in
        // registry today, but this function is EXPORTED for reuse and carries no
        // other validation, so it should not depend on its caller's hygiene.
        const rawSlug = cap?.reviewer?.slug;
        const declaredSlug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
        if (declaredSlug.length > 0)
            slugs.add(declaredSlug);
    }
    return [...slugs].sort();
}
/**
 * The roster, derived once at module load.
 *
 * GUARDED, because this runs at `require()` time: an uncaught throw here does not
 * degrade reviewer selection, it breaks `require()` of this module for EVERY
 * consumer. The sibling `capability-trust.cjs` already holds this line — its
 * `discloseExecutableSurfaces` is documented "TOTAL: never throws, for any
 * manifest shape" and wrapped accordingly — and this module handles the same
 * class of registry-derived input, so it should not be the asymmetric one.
 *
 * A malformed registry yields an EMPTY roster rather than a crash. That is a
 * visible degradation, not a silent one: under ADR-2782 D4 an explicitly
 * requested reviewer that is unavailable is an ERROR, so `/gsd:review --claude`
 * against an empty roster fails loudly instead of quietly reviewing with nobody.
 *
 * Unreachable through the checked-in registry today (it is generated, JSON-sourced
 * and code-reviewed, so it cannot carry a getter or a Proxy). Guarded anyway —
 * reachability analysis is not a contract, and the next caller should not have to
 * redo it.
 */
exports.KNOWN_REVIEWER_SLUGS = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return deriveReviewerSlugs(require('./capability-registry.cjs'));
    }
    catch {
        return [];
    }
})();
/**
 * #5359: map a lane flag alias (`agy` for `--agy`) to its canonical slug via the
 * descriptor roster's declared `flags` (same source as `review-lane explicit-from-argv`).
 * Guarded like KNOWN_REVIEWER_SLUGS: a load failure degrades to the plain error.
 */
function laneSlugForAlias(name, lanes) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const roster = lanes ?? require('./review-lane-descriptor.cjs').REVIEWER_LANES;
        // `l.slug !== name`: an undetected canonical slug (`--codex` flag) is not an alias.
        return roster.find((l) => l.slug !== name && l.flags.includes(`--${name}`))?.slug;
    }
    catch {
        return undefined;
    }
}
/** Instance names are lowercase slugs that must not shadow a built-in slug. */
exports.INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
function normalizeConfiguredDefaultReviewers(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return { absent: true, values: [], errors: [] };
    }
    if (!Array.isArray(rawValue)) {
        return {
            absent: false,
            values: [],
            errors: ['review.default_reviewers must be a JSON array of reviewer slugs'],
        };
    }
    if (rawValue.length === 0) {
        return {
            absent: false,
            values: [],
            errors: ['review.default_reviewers cannot be empty'],
        };
    }
    const seen = new Set();
    const normalized = [];
    const errors = [];
    for (const item of rawValue) {
        if (typeof item !== 'string') {
            errors.push('review.default_reviewers must contain only string slugs');
            continue;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(item)) {
            errors.push(`invalid reviewer slug in review.default_reviewers: ${item}`);
            continue;
        }
        const slug = item.toLowerCase();
        if (!seen.has(slug)) {
            seen.add(slug);
            normalized.push(slug);
        }
    }
    return { absent: false, values: normalized, errors };
}
/**
 * Validate the `review.reviewer_instances` config object (#1517).
 * `cli` MUST be a known adapter (never an arbitrary shell command — Kerckhoffs /
 * Postel: strict at the invocation boundary). `model`/`agent` are opaque
 * pass-through strings; they are never interpolated into shell strings by this
 * module. Instance names must not collide with a built-in slug.
 */
function normalizeReviewerInstances(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return { instances: {}, errors: [] };
    }
    if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return {
            instances: {},
            errors: ['review.reviewer_instances must be a JSON object mapping instance names to {cli,model,agent}'],
        };
    }
    const obj = rawValue;
    const instances = {};
    const errors = [];
    for (const [name, spec] of Object.entries(obj)) {
        if (!exports.INSTANCE_NAME_PATTERN.test(name)) {
            errors.push(`invalid reviewer instance name '${name}': must match ^[a-z0-9][a-z0-9-]*$`);
            continue;
        }
        if (exports.KNOWN_REVIEWER_SLUGS.includes(name)) {
            errors.push(`reviewer instance name '${name}' must not equal a built-in reviewer slug`);
            continue;
        }
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
            errors.push(`reviewer_instances.${name} must be an object with at least {cli}`);
            continue;
        }
        const s = spec;
        const cli = s.cli;
        if (typeof cli !== 'string' || !exports.KNOWN_REVIEWER_SLUGS.includes(cli)) {
            errors.push(`reviewer_instances.${name}.cli must be a known reviewer adapter (got: ${JSON.stringify(cli)})`);
            continue;
        }
        const instance = { cli };
        if (s.model !== undefined && s.model !== null) {
            if (typeof s.model !== 'string') {
                errors.push(`reviewer_instances.${name}.model must be a string`);
                continue;
            }
            instance.model = s.model;
        }
        if (s.agent !== undefined && s.agent !== null) {
            if (typeof s.agent !== 'string') {
                errors.push(`reviewer_instances.${name}.agent must be a string`);
                continue;
            }
            instance.agent = s.agent;
        }
        instances[name] = instance;
    }
    return { instances, errors };
}
function resolveReviewerSelection(input) {
    const detected = new Set((input.detected ?? []).map((v) => String(v).toLowerCase()));
    const explicitFlags = new Set((input.explicitFlags ?? []).map((v) => String(v).toLowerCase()));
    const allFlag = !!input.allFlag;
    const normalizedDefaults = normalizeConfiguredDefaultReviewers(input.configuredDefaultReviewers);
    const normalizedInstances = normalizeReviewerInstances(input.reviewerInstances);
    const instances = normalizedInstances.instances;
    const instancesConfigured = Object.keys(instances).length > 0;
    const warnings = [];
    const infos = [];
    const errors = [...normalizedDefaults.errors, ...normalizedInstances.errors];
    let source = 'no_config_all_detected';
    let selected = [];
    if (explicitFlags.size > 0) {
        source = 'explicit_flags';
        // ADR-2782 D4: absent-safe governs DISCOVERY, never explicit selection.
        // Not finding a lane nobody asked for is normal; failing to run a lane
        // somebody asked for is an error. Every miss used to be an `info`, so a
        // PARTIAL miss (`--codex --qwen` with qwen absent) ran the review with a
        // thinner reviewer set while present_results reported success — "a cross-AI
        // review that silently drops a lane is blind in one eye" (review.md).
        // A total miss already errored, but only as a side effect of the selected
        // set being empty; the partial case had no signal at all.
        const priorErrorCount = errors.length;
        selected = [...explicitFlags].filter((slug) => detected.has(slug));
        // Sorted so the error order does not depend on flag order on the command line.
        const missing = [...explicitFlags].filter((slug) => !detected.has(slug)).sort();
        for (const slug of missing) {
            const canonical = laneSlugForAlias(slug, input.lanes);
            errors.push(canonical
                ? `explicit reviewer '${slug}' is a flag alias; pass its canonical slug '${canonical}'`
                : `explicit reviewer '${slug}' is not available on this host`);
        }
        // Guarded on the error count as it stood BEFORE this branch, so the
        // aggregate message fires under exactly the conditions it did previously.
        // Guarding on `errors.length` would let the per-slug errors just pushed
        // suppress it, silently dropping a message this change did not intend to
        // remove.
        if (selected.length === 0 && priorErrorCount === 0) {
            errors.push('no selected reviewers are available for explicit flags');
        }
    }
    else if (allFlag) {
        source = 'all_flag';
        selected = [...detected];
    }
    else if (!normalizedDefaults.absent) {
        source = 'config_default';
        // #1517: expand instance references BEFORE the built-in-slug check. An
        // instance name and a built-in slug are the two legal kinds of entry.
        for (const entry of normalizedDefaults.values) {
            if (instances[entry]) {
                // Instance reference — available iff its base cli is detected.
                const cli = instances[entry].cli;
                if (!detected.has(cli)) {
                    infos.push(`configured instance ${entry} not detected (cli ${cli} missing on this host)`);
                }
                else {
                    selected.push(entry);
                }
            }
            else if (exports.KNOWN_REVIEWER_SLUGS.includes(entry)) {
                if (!detected.has(entry)) {
                    infos.push(`configured reviewers not detected on this host: ${entry}`);
                }
                else {
                    selected.push(entry);
                }
            }
            else {
                // Neither a defined instance nor a built-in slug.
                if (instancesConfigured) {
                    // Most likely a typo'd instance name — must be loud (#1517 design Q2).
                    errors.push(`reviewer instance '${entry}' referenced in review.default_reviewers is not defined in review.reviewer_instances`);
                }
                else {
                    // Backward-compatible behaviour: unknown slug with no instances
                    // configured warns and is dropped.
                    warnings.push(`unknown reviewer slug in review.default_reviewers: ${entry}`);
                }
            }
        }
        if (selected.length === 0 && errors.length === 0) {
            errors.push('all configured default reviewers are unavailable on this host');
        }
    }
    else {
        selected = [...detected];
    }
    const selectedSorted = selected.sort();
    // Single-source instance→cli resolution projected onto the selected set.
    const resolvedInstances = selectedSorted.map((identity) => {
        const inst = instances[identity];
        if (inst) {
            return {
                identity,
                kind: 'instance',
                cli: inst.cli,
                model: inst.model,
                agent: inst.agent,
            };
        }
        return { identity, kind: 'builtin', cli: identity };
    });
    const cliCounts = {};
    for (const r of resolvedInstances) {
        if (r.kind === 'instance') {
            cliCounts[r.cli] = (cliCounts[r.cli] ?? 0) + 1;
        }
    }
    const sharedAdapterCaveat = Object.values(cliCounts).some((c) => c >= 2);
    return {
        source,
        selected: selectedSorted,
        warnings,
        infos,
        errors,
        resolvedInstances,
        sharedAdapterCaveat,
    };
}

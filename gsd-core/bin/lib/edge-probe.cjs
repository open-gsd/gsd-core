"use strict";
/**
 * Spec-completeness edge-probe — the FIRST adapter of the probe-core resolution model
 * (ADR-457 build model; ADR-550 Decision 7 seam).
 *
 * The generic resolution lifecycle, the status×verification re-cut, `validateResolution`,
 * `validateRequirement`, the `analyzeCoverage` merge/rollup/orphan-reject engine, and the
 * `runProbeCli` scaffold all live in `src/probe-core.cts`. This module keeps ONLY the
 * edge-specific cluster: the five data/behavior shapes, the closed 8-category edge taxonomy,
 * shape classification, edge proposal, and the `{ explicit, backstop }` verification validators.
 *
 * Authored as strict TypeScript (`src/edge-probe.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/edge-probe.cjs`. Do NOT hand-write the `.cjs`; it is emitted. Tests
 * `require()` the built artifact; `pretest` runs `build:lib` first.
 *
 * Pure and dependency-free: it classifies each requirement's data/behavior shape, filters
 * the closed 8-category edge taxonomy to applicable categories, proposes concrete candidate
 * edges, and (via probe-core) merges author resolutions into a coverage report.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EDGE_VALIDATORS = exports.UNCLASSIFIED_CATEGORY = exports.TAXONOMY = exports.VALID_SHAPES = exports.SHAPE_CUES = void 0;
exports.classifyShape = classifyShape;
exports.applicableCategories = applicableCategories;
exports.validateRequirement = validateRequirement;
exports.validateResolution = validateResolution;
exports.proposeEdges = proposeEdges;
exports.analyzeCoverage = analyzeCoverage;
const probe_core_cjs_1 = require("./probe-core.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliExitModule = require("./cli-exit.cjs");
const { runMain } = cliExitModule;
/**
 * Word-boundary cues mapping requirement prose -> data/behavior shape.
 * Heuristic and intentionally lossy; an authored `shapes` array overrides it.
 */
exports.SHAPE_CUES = {
    'numeric-range': /\b(round(ing|ed)?|threshold|max(imum)?|min(imum)?|limit|bound(ary)?|between|cap|percent|amount|price|count|number|score|rate|decimal)\b/i,
    'collection': /\b(lists?|arrays?|sets?|items?|collections?|each|every|all|sort(ed|ing)?|merge|dedupe|group|ranges?|intervals?|overlap(ping)?)\b/i,
    'text': /\b(string|text|names?|labels?|truncate|substring|char(acter)?s?|length|slug|message|unicode)\b/i,
    'stateful': /\b(save|persist|store|update|toggle|create|delete|remove|submit|retry|apply|register|insert)\b/i,
    'io': /\b(files?|requests?|fetch|upload|download|network|api|endpoints?|connections?|sockets?)\b/i,
};
/** The locked shape vocabulary — exactly the keys of SHAPE_CUES (single source of truth). */
exports.VALID_SHAPES = new Set(Object.keys(exports.SHAPE_CUES));
/** Detect which shapes a requirement's prose matches (heuristic). */
function classifyShape(text) {
    const shapes = [];
    const subject = String(text == null ? '' : text);
    for (const shape of Object.keys(exports.SHAPE_CUES)) {
        if (exports.SHAPE_CUES[shape].test(subject))
            shapes.push(shape);
    }
    return shapes;
}
/**
 * Closed taxonomy of 8 domain-boundary edge categories (established QA names).
 * `shapes` lists which requirement shapes make the category relevant.
 */
exports.TAXONOMY = [
    { id: 'boundary', name: 'Boundary values', shapes: ['numeric-range'], probe: 'What happens exactly at each min/max/threshold — and one step either side?' },
    { id: 'adjacency', name: 'Adjacency / touching', shapes: ['collection'], probe: 'When two things are exactly equal or just touch, do they merge, collide, or separate?' },
    { id: 'empty', name: 'Empty / degenerate', shapes: ['collection', 'text'], probe: 'What is the result for empty, single-element, or null input?' },
    { id: 'encoding', name: 'Encoding / representation', shapes: ['text'], probe: 'Whose definition of length/equality applies — bytes, code points, grapheme clusters, or normalized form?' },
    { id: 'ordering', name: 'Ordering / stability', shapes: ['collection'], probe: 'When elements compare equal, is output order specified and stable?' },
    { id: 'precision', name: 'Precision / overflow', shapes: ['numeric-range'], probe: 'Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract (e.g. half-up vs half-to-even, ceil/floor/truncate)?' },
    { id: 'idempotency', name: 'Idempotency / repetition', shapes: ['stateful'], probe: 'What happens if this runs twice on the same input?' },
    { id: 'concurrency', name: 'Concurrency / effect ordering', shapes: ['stateful', 'io'], probe: 'If interrupted or run in parallel, what is guaranteed?' },
];
/** Return taxonomy category ids whose applicable shapes intersect the input set. */
function applicableCategories(shapes) {
    const set = new Set(shapes);
    return exports.TAXONOMY.filter((c) => c.shapes.some((s) => set.has(s))).map((c) => c.id);
}
/**
 * The edge adapter's injected runtime validators (ADR-550 #5). `categories` is the closed
 * taxonomy; both verification tiers require a non-empty `resolution` (an explicit AC's text
 * or a backstop note) so plan-phase has a criterion to lift.
 */
/**
 * Pseudo-category for a requirement whose prose matched NO shape cue (#1110). It is a soft
 * "review manually" signal, NOT a 9th taxonomy category: it stays out of `TAXONOMY` (the closed
 * eight) and only joins `EDGE_VALIDATORS.categories` so `analyzeCoverage` accepts the item.
 */
exports.UNCLASSIFIED_CATEGORY = 'unclassified';
const UNCLASSIFIED_PROBE = 'unclassified — review manually';
exports.EDGE_VALIDATORS = {
    categories: [...exports.TAXONOMY.map((c) => c.id), exports.UNCLASSIFIED_CATEGORY],
    verification: ['explicit', 'backstop'],
    requiredFieldsByVerification: { explicit: ['resolution'], backstop: ['resolution'] },
};
/**
 * Validate a single requirement — the generic id/text checks (probe-core) plus the edge's
 * `shapes`-must-be-an-array check. A bare string like `shapes:"numeric-range"` would otherwise
 * fall through to prose classification, silently ignoring the authored override.
 *
 * The edge adapter's `text` is REQUIRED (the prose is the classification signal), so reject a
 * missing/empty `text` when no authored `shapes` override is present. Without this, a `{ id }`
 * requirement classifies to zero shapes → zero edges → it is silently DROPPED from coverage
 * with no signal — the exact fail-open this feature exists to eliminate. An explicit `shapes`
 * array (including `[]` for "no applicable categories") is the legitimate way to opt out of
 * prose classification, so `text` is only required when `shapes` is absent.
 */
function validateRequirement(requirement) {
    (0, probe_core_cjs_1.validateRequirement)(requirement);
    const r = requirement;
    if (r.shapes != null && !Array.isArray(r.shapes)) {
        throw new Error(`requirement ${requirement.id} shapes must be an array when present`);
    }
    if (r.shapes == null && !(typeof r.text === 'string' && r.text.trim())) {
        throw new Error(`requirement ${requirement.id} text must be a non-empty string when no shapes override is provided`);
    }
    // text_en (#3717) is optional, but when present it must be a non-empty string. An empty
    // string is NOT caught by `??` (only null/undefined are), so an unvalidated `text_en: ''`
    // would silently win `text_en ?? text` and classify against '' — the same fail-open shape
    // #1110/#2773 already exist to eliminate, just moved one field over. Validated
    // unconditionally (not gated on whether `shapes` will make it unused) so bad data fails
    // closed even when it happens to be dead for this particular call.
    if (r.text_en != null && !(typeof r.text_en === 'string' && r.text_en.trim())) {
        throw new Error(`requirement ${requirement.id} text_en must be a non-empty string when present`);
    }
}
/** Validate an edge resolution against the edge verification vocabulary. */
function validateResolution(resolution) {
    return (0, probe_core_cjs_1.validateResolution)(resolution, exports.EDGE_VALIDATORS);
}
/**
 * Propose candidate edges for a requirement. Uses authored `shapes` when present, else
 * classifies from prose. Every proposed edge starts unresolved (verification null).
 */
function proposeEdges(requirement) {
    validateRequirement(requirement);
    let shapes;
    if (Array.isArray(requirement.shapes)) {
        // Fail closed: an authored array must contain only locked shape values. A non-empty
        // but invalid array (e.g. ['numeric'], a typo for 'numeric-range') would otherwise
        // intersect no category and silently suppress every probe — the gate reads green while
        // nothing was checked. An empty array stays a valid "no applicable categories" override.
        for (const s of requirement.shapes) {
            if (typeof s !== 'string' || !exports.VALID_SHAPES.has(s)) {
                throw new Error(`invalid shape ${JSON.stringify(s)} for requirement ${requirement.id} — must be one of: ${[...exports.VALID_SHAPES].join(', ')}`);
            }
        }
        shapes = requirement.shapes;
    }
    else {
        // #3717: prefer the English translation when present — SHAPE_CUES are English-only
        // word-boundary patterns, so a non-English `text` (e.g. response_language projects)
        // would otherwise classify to zero shapes. validateRequirement (called above) has
        // already guaranteed text_en, if present, is a non-empty string.
        shapes = classifyShape(requirement.text_en ?? requirement.text);
        if (shapes.length === 0) {
            // Prose present but no shape cue matched. Do NOT silently drop it (#1110): an
            // edge-relevant requirement whose phrasing missed every cue would otherwise vanish from
            // coverage with no signal — the exact blind spot this probe exists to catch. Surface ONE
            // soft, dismissible "unclassified — review manually" candidate. The explicit `shapes: []`
            // opt-out (handled above) stays silent — that is the author's deliberate "no edge surface".
            return [{
                    requirement_id: requirement.id,
                    category: exports.UNCLASSIFIED_CATEGORY,
                    status: 'unresolved',
                    verification: null,
                    resolution: null,
                    reason: null,
                    probe: UNCLASSIFIED_PROBE,
                }];
        }
    }
    return applicableCategories(shapes).map((catId) => {
        const cat = exports.TAXONOMY.find((c) => c.id === catId);
        return {
            requirement_id: requirement.id,
            category: catId,
            status: 'unresolved',
            verification: null,
            resolution: null,
            reason: null,
            probe: cat ? cat.probe : '',
        };
    });
}
/**
 * Propose edges for every requirement (deterministic propose), then delegate the
 * merge/rollup/orphan-reject to probe-core. Edge-specific pre-checks: requirements must be an
 * array, requirement ids must be unique. Throws on any invalid resolution.
 */
function analyzeCoverage(requirements, resolutions = []) {
    if (!Array.isArray(requirements)) {
        throw new Error('requirements must be an array');
    }
    const items = [];
    const seenReqIds = new Set();
    for (const req of requirements) {
        validateRequirement(req);
        if (seenReqIds.has(req.id)) {
            throw new Error(`duplicate requirement id ${JSON.stringify(req.id)}`);
        }
        seenReqIds.add(req.id);
        for (const edge of proposeEdges(req))
            items.push(edge);
    }
    return (0, probe_core_cjs_1.analyzeCoverage)(items, resolutions, exports.EDGE_VALIDATORS);
}
/*
 * CLI entry (EP-06 invokable surface): `edge-probe.cjs <requirements.json> [resolutions.json]`.
 * The generic I/O plumbing (parse, fail-closed exit 2, pretty-JSON out) lives in probe-core's
 * `runProbeCli`; the edge adapter supplies its `analyzeCoverage`. Guarded by
 * `require.main === module` so it runs only when the compiled `.cjs` is executed directly.
 */
if (require.main === module) {
    // runProbeCli's default `exit` now throws ExitError (src/probe-core.cts) rather
    // than calling process.exit directly, so this entry point must run under
    // runMain to translate that throw into process.exitCode.
    runMain(() => {
        (0, probe_core_cjs_1.runProbeCli)((requirements, resolutions) => analyzeCoverage(requirements, resolutions), { usage: 'edge-probe.cjs <requirements.json> [resolutions.json]' });
    });
}

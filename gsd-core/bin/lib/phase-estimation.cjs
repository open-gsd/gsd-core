"use strict";
/**
 * Phase Estimation — estimate/actuals schema, smart-zone threshold policy, and
 * estimate-vs-actual calibration.
 *
 * Epic #1952, Phase 1 (#2630). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * Pure functions only — no I/O, no config reads. Callers supply the budget and
 * the raw calibration document; this module decides policy over them. The CLI
 * seam (gsd-tools) owns reading `.planning/config.json` and
 * `.planning/estimation-calibration.json`.
 *
 * Two properties this module exists to preserve, both from ADR-2629:
 *
 *   1. Every signal is EXOGENOUS. The correction routes on a measured
 *      actual/estimate ratio; `confidence` routes on a calibration sample
 *      count. Nothing routes on a model's self-assessment. This project
 *      measured self-rated confidence and found it weak
 *      (gsd-core/references/honest-verifier.md:25-29 — "on a true blind spot it
 *      stays confidently wrong"), which is why deriveConfidence() takes a
 *      sample count and there is no "how sure are you?" input anywhere here.
 *
 *   2. Estimate and actual share ONE measurement scale — estimateTokens() from
 *      prompt-budget. A ratio between two different measurement methods would
 *      measure the methods, not the miss. measureTokens() below is the single
 *      re-export so no consumer reaches for a second estimator.
 *
 * ADR-457 build-at-publish: source here, compiled to
 * gsd-core/bin/lib/phase-estimation.cjs (gitignored).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CALIBRATION_SCHEMA_VERSION = exports.CALIBRATION_FACTOR_MAX = exports.CALIBRATION_FACTOR_MIN = exports.CONFIDENCE_HIGH_MIN_SAMPLES = exports.CONFIDENCE_MED_MIN_SAMPLES = exports.MIN_CALIBRATION_SAMPLES = exports.CONFIDENCE_VALUES = void 0;
exports.asRawTokens = asRawTokens;
exports.asCalibratedTokens = asCalibratedTokens;
exports.measureTokens = measureTokens;
exports.deriveConfidence = deriveConfidence;
exports.classifyAgainstBudget = classifyAgainstBudget;
exports.computeCalibration = computeCalibration;
exports.applyCalibration = applyCalibration;
exports.extractFrontmatterBlock = extractFrontmatterBlock;
exports.parseEstimate = parseEstimate;
exports.parseActuals = parseActuals;
exports.renderEstimate = renderEstimate;
exports.calibrationBasis = calibrationBasis;
exports.renderActuals = renderActuals;
exports.parseCalibrationDocument = parseCalibrationDocument;
exports.renderCalibrationDocument = renderCalibrationDocument;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- prompt-budget.cjs is an export= CommonJS module
const promptBudget = require("./prompt-budget.cjs");
const frontmatter_fence_cjs_1 = require("./frontmatter-fence.cjs");
const { estimateTokens } = promptBudget;
/**
 * Assert that a bare number is an UNCORRECTED projection.
 *
 * Call this only where a number crosses a trust boundary carrying a basis the
 * type system cannot see — argv, disk frontmatter, a persisted document. The
 * parameter type refuses a `CalibratedTokens`, so a corrected figure cannot be
 * laundered back into the basis; without that the brand would be decorative and
 * #2632 would be one keystroke away again.
 */
function asRawTokens(tokens) {
    return tokens;
}
/** Assert that a bare number already has the correction applied. Refuses a `RawTokens`. */
function asCalibratedTokens(tokens) {
    return tokens;
}
exports.CONFIDENCE_VALUES = Object.freeze(['low', 'med', 'high']);
/** Below this many calibration samples, no correction is applied (ADR-2629 Decision 4). */
exports.MIN_CALIBRATION_SAMPLES = 3;
/** Sample-count thresholds for derived confidence (ADR-2629 Decision 1). */
exports.CONFIDENCE_MED_MIN_SAMPLES = 3;
exports.CONFIDENCE_HIGH_MIN_SAMPLES = 6;
/** Correction-factor clamp. Outside this range the estimator is wrong in kind, not degree. */
exports.CALIBRATION_FACTOR_MIN = 0.5;
exports.CALIBRATION_FACTOR_MAX = 3.0;
/** Schema version for the persisted calibration document. */
exports.CALIBRATION_SCHEMA_VERSION = 1;
/**
 * A positive, finite, safe integer. Rejects NaN, Infinity, negatives, zero,
 * non-integers, and anything past MAX_SAFE_INTEGER (where integer arithmetic
 * silently stops being exact).
 */
function isPositiveInt(value) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}
function isPositiveFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function isConfidence(value) {
    return typeof value === 'string' && exports.CONFIDENCE_VALUES.includes(value);
}
/**
 * A usable calibration sample: both sides present, positive, and finite.
 * A zero or negative estimate would divide to Infinity or flip the ratio's
 * sign, so those are dropped rather than coerced.
 */
function isCalibrationSample(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    // The RawTokens brand on estimateTokens is asserted here, at the disk trust
    // boundary — a persisted sample's basis is a fact about the writer, and the
    // only writers are collectCalibrationSamples() (which reads it through
    // calibrationBasis()) and this module's own renderCalibrationDocument().
    return isPositiveFinite(record['estimateTokens']) && isPositiveFinite(record['actualTokens']);
}
/**
 * Measure text on the canonical scale. The ONE estimator both the estimate and
 * the actuals must use — see property 2 in the module header.
 */
function measureTokens(text) {
    return estimateTokens(text);
}
/**
 * Derive confidence from how much measured history backs the estimate.
 *
 * Exogenous by construction: the input is a count, not a judgment. A non-integer
 * or negative count degrades to 'low' rather than throwing — an unusable history
 * is exactly the low-confidence case.
 */
function deriveConfidence(sampleCount) {
    if (typeof sampleCount !== 'number' || !Number.isFinite(sampleCount) || sampleCount < 0)
        return 'low';
    if (sampleCount >= exports.CONFIDENCE_HIGH_MIN_SAMPLES)
        return 'high';
    if (sampleCount >= exports.CONFIDENCE_MED_MIN_SAMPLES)
        return 'med';
    return 'low';
}
/**
 * Classify an estimate against the smart-zone budget.
 *
 * Boundary contract (ADR-2629 Decision 3 + RULESET.TESTS.boundary-coverage.fixtures):
 * budget-1 → under, budget → under, budget+1 → over. The comparison is strictly
 * greater-than, so landing exactly on the budget is not a violation.
 *
 * An unusable budget (hand-edited config, missing key) never fabricates a
 * violation: it reports budgetValid=false and overBudget=false, so a broken
 * config cannot spam split recommendations.
 */
function classifyAgainstBudget(estimate, budget) {
    // Kept for untyped `.cjs` callers — see the note in applyCalibration. A
    // hand-edited config reaches `budget` as anything at runtime regardless of
    // what the TypeScript signature promises.
    if (!isPositiveFinite(budget) || !isPositiveFinite(estimate)) {
        return { overBudget: false, ratio: 0, recommendation: null, budgetValid: isPositiveFinite(budget) };
    }
    const ratio = estimate / budget;
    if (estimate <= budget) {
        return { overBudget: false, ratio, recommendation: null, budgetValid: true };
    }
    const slices = Math.ceil(ratio);
    return {
        overBudget: true,
        ratio,
        recommendation: `Estimated ${estimate} tokens exceeds the ${budget}-token smart-zone budget `
            + `(${ratio.toFixed(2)}x). Consider splitting this phase into about ${slices} `
            + `slices — a tracer plus ${slices - 1} expansion slice(s) — so each runs inside the budget.`,
        budgetValid: true,
    };
}
/** Median of a non-empty numeric array. Caller guarantees non-empty. */
function median(sorted) {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
/**
 * Compute the correction factor from estimate/actual history.
 *
 * Median, not mean — one pathological phase (an aborted run, a mass rename)
 * must not swing every later projection. Clamped, because a ratio outside
 * [0.5, 3.0] means the estimator is wrong in kind and amplifying it would make
 * the next estimate worse, not better.
 *
 * Samples missing either side, or carrying a non-positive/non-finite value, are
 * dropped rather than coerced — a zero estimate would divide to Infinity.
 */
function computeCalibration(samples) {
    const candidates = Array.isArray(samples) ? samples : [];
    const usable = candidates.filter(isCalibrationSample);
    const sampleCount = usable.length;
    const confidence = deriveConfidence(sampleCount);
    if (sampleCount < exports.MIN_CALIBRATION_SAMPLES) {
        return { factor: 1, sampleCount, applied: false, confidence, clamped: false };
    }
    const ratios = usable.map((s) => s.actualTokens / s.estimateTokens).sort((a, b) => a - b);
    const raw = median(ratios);
    const factor = Math.min(exports.CALIBRATION_FACTOR_MAX, Math.max(exports.CALIBRATION_FACTOR_MIN, raw));
    return { factor, sampleCount, applied: true, confidence, clamped: factor !== raw };
}
/**
 * Apply a correction factor to a raw estimate. Rounds to an integer because
 * `estimate.tokens` is an integer field; floors at 1 so a heavy shrink factor
 * can never produce a zero-token estimate.
 */
function applyCalibration(rawTokens, factor) {
    // These two guards look dead to the type-checker and are not: this module is
    // compiled to `.cjs` and consumed by untyped callers (gsd-tools.cjs, the test
    // suite), which reach it with NaN, null, 0 and worse. The brands are a
    // compile-time contract for TypeScript callers; validation is what defends
    // everyone else. Do not delete either one because the parameter is now typed.
    if (!isPositiveFinite(rawTokens))
        return asCalibratedTokens(0);
    if (!isPositiveFinite(factor))
        return asCalibratedTokens(Math.max(1, Math.round(rawTokens)));
    // Bound the product: an inexact float past MAX_SAFE_INTEGER would masquerade
    // as an integer token count. Unreachable through today's CLI (which is
    // safe-integer bounded) but the function is exported and must not depend on
    // its caller for that guarantee.
    const scaled = Math.round(rawTokens * factor);
    return asCalibratedTokens(Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, scaled)));
}
/**
 * Extract a two-space-indented scalar block (`estimate:` / `actuals:`) out of a
 * document's leading YAML frontmatter.
 *
 * Hand-rolled for its TYPE CONTRACT, not for dependency availability — js-yaml
 * is vendored and available at runtime as of ADR-3473 §8.1 (#3881), which
 * migrated `src/frontmatter.cts`'s `extractFrontmatter` onto it. That parser
 * runs under js-yaml's FAILSAFE_SCHEMA, which resolves every scalar as a
 * string, whereas this function deliberately returns numbers for
 * numeric-looking values (`out[m[1]] = asNumber : rawValue`) so
 * `parseEstimate`/`parseActuals` see the types they validate. A naive swap
 * onto `extractFrontmatter` would turn `tokens: 5000` into `"5000"` and make
 * `isPositiveInt` reject every estimate. Scope is deliberately narrow: the
 * leading `---` block only, so an `estimate:` line inside a fenced code
 * block in the body cannot be mistaken for frontmatter (the
 * DEFECT.FRONTMATTER-SCALAR-BROAD-GREP class). Migrating this function onto
 * the shared parser (with a typed coercion layer over its string-only
 * output) is tracked as follow-on work under ADR-3473 §8.1, not done here —
 * this module is calibration-critical and has a history of subtle numeric
 * defects shipping past a large green suite (#2631 factor², #2632
 * self-defeating loop).
 */
function extractFrontmatterBlock(text, key) {
    if (typeof text !== 'string')
        return null;
    // The block is the one the one fence owner finds (`locateFrontmatterFence`).
    const fence = (0, frontmatter_fence_cjs_1.locateFrontmatterFence)(text);
    if (!fence?.closed)
        return null;
    const lines = text.slice(fence.openEnd, fence.bodyEnd).split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
    if (startIdx === -1)
        return null;
    const out = Object.create(null);
    for (let i = startIdx + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!/^\s/.test(line))
            break; // dedent ends the block
        const m = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (m === null)
            continue;
        const rawValue = m[2].replace(/\s+#.*$/, '').trim();
        if (rawValue === '')
            continue;
        const asNumber = Number(rawValue);
        out[m[1]] = /^-?\d+(?:\.\d+)?$/.test(rawValue) && Number.isFinite(asNumber)
            ? asNumber
            : rawValue.replace(/^['"]|['"]$/g, '');
    }
    return Object.keys(out).length > 0 ? { ...out } : null;
}
/** Pull the `estimate:` mapping out of an already-parsed frontmatter object. */
function estimateBlockOf(input) {
    if (input === null || typeof input !== 'object')
        return null;
    const record = input;
    return Object.prototype.hasOwnProperty.call(record, 'estimate') ? record['estimate'] : record;
}
/**
 * Parse an estimate block. Returns null for anything that is not a complete,
 * well-typed estimate — a partial block is not a usable estimate, and silently
 * defaulting a missing field would fabricate data the planner never produced.
 *
 * Accepts either the whole frontmatter object (`{estimate: {...}}`) or the
 * estimate mapping itself, so callers need not unwrap.
 */
function parseEstimate(input) {
    const block = estimateBlockOf(input);
    if (block === null || typeof block !== 'object' || Array.isArray(block))
        return null;
    const record = block;
    const tokens = record['tokens'];
    const tasks = record['tasks'];
    const confidence = record['confidence'];
    if (!isPositiveInt(tokens) || !isPositiveInt(tasks) || !isConfidence(confidence))
        return null;
    // The frontmatter trust boundary: `tokens` is calibrated-at-emission and
    // `raw_tokens` is the uncorrected projection (ADR-2629 Decision 1/4), so this
    // is where each figure's basis becomes a type rather than a field name.
    const rawTokens = record['raw_tokens'];
    return isPositiveInt(rawTokens)
        ? { tokens: asCalibratedTokens(tokens), tasks, confidence, rawTokens: asRawTokens(rawTokens) }
        : { tokens: asCalibratedTokens(tokens), tasks, confidence };
}
/** Pull the `actuals:` mapping out of an already-parsed frontmatter object. */
function actualsBlockOf(input) {
    if (input === null || typeof input !== 'object')
        return null;
    const record = input;
    return Object.prototype.hasOwnProperty.call(record, 'actuals') ? record['actuals'] : record;
}
/**
 * Parse an actuals block. `commits` may be 0 — a phase can legitimately record
 * zero commits — so it is validated as a non-negative integer while tokens and
 * tasks stay strictly positive.
 */
function parseActuals(input) {
    const block = actualsBlockOf(input);
    if (block === null || typeof block !== 'object' || Array.isArray(block))
        return null;
    const record = block;
    const tokens = record['tokens'];
    const tasks = record['tasks'];
    const commits = record['commits'];
    if (!isPositiveInt(tokens) || !isPositiveInt(tasks))
        return null;
    if (typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits < 0)
        return null;
    return { tokens, tasks, commits };
}
/**
 * Render an estimate as the YAML block that lands in PLAN.md frontmatter.
 * Inverse of parseEstimate over the same value domain — the bijection the
 * property test pins.
 */
function renderEstimate(estimate) {
    const lines = [
        'estimate:',
        `  tokens: ${estimate.tokens}`,
    ];
    if (isPositiveInt(estimate.rawTokens))
        lines.push(`  raw_tokens: ${estimate.rawTokens}`);
    lines.push(`  tasks: ${estimate.tasks}`, `  confidence: ${estimate.confidence}`);
    return lines.join('\n');
}
/**
 * The figure calibration must measure against: the uncalibrated projection when
 * the plan recorded one, else the stored value (pre-#2632 plans, where the two
 * were the same because no factor had yet been applied).
 */
function calibrationBasis(estimate) {
    if (isPositiveInt(estimate.rawTokens))
        return estimate.rawTokens;
    // THE one legitimate crossover in this module, and the reason asRawTokens()
    // refuses a CalibratedTokens rather than being permissive: on a plan written
    // before #2632 no factor had been applied yet, so `tokens` IS the raw
    // projection. Deliberately an explicit assertion so it stays a single
    // auditable line instead of a hole in the brand.
    return estimate.tokens;
}
/** Render an actuals block for SUMMARY.md frontmatter. Inverse of parseActuals. */
function renderActuals(actuals) {
    return [
        'actuals:',
        `  tokens: ${actuals.tokens}`,
        `  tasks: ${actuals.tasks}`,
        `  commits: ${actuals.commits}`,
    ].join('\n');
}
/**
 * Parse the persisted calibration document.
 *
 * This is a trust boundary: the file is on disk, may be hand-edited, and its
 * contents steer planning output. Every failure mode degrades to an empty
 * sample set rather than throwing or partially trusting — malformed JSON, a
 * non-object root, a missing/!== current schema_version, a non-array samples
 * field, or individual malformed samples.
 *
 * A schema_version we do not recognize is refused outright rather than
 * best-effort read: a future writer may change the ratio's meaning, and
 * misreading it would silently corrupt every subsequent estimate.
 */
function parseCalibrationDocument(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return [];
    const doc = parsed;
    if (doc['schema_version'] !== exports.CALIBRATION_SCHEMA_VERSION)
        return [];
    if (!Array.isArray(doc['samples']))
        return [];
    // Rebuild each sample from its two known fields rather than passing the
    // parsed object through — a hostile document cannot smuggle extra keys
    // (or a __proto__ payload) into anything downstream.
    return doc['samples']
        .filter(isCalibrationSample)
        .map((s) => ({ estimateTokens: s.estimateTokens, actualTokens: s.actualTokens }));
}
/** Serialize a calibration document. Inverse of parseCalibrationDocument. */
function renderCalibrationDocument(samples) {
    const doc = { schema_version: exports.CALIBRATION_SCHEMA_VERSION, samples };
    return `${JSON.stringify(doc, null, 2)}\n`;
}

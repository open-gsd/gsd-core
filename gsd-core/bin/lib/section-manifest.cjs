"use strict";
/**
 * Section Manifest — pure `when=` evaluator over `InvocationFacts`, mapping
 * a document-order list of parsed `<!-- gsd:section -->` sections (Phase 3,
 * `src/workflow-fragments.cts`) to an included/excluded partition for one
 * concrete invocation (ADR-1671 epic #1671, Phase 5 / issue #2932,
 * `.gsd/phase/chore-2932-init-section-manifest/40-design.md`).
 *
 * Pure module: no I/O, no dependency beyond node built-ins and the sibling
 * compiled module `workflow-fragments.cjs`, whose {@link
 * workflowFragments.WHEN_VOCABULARY} is imported and never redeclared here
 * (DEFECT.GENERATIVE-FIX — a second frozen copy of the same 4 strings would
 * silently desync from the source of truth the moment either side is edited
 * without the other).
 *
 * ## The evaluator is a LOOKUP, not a parser
 *
 * Derived from Greenspun's Tenth Rule (ADR-1671:69 cites it by name) and
 * binding on this implementation: `when=` is a closed vocabulary, widened
 * from 4 to 14 entries via the ADR-1671 amendment for #2992 (epic #1671
 * Phase 6.1; see `.gsd/phase/chore-2992-widen-when-vocabulary/
 * 40-design.md`), then from 14 to 19 via the ADR-1671 amendment for #2993
 * (epic #1671 Phase 6.2; see `.gsd/phase/chore-2993-fragmentize-plan-phase/
 * 40-design.md`), then from 19 to 20 via the ADR-1671 amendment for #2994
 * (epic #1671 Phase 6.3), then from 20 to 23 via a further #2994 amendment
 * fragmentizing `code-review.md` and `complete-milestone.md`, then from 23
 * to 24 via a still further #2994 amendment fragmentizing `autonomous.md`,
 * then from 24 to 26 via a still further #2994 amendment fragmentizing
 * `review.md` and `discuss-phase-assumptions.md`, then from 26 to 30 — and
 * finally to 29, `flag:--full` having been retired as dead vocabulary — via the
 * final #2994 slice fragmentizing `docs-update.md`, `update.md`,
 * `transition.md`, and `new-milestone.md`.
 * {@link WHEN_PREDICATES} is a total map from each frozen
 * vocabulary entry to exactly one predicate over {@link InvocationFacts}.
 * It MUST NOT tokenize, split on operators, or interpret structure in the
 * `when=` string — the moment it parses, the ad-hoc language has begun.
 * Every entry below is therefore a HAND-WRITTEN LITERAL: deriving a
 * predicate's flag/state name from its atom string (e.g. slicing `--fix`
 * out of `'flag:--fix'`) is tokenization relocated into this map and is
 * forbidden even though it would be shorter — the redundancy between each
 * key and its literal token is deliberate, and the bidirectional parity
 * test below catches any desync a hand-written entry could introduce. An
 * unrecognized `when=` value fails closed via {@link selectSections}
 * throwing a `TypeError` carrying `.reason = REASON.UNKNOWN_WHEN`; it is
 * never silently excluded (Postel's Law: liberal on FORMAT elsewhere in the
 * pipeline, strict on this SEMANTIC boundary — matching the discipline
 * Phase 3 already established for the same vocabulary at parse time).
 *
 * ## Totality over facts
 *
 * Every predicate treats an absent/missing fact key as falsy WITHOUT
 * throwing — {@link InvocationFacts} is a plain data object handed in by a
 * caller (the init CLI seam) that may not always populate every field, and
 * this module must never surprise that caller with an exception for an
 * omission rather than a malformed `when=` value.
 *
 * ## Partition invariant
 *
 * {@link selectSections} returns `included` and `excluded` id arrays that
 * together contain every input section's `id` exactly once, in the SAME
 * relative document order they appeared in the input — never mutating the
 * input array or its elements.
 *
 * ADR-457 build-at-publish: compiled by tsc to
 * gsd-core/bin/lib/section-manifest.cjs (gitignored).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WHEN_PREDICATES = exports.REASON = void 0;
exports.selectSections = selectSections;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- workflow-fragments.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
const workflowFragments = require("./workflow-fragments.cjs");
/**
 * Frozen, stable reason codes for every `fail()` throw site in this module.
 * Tests assert via `assert.equal(err.reason, REASON.X)` rather than
 * regex-/substring-matching the human-readable message (CONTRIBUTING.md
 * "Prohibited: Raw Text Matching on Test Outputs"; shape copied from
 * `src/workflow-fragments.cts`'s own `REASON` export) — a message reword
 * must never silently pass a test that exists to catch a behavior
 * regression.
 *
 * Adding a new reason requires updating this map AND the test that locks
 * `Object.keys(REASON).sort()` as a coordinated change.
 */
exports.REASON = Object.freeze({
    UNKNOWN_WHEN: 'unknown_when',
});
/**
 * Throws a `TypeError` naming the offending `when` value, carrying `reason`
 * (one of {@link REASON}) as a typed property so callers/tests never need
 * to pattern-match the message prose.
 */
function fail(reason, message) {
    const err = new TypeError(`section-manifest: ${message}`);
    err.reason = reason;
    throw err;
}
/**
 * Safely tests whether `facts.flags` contains `flag`, tolerating an absent,
 * `null`, or non-`Set` (e.g. array) `flags` value without throwing —
 * `.has` is checked to be callable before it is called, rather than
 * assuming every {@link InvocationFacts.flags} is a real `Set` (totality
 * over facts; not duck-typed — an array `flags` degrades to "not present",
 * it is never iterated or `.includes`-checked).
 */
function hasFlag(facts, flag) {
    return typeof facts.flags?.has === 'function' && facts.flags.has(flag) === true;
}
/**
 * Total map from each frozen {@link workflowFragments.WHEN_VOCABULARY}
 * entry to exactly one predicate over {@link InvocationFacts}. This is a
 * LOOKUP, never a parser — see the module doc comment's "The evaluator is a
 * LOOKUP, not a parser" section. Every entry is a hand-written literal; see
 * the module doc comment for why deriving a predicate from its atom string
 * is forbidden. Semantics confirmed against the section bodies themselves
 * (design doc "Semantics confirmed against the section bodies themselves,
 * not inferred from the id"):
 *
 * - `gap-closure-artifacts` — "For decimal/polish phases only (X.Y
 *   pattern) … Skip if phase number has no decimal" -> `state:gap-closure-phase`.
 * - `regression-gate` — "Skip if: this is the first phase (no prior
 *   phases)" -> `state:has-prior-phases`.
 * - `partial-wave` — "If `WAVE_FILTER` was used" -> `flag:--wave`.
 */
exports.WHEN_PREDICATES = Object.freeze(Object.assign(Object.create(null), {
    always: () => true,
    'flag:--wave': (facts) => hasFlag(facts, '--wave'),
    'state:gap-closure-phase': (facts) => typeof facts.phaseNumber === 'string' && facts.phaseNumber.includes('.'),
    'state:has-prior-phases': (facts) => facts.hasPriorPhases === true,
    'flag:--auto': (facts) => hasFlag(facts, '--auto'),
    'flag:--discuss': (facts) => hasFlag(facts, '--discuss'),
    'flag:--fix': (facts) => hasFlag(facts, '--fix'),
    'flag:--forensic': (facts) => hasFlag(facts, '--forensic'),
    'flag:--ingest': (facts) => hasFlag(facts, '--ingest'),
    'flag:--prd': (facts) => hasFlag(facts, '--prd'),
    'flag:--research': (facts) => hasFlag(facts, '--research'),
    'flag:--research-phase': (facts) => hasFlag(facts, '--research-phase'),
    'flag:--reset-phase-numbers': (facts) => hasFlag(facts, '--reset-phase-numbers'),
    'flag:--reviews': (facts) => hasFlag(facts, '--reviews'),
    'flag:--validate': (facts) => hasFlag(facts, '--validate'),
    'state:auto-advance-active': (facts) => facts.autoAdvanceActive === true,
    'state:chunked-mode': (facts) => facts.chunkedMode === true,
    'state:fallow-enabled': (facts) => facts.fallowEnabled === true,
    'state:flat-mode': (facts) => facts.flatMode === true,
    'state:git-create-tag': (facts) => facts.gitCreateTag === true,
    'state:is-monorepo': (facts) => facts.isMonorepo === true,
    'state:needs-codebase-map': (facts) => facts.needsCodebaseMap === true,
    'state:next-channel': (facts) => facts.nextChannel === true,
    'state:phase-mvp-mode': (facts) => facts.phaseMvpMode === true,
    'state:plan-strategy-converge': (facts) => facts.planStrategyConverge === true,
    'state:reviewer-instances-configured': (facts) => facts.reviewerInstancesConfigured === true,
    'state:ui-phase-active': (facts) => facts.uiPhaseActive === true,
    'state:workstream-active': (facts) => facts.workstreamActive === true,
    'state:worktrees-enabled': (facts) => facts.worktreesEnabled === true,
}));
// Coordinated-change guard, checked at module load: every entry of the
// frozen WHEN_VOCABULARY (imported, never redeclared — see module doc
// comment) must have exactly one predicate here, and vice versa. This is
// the load-bearing half of the DEFECT.GENERATIVE-FIX parity contract; the
// test-level half (50-test-matrix.md rows 21-23) additionally asserts it
// from the vocabulary's own export so a 5th vocabulary entry added without
// a predicate fails loudly rather than silently falling through to
// REASON.UNKNOWN_WHEN only at run time.
for (const when of workflowFragments.WHEN_VOCABULARY) {
    if (!Object.hasOwn(exports.WHEN_PREDICATES, when)) {
        throw new Error(`section-manifest: WHEN_VOCABULARY entry "${when}" has no predicate in WHEN_PREDICATES`);
    }
}
// Reverse half of the same coordinated-change guard: every own key of
// WHEN_PREDICATES must also appear in WHEN_VOCABULARY. Without this, a
// predicate key with no vocabulary entry would let the evaluator accept an
// atom that the parser (classifyMarker) rejects — a real divergence between
// the two shared-constant halves (DEFECT.GENERATIVE-FIX; B9/B10 in
// `.gsd/phase/chore-2992-widen-when-vocabulary/50-test-matrix.md`).
const VOCABULARY_SET = new Set(workflowFragments.WHEN_VOCABULARY);
for (const predicateKey of Object.keys(exports.WHEN_PREDICATES)) {
    if (!VOCABULARY_SET.has(predicateKey)) {
        throw new Error(`section-manifest: WHEN_PREDICATES entry "${predicateKey}" has no matching WHEN_VOCABULARY entry`);
    }
}
/**
 * Partition `sections` (document order) into `included`/`excluded` id
 * arrays for one set of `facts`, per {@link WHEN_PREDICATES}. Exact
 * partition: every input id appears in exactly one of the two output
 * arrays, in the same relative order it appeared in `sections`. Never
 * mutates `sections` or its elements.
 *
 * @param sections - document-order sections carrying at least `{id, when}`
 * @param facts - the concrete invocation's resolved facts
 * @throws {SectionManifestError} with `.reason = REASON.UNKNOWN_WHEN` when a
 *   section's `when` value has no entry in {@link WHEN_PREDICATES} (fail
 *   closed — never silently excluded).
 */
function selectSections(sections, facts) {
    const included = [];
    const excluded = [];
    for (const section of sections) {
        if (!Object.hasOwn(exports.WHEN_PREDICATES, section.when)) {
            fail(exports.REASON.UNKNOWN_WHEN, `section "${section.id}" has unrecognized when= value "${section.when}"`);
        }
        const predicate = exports.WHEN_PREDICATES[section.when];
        if (predicate(facts)) {
            included.push(section.id);
        }
        else {
            excluded.push(section.id);
        }
    }
    return { included, excluded };
}

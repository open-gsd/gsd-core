'use strict';

/**
 * scripts/registry-schema.cjs — pure schema/vocab constants + validation +
 * markdown-generation logic for the two third-party discoverability catalogs
 * (issue #2182):
 *
 *   - `docs/registries/capabilities.json`  → "GSD Community Capability Registry"
 *   - `docs/registries/eos.json`           → "GSD EoS Registry" (PR2)
 *
 * The vocabulary constants below are ADDITIVE CONTRACTS that track the
 * runtime/ADR closed vocabularies they describe — they are a documentation-
 * registry-scoped mirror, not the runtime source of truth:
 *
 *   - `LOOP_POINTS` mirrors ADR-857 "Loop Extension Points (the 12)"
 *     (docs/adr/857-capability-system.md §"Loop Extension Points (the 12)").
 *     The canonical runtime set lives in `src/loop-resolver.cts`
 *     (`CANONICAL_POINTS` / `CANONICAL_POINTS_FALLBACK`, derived from
 *     `loop-host-contract.cjs`) — changing that set requires updating this
 *     list too, since a registry entry's `loopExtensionPoints` describes
 *     which of those 12 points a third-party capability extends.
 *   - `HOOK_KINDS` mirrors ADR-857 Decision 4 "three hook kinds": `step`
 *     (runs as its own sequenced unit), `contribution` (injects into the
 *     core step's prompt/context), `gate` (checks and optionally blocks).
 *   - `INTERFACE_POINTS` mirrors ADR-1239 "The six interface points" (the
 *     Host-Integration Interface integration surface): command/workflow
 *     invocation, agent dispatch, model invocation, lifecycle hooks,
 *     state+config IO, artifact surface.
 *   - `PROFILES` mirrors ADR-1239 "Host-capability profiles (negotiation
 *     baselines)": `programmatic-cli`, `declarative-cli`, `ide`.
 *   - `AXES` mirrors ADR-1239 "the eight negotiated axes" (the negotiated
 *     capability schema exchanged at `initialize`): `embeddingMode`,
 *     `commandSurface`, `dispatch`, `modelMode`, `hookBus`, `stateIO`,
 *     `transport`, `runtime`. Seven of the eight are closed enums here;
 *     `dispatch` is ADR-1239's structured negotiated object
 *     (`{ namedDispatch, nested, maxDepth, background, subagentToolkit }`) —
 *     this registry accepts a free-form human summary string instead, so it
 *     carries the `AXES_FREE_STRING` sentinel rather than an enum array.
 *   - `CAPABILITY_REQUIRED` / `EOS_REQUIRED` mirror the required top-level
 *     fields for each entry type, including `enginesGsd` (ADR-1244 D1
 *     "Versioned capability manifest" — the `engines.gsd` semver-range gate,
 *     modelled on VS Code's `engines.vscode`).
 *
 * This module is pure — no `fs`/`process`/child-process access — so tests
 * can `require()` it directly and assert on structured return values.
 * `scripts/validate-registry.cjs` and `scripts/gen-registry.cjs` are the thin
 * CLI wrappers that perform I/O around these functions.
 */

// ─── ADR-857 "Loop Extension Points (the 12)" ────────────────────────────────
const LOOP_POINTS = Object.freeze([
  'discuss:pre',
  'discuss:post',
  'plan:pre',
  'plan:post',
  'execute:pre',
  'execute:wave:pre',
  'execute:wave:post',
  'execute:post',
  'verify:pre',
  'verify:post',
  'ship:pre',
  'ship:post',
]);

// ─── ADR-857 Decision 4 — three hook kinds ───────────────────────────────────
const HOOK_KINDS = Object.freeze(['step', 'contribution', 'gate']);

// ─── ADR-1239 "The six interface points" ─────────────────────────────────────
const INTERFACE_POINTS = Object.freeze(['command', 'dispatch', 'model', 'hooks', 'state', 'artifact']);

// ─── ADR-1239 "Host-capability profiles (negotiation baselines)" ────────────
const PROFILES = Object.freeze(['programmatic-cli', 'declarative-cli', 'ide']);

// Sentinel marking an AXES entry as a free-form descriptive string rather than
// a closed enum array. `Array.isArray(AXES_FREE_STRING)` is false, so callers
// can branch on `Array.isArray(AXES[key])` vs `AXES[key] === AXES_FREE_STRING`
// without risking confusion with a real enum value.
const AXES_FREE_STRING = Symbol('registry-schema.AXES_FREE_STRING');

// ─── ADR-1239 "the eight negotiated axes" ────────────────────────────────────
const AXES = Object.freeze({
  embeddingMode: Object.freeze(['imperative', 'declarative']),
  commandSurface: Object.freeze(['slash-file', 'slash-programmatic', 'slash-toml', 'palette', 'prose-only']),
  dispatch: AXES_FREE_STRING,
  modelMode: Object.freeze(['active', 'passive']),
  hookBus: Object.freeze(['host', 'engine', 'none']),
  stateIO: Object.freeze(['filesystem', 'sandboxed-storage', 'session-log-append']),
  transport: Object.freeze(['mcp', 'native-extension']),
  runtime: Object.freeze(['node', 'bun', 'sandboxed-web', 'python', 'go', 'rust', 'electron', 'other']),
});

// ─── Required top-level fields ───────────────────────────────────────────────
const CAPABILITY_REQUIRED = Object.freeze([
  'id',
  'name',
  'type',
  'repo',
  'description',
  'author',
  'license',
  'enginesGsd',
  'install',
  'uninstall',
  'interactions',
  'discussion',
]);

const EOS_REQUIRED = Object.freeze([
  'id',
  'name',
  'type',
  'repo',
  'description',
  'author',
  'license',
  'enginesGsd',
  'install',
  'uninstall',
  'interactions',
  'discussion',
  'protocolVersion',
]);

/**
 * Validate the SHAPE of an `engines.gsd`-style semver range string (ADR-1244
 * D1). Self-contained — no `semver` dependency, modelled on the constraint
 * parsing in `scripts/check-env.cjs` (`satisfiesConstraint`), but this
 * function validates that the range is well-formed rather than comparing it
 * against a concrete version.
 *
 * @param {string} _range
 * @returns {boolean}
 */
function isValidGsdRange(_range) {
  return true;
  // TODO(commit-B): real implementation per DESIGN.md
}

/**
 * Validate an array of registry entries against the closed schema for
 * `opts.type` ('capability' | 'eos').
 *
 * @param {object[]} _entries
 * @param {{type: 'capability'|'eos'}} _opts
 * @returns {{ok: boolean, errors: Array<{index: number, id?: string, field: string, reason: string}>}}
 */
function validateEntries(_entries, _opts) {
  return { ok: true, errors: [] };
  // TODO(commit-B): real implementation per DESIGN.md
}

/**
 * Render the deterministic Markdown document for a registry.
 *
 * @param {object[]} _entries
 * @param {{type: 'capability'|'eos', sourceFile?: string}} _opts
 * @returns {string}
 */
function renderMarkdown(_entries, _opts) {
  return '';
  // TODO(commit-B): real implementation per DESIGN.md
}

module.exports = {
  LOOP_POINTS,
  HOOK_KINDS,
  INTERFACE_POINTS,
  PROFILES,
  AXES,
  AXES_FREE_STRING,
  CAPABILITY_REQUIRED,
  EOS_REQUIRED,
  isValidGsdRange,
  validateEntries,
  renderMarkdown,
};

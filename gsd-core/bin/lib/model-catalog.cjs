"use strict";
/**
 * Model catalog — typed access to model-catalog.json.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/model-catalog.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUNTIMES_WITH_FAST_MODE = exports.EFFORT_ARGV = exports.EFFORT_RENDERING = exports.CLAUDE_AGENT_ALIASES = exports.KNOWN_PROVIDERS = exports.CODEX_MODEL_EFFORT = exports.PROVIDER_PRESETS = exports.RUNTIMES_WITH_REASONING_EFFORT = exports.KNOWN_RUNTIMES = exports.RUNTIME_PROFILE_MAP = exports.MODEL_ALIAS_MAP = exports.AGENT_DEFAULT_TIERS = exports.AGENT_TO_PHASE_TYPE = exports.MODEL_PROFILES = exports.ADAPTIVE_TIER_VALUES = exports.VALID_TIERS = exports.VALID_AGENT_TIERS = exports.VALID_PHASE_TYPES = exports.VALID_PROFILES = exports.catalog = void 0;
exports.isAnthropicFlavoredModel = isAnthropicFlavoredModel;
exports.nextTier = nextTier;
exports.formatAgentToModelMapAsTable = formatAgentToModelMapAsTable;
exports.getAgentToModelMapForProfile = getAgentToModelMapForProfile;
exports.clampEffortForHost = clampEffortForHost;
exports.renderEffortArgv = renderEffortArgv;
exports.renderEffortForRuntime = renderEffortForRuntime;
exports.mergeEffortTierDefaults = mergeEffortTierDefaults;
const node_path_1 = __importDefault(require("node:path"));
// In .cts (CommonJS output) files, `require` is available as a global;
// we use it directly to load JSON candidates.
const _require = require;
// Resolve model-catalog.json via a prioritised candidate list so the module
// works in every layout:
//
//   1. Co-located install path — gsd-core/bin/shared/model-catalog.json
//   2. GSD_MODEL_CATALOG env override
//
// A third candidate — `sdk/shared/model-catalog.json`, three levels up — used to
// sit between them. It was the legacy source-repo path kept as a fallback by the
// #3288 fix, whose contract was "check the co-located path FIRST, before the
// legacy source-repo path". ADR-0174 then retired the `@opengsd/gsd-sdk` package
// boundary and deleted the `sdk/` tree outright, so that candidate can no longer
// resolve in any layout: in a source repo there is no `sdk/`, and in an install
// layout it points at `~/.claude/sdk/shared/`, which the installer never writes
// (the original #3288 bug). It is removed rather than left as dead weight that
// implies a package boundary this repo no longer has.
const _catalogCandidates = [
    node_path_1.default.resolve(__dirname, '..', 'shared', 'model-catalog.json'),
    ...(process.env['GSD_MODEL_CATALOG'] ? [node_path_1.default.resolve(process.env['GSD_MODEL_CATALOG'])] : []),
];
let catalog = null;
let _catalogLastErr = null;
for (const _p of _catalogCandidates) {
    try {
        catalog = _require(_p);
        break;
    }
    catch (e) {
        const isMissingCandidate = (e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(_p)) ||
            (e && e.code === 'ENOENT');
        if (!isMissingCandidate)
            throw e;
        _catalogLastErr = e;
    }
}
if (!catalog) {
    throw new Error(`model-catalog.json not found. Tried:\n${_catalogCandidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${_catalogLastErr?.message}`);
}
// After the throw guard above, catalog is guaranteed non-null.
const _catalog = catalog;
exports.catalog = _catalog;
exports.VALID_PROFILES = [..._catalog.profiles];
exports.VALID_PHASE_TYPES = new Set(_catalog.phaseTypes);
exports.VALID_AGENT_TIERS = new Set(Object.keys(_catalog.adaptiveTierMap));
// Catalog-derived so this can never drift from the resolver's tier gate:
// Object.values(adaptiveTierMap) === ['opus', 'sonnet', 'haiku'] today, plus 'inherit'.
exports.VALID_TIERS = new Set([...Object.values(_catalog.adaptiveTierMap), 'inherit']);
// Same catalog-derived tier values as VALID_TIERS but WITHOUT 'inherit' — used
// by config-loader's runtime-override validation (model_profile_overrides /
// model_policy.runtime_tiers), which does not accept 'inherit' as a tier.
exports.ADAPTIVE_TIER_VALUES = new Set(Object.values(_catalog.adaptiveTierMap));
exports.MODEL_PROFILES = Object.fromEntries(Object.entries(_catalog.agents).map(([agent, meta]) => [agent, {
        quality: meta.golden,
        balanced: meta.balanced,
        budget: meta.budget,
        adaptive: _catalog.adaptiveTierMap[meta.routingTier],
    }]));
exports.AGENT_TO_PHASE_TYPE = Object.fromEntries(Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.phaseType]));
exports.AGENT_DEFAULT_TIERS = Object.fromEntries(Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.routingTier]));
exports.MODEL_ALIAS_MAP = Object.fromEntries(Object.entries(_catalog.runtimeTierDefaults['claude'] ?? {}).map(([tier, entry]) => [tier, entry?.model]));
exports.RUNTIME_PROFILE_MAP = (() => {
    const result = {};
    for (const [runtime, tiers] of Object.entries(_catalog.runtimeTierDefaults)) {
        const filtered = {};
        for (const [tier, entry] of Object.entries(tiers)) {
            if (entry)
                filtered[tier] = entry;
        }
        if (Object.keys(filtered).length > 0)
            result[runtime] = filtered;
    }
    return result;
})();
exports.KNOWN_RUNTIMES = new Set(Object.keys(_catalog.runtimeTierDefaults));
exports.RUNTIMES_WITH_REASONING_EFFORT = new Set(Object.entries(_catalog.runtimeTierDefaults)
    .filter(([, tiers]) => Object.values(tiers).some((entry) => entry && entry.reasoning_effort))
    .map(([runtime]) => runtime));
exports.PROVIDER_PRESETS = _catalog.providerPresets ?? {};
// ─── #3007 — Codex per-model effort capability ───────────────────────────────
//
// Codex's own `models.json` publishes `supported_reasoning_levels` per model and
// rejects an unsupported level at request time, so GSD must be conservative
// about what it sends: read the ceiling as DATA from the catalog (never
// branch on model id in code) and fall back to the family baseline for any
// model the catalog doesn't know about.
// (b) A malformed catalog entry (e.g. a non-array value like `"gpt-x": 5`) must
// degrade to "ignore that entry", never throw — model-catalog.cjs is required
// across the whole CLI, so one bad JSON value must not kill every command.
// `new Set(5)` would throw at module load; filter to array values first.
exports.CODEX_MODEL_EFFORT = Object.fromEntries(Object.entries(_catalog.codexModelEffort ?? {})
    .filter(([, levels]) => Array.isArray(levels))
    .map(([model, levels]) => [model, new Set(levels)]));
// (a) `??` only catches null/undefined. A malformed `"_baseline": null` still
// produces `new Set(null)` above — an empty Set, which is truthy — so a bare
// `??` fallback would never fire and every level would silently lose its
// advertised set (every effort would render as `value: null`). Guard on
// `.size > 0` so an empty/missing/malformed baseline always falls back to the
// hardcoded floor instead of failing open.
const CODEX_EFFORT_BASELINE = exports.CODEX_MODEL_EFFORT['_baseline'] && exports.CODEX_MODEL_EFFORT['_baseline'].size > 0
    ? exports.CODEX_MODEL_EFFORT['_baseline']
    : new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function advertisedCodexEffort(model) {
    if (typeof model !== 'string' || model.length === 0)
        return CODEX_EFFORT_BASELINE;
    return Object.prototype.hasOwnProperty.call(exports.CODEX_MODEL_EFFORT, model) ? exports.CODEX_MODEL_EFFORT[model] : CODEX_EFFORT_BASELINE;
}
// The full universal effort ladder, low-to-high. Used only to find "the
// nearest advertised level below" when a requested level isn't supported —
// never to invent behaviour for a level that isn't on it at all.
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// KNOWN_PROVIDERS excludes 'generic' — it is a sentinel (all null entries) that
// forces users to supply model IDs via model_profile_overrides. It is not a
// real catalog-backed provider (#49).
exports.KNOWN_PROVIDERS = new Set(Object.entries(exports.PROVIDER_PRESETS)
    .filter(([, tiers]) => Object.values(tiers).some((budgets) => budgets && Object.values(budgets).some((entry) => entry && entry.model)))
    .map(([name]) => name));
// ─── #3241 — Anthropic-flavored model detection ──────────────────────────────
//
// Moved here from src/model-resolver.cts (the "seam decision" in
// .gsd/phase/feat-3241-codex-omit-model-by-default/40-design.md): this leaf
// module is the one common dependency both model-resolver and the (layering-
// restricted) install-time Codex-posture checks can share without pulling
// model-resolver's config-loader dependency chain into a "pure read/verify"
// caller. model-resolver re-exports both names for back-compat.
//
// #2310 — True if `model` is an Anthropic-flavored value that must never appear as a
// Codex agent `.toml` `model`. Two forms: (a) a bare Claude Agent-tool tier alias
// (opus/sonnet/haiku/fable — CLAUDE_AGENT_ALIASES below); (b) any Claude model id in
// any provider namespacing — `claude-*`, `anthropic/claude-*`, `us.anthropic.claude-*`
// (the forms the catalog assigns to opencode/hermes/kilo, reachable on a Codex .toml
// via the runtime-resolver path). No OpenAI/Codex model id contains "claude", so a
// case-insensitive substring test is a safe, exhaustive guard for (b). Codex/ChatGPT
// rejects all of these.
exports.CLAUDE_AGENT_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
function isAnthropicFlavoredModel(model) {
    if (typeof model !== 'string')
        return false;
    const lower = model.toLowerCase();
    return exports.CLAUDE_AGENT_ALIASES.has(lower) || lower.includes('claude');
}
function nextTier(currentTier) {
    const order = ['light', 'standard', 'heavy'];
    const idx = order.indexOf(String(currentTier));
    if (idx === -1)
        return null;
    return order[Math.min(idx + 1, order.length - 1)];
}
function formatAgentToModelMapAsTable(agentToModelMap) {
    const agentWidth = Math.max('Agent'.length, ...Object.keys(agentToModelMap).map((a) => a.length));
    const modelWidth = Math.max('Model'.length, ...Object.values(agentToModelMap).map((m) => m.length));
    const sep = '─'.repeat(agentWidth + 2) + '┼' + '─'.repeat(modelWidth + 2);
    const header = ` ${'Agent'.padEnd(agentWidth)} │ ${'Model'.padEnd(modelWidth)}`;
    let out = `${header}\n${sep}\n`;
    for (const [agent, model] of Object.entries(agentToModelMap)) {
        out += ` ${agent.padEnd(agentWidth)} │ ${model.padEnd(modelWidth)}\n`;
    }
    return out;
}
function getAgentToModelMapForProfile(normalizedProfile) {
    const profile = exports.VALID_PROFILES.includes(normalizedProfile) ? normalizedProfile : 'balanced';
    const out = {};
    for (const [agent, profiles] of Object.entries(exports.MODEL_PROFILES)) {
        const profilesRec = profiles;
        out[agent] = profile === 'inherit' ? 'inherit' : (profilesRec[profile] ?? profiles.balanced);
    }
    return out;
}
exports.EFFORT_RENDERING = {
    claude: {
        param: 'output_config.effort',
        channel: 'frontmatter',
        supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
        clamp(level) {
            if (level === 'minimal')
                return 'low';
            return level;
        },
    },
    codex: {
        // #3007: 'max' and 'minimal' are stale here — Codex's per-model table
        // (CODEX_MODEL_EFFORT above) is now the source of truth for what a given
        // model actually advertises, and every model in the family baseline DOES
        // advertise 'max' (no model advertises 'minimal'). This runtime-level
        // spec is kept in sync with the family baseline so the two tables can
        // never disagree; renderEffortForRuntime layers the per-model ceiling
        // (and the 'ultra' policy rejection) on top of it.
        // KEEP IN SYNC with EFFORT_ARGV.codex below — same family baseline, two
        // channels (install-time vs invocation-time); they must never diverge.
        param: 'model_reasoning_effort',
        channel: 'api',
        supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
        clamp(level) {
            if (level === 'minimal')
                return 'low';
            return level;
        },
    },
};
exports.EFFORT_ARGV = {
    // Verified against `claude --help`: `--effort <level>`.
    claude: {
        render: (level) => ['--effort', level],
        supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
        clamp: (level) => (level === 'minimal' ? 'low' : level),
    },
    // Verified against `opencode run --help`: `--variant` — "model variant
    // (provider-specific reasoning effort, e.g., high, max, minimal)".
    opencode: {
        render: (level) => ['--variant', level],
        supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
        clamp: (level) => level,
    },
    // First-party Codex docs: `model_reasoning_effort` is a config-only key with no
    // dedicated flag, so the generic `-c key=value` override is the only argv route.
    // #3007: KEEP IN SYNC with EFFORT_RENDERING.codex above — this table must match
    // the family baseline exactly (no 'minimal', 'max' passes through unclamped),
    // otherwise the argv channel and the install-time channel disagree about the
    // same runtime's capability.
    codex: {
        render: (level) => ['-c', `model_reasoning_effort=${level}`],
        supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
        clamp: (level) => (level === 'minimal' ? 'low' : level),
    },
    // Verified against `pi --help` (pi 1.3.0, #5557): `--thinking <level>` — "Set
    // thinking level: off, minimal, low, medium, high, xhigh, max". `off` is a
    // pi-only level with no universal counterpart, so it is not in `supported`.
    pi: {
        render: (level) => ['--thinking', level],
        supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
        clamp: (level) => level,
    },
};
/**
 * Clamp a universal effort level to what a host actually accepts, or null.
 *
 * #3706 — extracted from `renderEffortArgv` so the two effort CHANNELS can share
 * one capability table without one pretending to be the other. `EFFORT_ARGV[host]`
 * describes what levels the host understands (`supported` + `clamp`); whether that
 * reaches the host as a CLI flag or as a baked frontmatter key is the caller's
 * business. The install-time OpenCode `variant:` writer needs the former without
 * the latter, and hardcoding `'argv'` at that call site to borrow this logic read
 * as if the frontmatter key were gated on the invocation-time axis. It is not —
 * claude declares `effortSurface: "argv"` and independently bakes an `effort:` key.
 *
 * Returns null for a level the host does not accept, which every caller treats as
 * "emit nothing". `inherit` lands here too: per #3533 (10d) it is not a wire level
 * on any runtime, so it is in no `supported` set and must never be written out.
 */
function clampEffortForHost(host, universalEffort) {
    // Own-property lookup only: a plain `EFFORT_ARGV[host]` resolves `__proto__`
    // and friends to inherited members that carry no clamp/render.
    if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(exports.EFFORT_ARGV, host))
        return null;
    const spec = exports.EFFORT_ARGV[host];
    if (!spec || typeof spec.clamp !== 'function')
        return null;
    if (typeof universalEffort !== 'string' || universalEffort.length === 0)
        return null;
    const clamped = spec.clamp(universalEffort);
    return spec.supported.has(clamped) ? clamped : null;
}
/**
 * Render the invocation-time effort argument for a host.
 *
 * `effortSurface` is the host's negotiated axis value. Only `argv` produces an
 * argument; `none`, `undocumented`, and anything unrecognised produce nothing.
 * Never throws.
 */
function renderEffortArgv(host, universalEffort, effortSurface) {
    const empty = { argv: [], value: null, host };
    if (effortSurface !== 'argv')
        return empty;
    // Own-property lookup only. A plain `EFFORT_ARGV[host]` resolves `__proto__`
    // (and `constructor`/`toString`) to inherited members, which are truthy but
    // carry no `clamp`/`render` — a hostile host id would throw instead of
    // degrading. The host id reaches here from a descriptor, i.e. untrusted JSON.
    // #3706: the clamp/supported half lives in clampEffortForHost so the
    // install-time channel can reuse it; this function keeps the axis gate and
    // the argv rendering. One table, one clamp, two channels.
    const clamped = clampEffortForHost(host, universalEffort);
    if (clamped === null)
        return empty;
    const spec = exports.EFFORT_ARGV[host];
    if (typeof spec.render !== 'function')
        return empty;
    return { argv: spec.render(clamped), value: clamped, host };
}
/**
 * Render a universal effort string for a specific runtime.
 *
 * `model` (#3007) is consulted ONLY for codex: Codex's per-model
 * `supported_reasoning_levels` means the same universal level can be a clean
 * pass-through on one model and a clamp (or, for 'ultra', an outright
 * rejection) on another. Every other runtime ignores the third argument
 * entirely — passing a model id to claude changes nothing.
 */
function renderEffortForRuntime(runtime, universalEffort, model) {
    // #3533 (10d): 'inherit' is not a wire level on ANY runtime — it means
    // "omit the key / pass no argument and follow the session/host default".
    // Renderers must never emit it as a literal; null param/channel tells
    // resolve-execution consumers there is no propagation. Never measured
    // against any supported set.
    if (universalEffort === 'inherit') {
        return { value: 'inherit', param: null, channel: null, requested: 'inherit', clamped: false, reason: null };
    }
    const spec = exports.EFFORT_RENDERING[runtime];
    if (!spec) {
        return { value: universalEffort, param: null, channel: null, requested: universalEffort, clamped: false, reason: null };
    }
    if (runtime === 'codex') {
        // #2167 — 'ultra' turns on Codex's automatic task delegation, which would
        // let Codex spawn agents underneath GSD's own orchestration. GSD rejects
        // it unconditionally as a POLICY call, never as a capability clamp — this
        // holds even for a model (e.g. gpt-5.6-sol) that DOES advertise 'ultra',
        // so it is never softened down to 'max'.
        if (universalEffort === 'ultra') {
            return {
                value: null,
                param: null,
                channel: null,
                requested: 'ultra',
                clamped: false,
                reason: "'ultra' turns on Codex's automatic task delegation, which would let Codex spawn agents underneath GSD's own orchestration (#2167); GSD rejects it regardless of what the model advertises.",
            };
        }
        const allowed = advertisedCodexEffort(model);
        if (allowed.has(universalEffort)) {
            return { value: universalEffort, param: spec.param, channel: spec.channel, requested: universalEffort, clamped: false, reason: null };
        }
        const idx = EFFORT_LADDER.indexOf(universalEffort);
        if (idx === -1) {
            // Not on the ladder at all (e.g. 'MAX') — preserve prior behaviour:
            // fall through to the runtime-level clamp rather than inventing new
            // handling for input the ladder doesn't recognize.
            return { value: spec.clamp(universalEffort), param: spec.param, channel: spec.channel, requested: universalEffort, clamped: false, reason: null };
        }
        // Every model's advertised set is a contiguous run up to 'max' (or 'ultra'
        // for sol, already handled above), so the only unsupported level in
        // practice is 'minimal' — below every model's floor. Walk UP the ladder
        // to the nearest level the model actually advertises (its floor): there
        // is nothing below 'minimal' to fall back to.
        // Walking UP is safe today only because every advertised set floors at
        // 'low' — a future model whose floor is, say, 'high' would silently turn
        // a requested 'low' into 'high': MORE reasoning and MORE cost than asked
        // for, with no error. `clamped`/`reason` below is what makes that
        // escalation visible to a caller instead of a silent cost surprise, which
        // is why those fields are not optional decoration.
        for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
            const candidate = EFFORT_LADDER[i];
            // 'ultra' is never a valid clamp target: it would re-enter, by the back
            // door, the delegation mode the #2167 rejection above exists to keep
            // out. A clamp may never produce a value that a direct request for
            // that same value would have refused.
            if (candidate === 'ultra') {
                continue;
            }
            if (allowed.has(candidate)) {
                return {
                    value: candidate,
                    param: spec.param,
                    channel: spec.channel,
                    requested: universalEffort,
                    clamped: true,
                    reason: `requested '${universalEffort}' is not in ${model ? `${model}'s` : "the codex family baseline's"} advertised reasoning levels; clamped up to its floor, '${candidate}'.`,
                };
            }
        }
        // No advertised level at or above the request either (shouldn't happen
        // given today's catalog data, but never throw): reject rather than emit
        // an unsupported level.
        return {
            value: null,
            param: null,
            channel: null,
            requested: universalEffort,
            clamped: false,
            reason: `requested '${universalEffort}' is not in ${model ? `${model}'s` : "the codex family baseline's"} advertised reasoning levels, and no advertised level is available either.`,
        };
    }
    const value = spec.clamp(universalEffort);
    return {
        value,
        param: spec.param,
        channel: spec.channel,
        requested: universalEffort,
        clamped: value !== universalEffort,
        reason: value !== universalEffort ? `requested '${universalEffort}' clamped to '${value}' for ${runtime}.` : null,
    };
}
/**
 * #3531 (10c) — Merge a config `effort.routing_tier_defaults` block over the
 * manifest tier defaults instead of replacing them. A partial config must not
 * discard built-ins: per tier, a valid override value wins and an invalid one
 * is ignored so the manifest value for that tier surfaces (ADR-443 D1's
 * "invalid values fall through" holds within the merged layer).
 *
 * Pure: returns a new object and never mutates either input — the manifest
 * constants (`CANONICAL_CONFIG_DEFAULTS`, the catalog cache) stay frozen. The
 * validator is injected because `EFFORT_SET` lives in model-resolver, which
 * imports this leaf (a reverse import would be a cycle); both effort
 * resolvers pass their own `(v) => typeof v === 'string' && EFFORT_SET.has(v)`.
 */
function mergeEffortTierDefaults(manifest, override, isValid) {
    const merged = { ...(manifest || {}) };
    if (override && typeof override === 'object' && !Array.isArray(override)) {
        for (const [tier, value] of Object.entries(override)) {
            // House pollution guard (mirrors _deepMergeConfig in config-loader): the
            // string-only validator already makes these inert, but an explicit skip
            // keeps this merge safe even if a caller's validator is ever relaxed.
            if (tier === '__proto__' || tier === 'constructor' || tier === 'prototype')
                continue;
            if (isValid(value))
                merged[tier] = value;
        }
    }
    return merged;
}
// ─── Fast mode propagation ───────────────────────────────────────────────────
exports.RUNTIMES_WITH_FAST_MODE = new Set(['api']);

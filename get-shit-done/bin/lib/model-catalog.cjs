'use strict';

const path = require('node:path');

// Resolve model-catalog.json via a prioritised candidate list so the module
// works in every layout:
//
//   1. Co-located install path — get-shit-done/bin/shared/model-catalog.json
//      Written by bin/install.js (#3288 fix). This is the canonical post-install
//      location across all runtimes (Claude Code, Codex, OpenCode, etc.).
//
//   2. Source-repo dev path — sdk/shared/model-catalog.json
//      Three levels up from bin/lib/: works when running directly from the
//      open-gsd/gsd-core clone (the original path introduced by #3230).
//
//   3. GSD_MODEL_CATALOG env override — allows test harnesses and custom
//      deployments to point at an arbitrary catalog file.
//
// Throws with a diagnostic message that lists all candidates when none resolve,
// so MODULE_NOT_FOUND surfaces as a clear actionable error (PRED.k301).
const _catalogCandidates = [
  path.resolve(__dirname, '..', 'shared', 'model-catalog.json'),
  path.resolve(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'),
  process.env.GSD_MODEL_CATALOG ? path.resolve(process.env.GSD_MODEL_CATALOG) : null,
].filter(Boolean);

let catalog = null;
let _catalogLastErr = null;
for (const _p of _catalogCandidates) {
  try {
    catalog = require(_p);
    break;
  } catch (e) {
    // Only treat missing-file errors as recoverable — rethrow parse errors,
    // permission errors, and any other real failures so they surface clearly
    // instead of being silently swallowed (CR finding, PR #3293).
    const isMissingCandidate =
      (e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(_p)) ||
      (e && e.code === 'ENOENT');
    if (!isMissingCandidate) throw e;
    _catalogLastErr = e;
  }
}
if (!catalog) {
  throw new Error(
    `model-catalog.json not found. Tried:\n${_catalogCandidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${_catalogLastErr?.message}`
  );
}

const VALID_PROFILES = [...catalog.profiles];
const VALID_PHASE_TYPES = new Set(catalog.phaseTypes);
const VALID_AGENT_TIERS = new Set(Object.keys(catalog.adaptiveTierMap));

const MODEL_PROFILES = Object.fromEntries(
  Object.entries(catalog.agents).map(([agent, meta]) => [agent, {
    quality: meta.golden,
    balanced: meta.balanced,
    budget: meta.budget,
    adaptive: catalog.adaptiveTierMap[meta.routingTier],
  }])
);

const AGENT_TO_PHASE_TYPE = Object.fromEntries(
  Object.entries(catalog.agents).map(([agent, meta]) => [agent, meta.phaseType])
);

const AGENT_DEFAULT_TIERS = Object.fromEntries(
  Object.entries(catalog.agents).map(([agent, meta]) => [agent, meta.routingTier])
);

const MODEL_ALIAS_MAP = Object.fromEntries(
  Object.entries(catalog.runtimeTierDefaults.claude).map(([tier, entry]) => [tier, entry?.model])
);

const RUNTIME_PROFILE_MAP = Object.fromEntries(
  Object.entries(catalog.runtimeTierDefaults)
    .map(([runtime, tiers]) => [
      runtime,
      Object.fromEntries(
        Object.entries(tiers).filter(([, entry]) => entry).map(([tier, entry]) => [tier, entry])
      ),
    ])
    .filter(([, tiers]) => Object.keys(tiers).length > 0)
);

const KNOWN_RUNTIMES = new Set(Object.keys(catalog.runtimeTierDefaults));
const RUNTIMES_WITH_REASONING_EFFORT = new Set(
  Object.entries(catalog.runtimeTierDefaults)
    .filter(([, tiers]) => Object.values(tiers).some((entry) => entry && entry.reasoning_effort))
    .map(([runtime]) => runtime)
);

const PROVIDER_PRESETS = catalog.providerPresets || {};

// KNOWN_PROVIDERS excludes 'generic' — it is a sentinel (all null entries) that
// forces users to supply model IDs via model_profile_overrides. It is not a
// real catalog-backed provider (#49).
const KNOWN_PROVIDERS = new Set(
  Object.entries(PROVIDER_PRESETS)
    .filter(([, tiers]) =>
      Object.values(tiers).some((budgets) =>
        budgets && Object.values(budgets).some((entry) => entry && entry.model)
      )
    )
    .map(([name]) => name)
);

function nextTier(currentTier) {
  const order = ['light', 'standard', 'heavy'];
  const idx = order.indexOf(String(currentTier));
  if (idx === -1) return null;
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
  const profile = VALID_PROFILES.includes(normalizedProfile) ? normalizedProfile : 'balanced';
  const out = {};
  for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
    out[agent] = profile === 'inherit' ? 'inherit' : (profiles[profile] ?? profiles.balanced);
  }
  return out;
}

// ─── Effort rendering ────────────────────────────────────────────────────────
//
// Universal effort ladder: minimal < low < medium < high < xhigh < max
//
// Each runtime supports a subset. The unique tails must be clamped when emitting
// to a runtime that does not support them:
//   - 'max'     is Anthropic-only: Codex does not support it -> clamp to 'xhigh'
//   - 'minimal' is Codex-only: Claude does not support it -> clamp to 'low'
//
// Rendering maps the universal effort string to the runtime's native parameter.

const EFFORT_RENDERING = {
  // Claude Code subagent effort: output_config.effort frontmatter key /
  // CLAUDE_CODE_EFFORT_LEVEL env. Supports: low, medium, high, xhigh, max.
  // Does NOT support 'minimal' (Codex-only) -> clamp to 'low'.
  claude: {
    param: 'output_config.effort',
    channel: 'frontmatter',
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp(level) {
      if (level === 'minimal') return 'low';
      return level;
    },
  },
  // Codex Responses API reasoning.effort. Supports: minimal, low, medium, high, xhigh.
  // Does NOT support 'max' (Anthropic-only) -> clamp to 'xhigh'.
  codex: {
    param: 'model_reasoning_effort',
    channel: 'api',
    supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
    clamp(level) {
      if (level === 'max') return 'xhigh';
      return level;
    },
  },
};

/**
 * Render a universal effort string for a specific runtime.
 *
 * Returns { value (clamped), param, channel } where:
 *   - value:   the clamped effort string safe to pass to the runtime
 *   - param:   the native parameter name (e.g. 'output_config.effort')
 *   - channel: how the value is propagated ('frontmatter', 'api', null)
 *
 * Unknown runtimes return { value: universalEffort, param: null, channel: null }
 * so callers can always read .value safely.
 */
function renderEffortForRuntime(runtime, universalEffort) {
  const spec = EFFORT_RENDERING[runtime];
  if (!spec) {
    return { value: universalEffort, param: null, channel: null };
  }
  return {
    value: spec.clamp(universalEffort),
    param: spec.param,
    channel: spec.channel,
  };
}

// ─── Fast mode propagation ───────────────────────────────────────────────────
//
// RUNTIMES_WITH_FAST_MODE is the set of runtimes where fast_mode=true can be
// propagated to a SPAWNED SUBAGENT via a native mechanism.
//
// Claude Code has NO per-subagent fast-mode mechanism — /fast is a session-level
// toggle only. Emitting a `fast_mode: true` frontmatter key on a Claude subagent
// would be a SILENT NO-OP, which is why 'claude' is deliberately excluded here.
//
// Only API-direct runtimes ('api') accept a speed:"fast" field in the request.
// Codex and other runtimes do not expose per-call fast_mode either.
const RUNTIMES_WITH_FAST_MODE = new Set(['api']);

module.exports = {
  catalog,
  MODEL_PROFILES,
  VALID_PROFILES,
  AGENT_TO_PHASE_TYPE,
  VALID_PHASE_TYPES,
  AGENT_DEFAULT_TIERS,
  VALID_AGENT_TIERS,
  MODEL_ALIAS_MAP,
  RUNTIME_PROFILE_MAP,
  KNOWN_RUNTIMES,
  RUNTIMES_WITH_REASONING_EFFORT,
  PROVIDER_PRESETS,
  KNOWN_PROVIDERS,
  nextTier,
  formatAgentToModelMapAsTable,
  getAgentToModelMapForProfile,
  EFFORT_RENDERING,
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
};

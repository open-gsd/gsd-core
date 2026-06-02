/**
 * Model catalog — typed access to model-catalog.json.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/model-catalog.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';

// In .cts (CommonJS output) files, `require` is available as a global;
// we use it directly to load JSON candidates.
const _require: NodeRequire = require;

// Resolve model-catalog.json via a prioritised candidate list so the module
// works in every layout:
//
//   1. Co-located install path — gsd-core/bin/shared/model-catalog.json
//   2. Source-repo dev path — sdk/shared/model-catalog.json
//   3. GSD_MODEL_CATALOG env override
const _catalogCandidates: string[] = [
  path.resolve(__dirname, '..', 'shared', 'model-catalog.json'),
  path.resolve(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'),
  ...(process.env['GSD_MODEL_CATALOG'] ? [path.resolve(process.env['GSD_MODEL_CATALOG'])] : []),
];

/** Typed tier entry from model-catalog.json (model + optional reasoning_effort). */
export interface TierEntry {
  model: string;
  reasoning_effort?: string;
}

/** Per-agent model mapping in the catalog. */
export interface AgentMeta {
  golden: string;
  balanced: string;
  budget: string;
  phaseType: string;
  routingTier: string;
}

/** The shape of model-catalog.json. */
export interface ModelCatalog {
  profiles: string[];
  phaseTypes: string[];
  adaptiveTierMap: Record<string, string>;
  runtimeTierDefaults: Record<string, Record<string, TierEntry | null>>;
  providerPresets: Record<string, Record<string, Record<string, TierEntry | null>>>;
  agents: Record<string, AgentMeta>;
}

let catalog: ModelCatalog | null = null;
let _catalogLastErr: Error | null = null;
for (const _p of _catalogCandidates) {
  try {
    catalog = _require(_p) as ModelCatalog;
    break;
  } catch (e) {
    const isMissingCandidate =
      (e && (e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && String((e as Error).message || '').includes(_p)) ||
      (e && (e as NodeJS.ErrnoException).code === 'ENOENT');
    if (!isMissingCandidate) throw e;
    _catalogLastErr = e as Error;
  }
}
if (!catalog) {
  throw new Error(
    `model-catalog.json not found. Tried:\n${_catalogCandidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${_catalogLastErr?.message}`
  );
}

// After the throw guard above, catalog is guaranteed non-null.
const _catalog = catalog;

export { _catalog as catalog };

export const VALID_PROFILES: string[] = [..._catalog.profiles];
export const VALID_PHASE_TYPES: Set<string> = new Set(_catalog.phaseTypes);
export const VALID_AGENT_TIERS: Set<string> = new Set(Object.keys(_catalog.adaptiveTierMap));

/** Per-profile model slots for each agent. */
export interface AgentModelProfiles {
  quality: string;
  balanced: string;
  budget: string;
  adaptive: string;
}

export const MODEL_PROFILES: Record<string, AgentModelProfiles> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, {
    quality: meta.golden,
    balanced: meta.balanced,
    budget: meta.budget,
    adaptive: _catalog.adaptiveTierMap[meta.routingTier],
  }])
);

export const AGENT_TO_PHASE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.phaseType])
);

export const AGENT_DEFAULT_TIERS: Record<string, string> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.routingTier])
);

export const MODEL_ALIAS_MAP: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(_catalog.runtimeTierDefaults['claude'] ?? {}).map(([tier, entry]) => [tier, entry?.model])
);

export const RUNTIME_PROFILE_MAP: Record<string, Record<string, TierEntry>> = (() => {
  const result: Record<string, Record<string, TierEntry>> = {};
  for (const [runtime, tiers] of Object.entries(_catalog.runtimeTierDefaults)) {
    const filtered: Record<string, TierEntry> = {};
    for (const [tier, entry] of Object.entries(tiers)) {
      if (entry) filtered[tier] = entry;
    }
    if (Object.keys(filtered).length > 0) result[runtime] = filtered;
  }
  return result;
})();

export const KNOWN_RUNTIMES: Set<string> = new Set(Object.keys(_catalog.runtimeTierDefaults));
export const RUNTIMES_WITH_REASONING_EFFORT: Set<string> = new Set(
  Object.entries(_catalog.runtimeTierDefaults)
    .filter(([, tiers]) => Object.values(tiers).some((entry) => entry && entry.reasoning_effort))
    .map(([runtime]) => runtime)
);

export const PROVIDER_PRESETS: Record<string, Record<string, Record<string, TierEntry | null>>> =
  _catalog.providerPresets ?? {};

// KNOWN_PROVIDERS excludes 'generic' — it is a sentinel (all null entries) that
// forces users to supply model IDs via model_profile_overrides. It is not a
// real catalog-backed provider (#49).
export const KNOWN_PROVIDERS: Set<string> = new Set(
  Object.entries(PROVIDER_PRESETS)
    .filter(([, tiers]) =>
      Object.values(tiers).some((budgets) =>
        budgets && Object.values(budgets).some((entry) => entry && entry.model)
      )
    )
    .map(([name]) => name)
);

export function nextTier(currentTier: string): string | null {
  const order = ['light', 'standard', 'heavy'];
  const idx = order.indexOf(String(currentTier));
  if (idx === -1) return null;
  return order[Math.min(idx + 1, order.length - 1)];
}

export function formatAgentToModelMapAsTable(agentToModelMap: Record<string, string>): string {
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

export function getAgentToModelMapForProfile(normalizedProfile: string): Record<string, string> {
  const profile = VALID_PROFILES.includes(normalizedProfile) ? normalizedProfile : 'balanced';
  const out: Record<string, string> = {};
  for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
    const profilesRec = profiles as unknown as Record<string, string>;
    out[agent] = profile === 'inherit' ? 'inherit' : (profilesRec[profile] ?? profiles.balanced);
  }
  return out;
}

// ─── Effort rendering ────────────────────────────────────────────────────────

export interface EffortSpec {
  param: string;
  channel: string;
  supported: Set<string>;
  clamp(level: string): string;
}

export const EFFORT_RENDERING: Record<string, EffortSpec> = {
  claude: {
    param: 'output_config.effort',
    channel: 'frontmatter',
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp(level: string): string {
      if (level === 'minimal') return 'low';
      return level;
    },
  },
  codex: {
    param: 'model_reasoning_effort',
    channel: 'api',
    supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
    clamp(level: string): string {
      if (level === 'max') return 'xhigh';
      return level;
    },
  },
};

export interface RenderedEffort {
  value: string;
  param: string | null;
  channel: string | null;
}

/**
 * Render a universal effort string for a specific runtime.
 */
export function renderEffortForRuntime(runtime: string, universalEffort: string): RenderedEffort {
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
export const RUNTIMES_WITH_FAST_MODE: Set<string> = new Set(['api']);

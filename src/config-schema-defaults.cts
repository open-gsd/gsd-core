/** Shared schema defaults for CLI queries and per-key resolution. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { CONFIG_DEFAULTS } = configLoader;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configSchema = require('./config-schema.cjs');
const { getCapabilityConfigSchema } = configSchema;

/**
 * Schema-level defaults for well-known config keys.
 * When a key is absent from config.json and no --default flag was supplied,
 * cmdConfigGet checks here before emitting "Key not found".
 */
const SCHEMA_DEFAULTS: Record<string, unknown> = {
  'context_window': 200000,
  'executor.stall_detect_interval_minutes': 5,
  'executor.stall_threshold_minutes': 10,
  'planner.stall_detection_enabled': CONFIG_DEFAULTS.planner_stall_detection_enabled,
  'planner.stall_detect_interval_minutes': 5,
  'planner.stall_threshold_minutes': 10,
  'git.create_tag': true,
  // #1689: per-plan agent_hint executor routing — default-on. A no-op for plans
  // without an agent_hint field, so existing dispatch is byte-identical.
  'workflow.agent_hint_routing': true,
  // #4401: Compact Content mode gate — derived from the defaults manifest via
  // CONFIG_DEFAULTS (added in config-loader.cts) so the manifest stays the
  // single source of truth, matching workflow.smart_zone_tokens /
  // planning.pr_strict / workflow.inline_plan_threshold below.
  'workflow.compact_content': CONFIG_DEFAULTS.compact_content,
  // Derived from the defaults manifest rather than restated, so the manifest
  // stays the single source of truth for the smart-zone budget (#2630).
  'workflow.smart_zone_tokens': CONFIG_DEFAULTS.smart_zone_tokens,
  // #2971: /gsd:pr-branch reads this key directly; an absent key must resolve to the
  // manifest default rather than "Key not found". Derived from the defaults manifest so
  // the manifest stays the single source of truth.
  'planning.pr_strict': CONFIG_DEFAULTS.pr_strict,
  // #3801: execute-plan reads this key on every run; an absent key must resolve
  // to the manifest default (2) rather than "Key not Found" — previously the
  // effective default existed only as the workflow's shell fallback and the
  // docs disagreed (settings-advanced said 3). Manifest stays the one owner.
  'workflow.inline_plan_threshold': CONFIG_DEFAULTS.inline_plan_threshold,
  // #4285 review: an absent threshold resolved to "Key not found" while the
  // hook silently used 35/25 — the query surface disagreeing with the reader.
  //
  // Restated here rather than derived: `CONFIG_DEFAULTS` is re-exported with a
  // FLATTENED shape that drops the manifest's nested blocks, so
  // `CONFIG_DEFAULTS.hooks` is undefined at runtime and the manifest cannot
  // feed these two rows the way `workflow.smart_zone_tokens` above is fed.
  //
  // Not added to `buildNewProjectConfig` either, and that one is deliberate
  // rather than incidental: it writes a `hooks` object into every NEW project's
  // config.json, which would freeze today's fire-points as an explicit
  // per-project override everywhere — the opposite of this PR's premise that an
  // absent key tracks the shipped default. (The manifest alone would NOT have
  // that effect; `buildNewProjectConfig` builds its own literal. Correcting an
  // earlier version of this comment that ran the two together.)
  //
  // That leaves ONE copy of 35/25 outside the hook — these two rows — and
  // `tests/config.test.cjs` pins them against the hook's exported
  // WARNING_THRESHOLD/CRITICAL_THRESHOLD so the copies cannot drift.
  'hooks.context_warning_threshold': 35,
  'hooks.context_critical_threshold': 25,
  // #4974: gates.* confirmation toggles — an absent key must resolve to the
  // documented default (true) rather than "Key not found", matching
  // config-defaults.manifest.json's `gates` block. Literal here (like
  // git.create_tag above) rather than derived from config-loader.cjs's flat
  // CONFIG_DEFAULTS: that flat projection is enumerated 1:1 against
  // gsd-core/references/planning-config.md by
  // tests/config-field-docs.test.cjs, and these 3 keys are internal workflow
  // wiring, not part of that public flat-key surface. Only the 3 keys
  // actually read by workflow conditions are registered — see
  // gsd-core/bin/shared/config-schema.manifest.json.
  'gates.execute_next_plan': true,
  'gates.confirm_transition': true,
  'gates.confirm_milestone_scope': true,
};

/**
 * Resolve a schema-level default for an absent key (#2256). Checks the legacy
 * hardcoded SCHEMA_DEFAULTS first, then the capability-registry configSchema
 * default — the same registry default the runtime's capability-activation
 * resolver (resolveConfigKey Level 4, capability-activation.cts) already honors,
 * so `query config-get` can no longer disagree with the runtime about an absent
 * key's effective value. The optional callback shares one registry snapshot with
 * per-key resolution; CLI callers keep their existing lazy lookup.
 */
function resolveSchemaDefault(
  cwd: string,
  kp: string,
  capabilitySchema: () => Record<string, unknown> = () => getCapabilityConfigSchema(cwd),
): { found: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(SCHEMA_DEFAULTS, kp)) {
    return { found: true, value: SCHEMA_DEFAULTS[kp] };
  }
  const capSchema = capabilitySchema();
  if (capSchema && typeof capSchema === 'object'
      && Object.prototype.hasOwnProperty.call(capSchema, kp)) {
    const entry = capSchema[kp];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const def = (entry as Record<string, unknown>)['default'];
      if (def !== undefined) return { found: true, value: def };
    }
  }
  return { found: false, value: undefined };
}

export = { resolveSchemaDefault };

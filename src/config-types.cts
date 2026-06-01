/**
 * TypeScript type definitions for GSD project config — model_policy block.
 *
 * These types reflect the model_policy config shape consumed by
 * resolveModelPolicy in core.cjs and validated by config-schema.cjs.
 *
 * See feat #49 (model_policy presets) and config-schema.manifest.json.
 * Added under ADR-457: TS sources in src/ compile to CJS artifacts in
 * get-shit-done/bin/lib/ at publish time.
 *
 * Resolution precedence (highest → lowest):
 *   1. model_overrides[agent]
 *   2. model_policy.runtime_tiers[runtime][tier]   (Sub-path A)
 *   3. model_policy provider preset + budget        (Sub-path B)
 *   4. model_profile_overrides
 *   5. resolve_model_ids / profile fallback
 */

/**
 * A single tier entry mapping a GSD tier (opus | sonnet | haiku) to a
 * concrete model ID. The optional `reasoning_effort` field is forwarded to
 * runtimes that accept it (e.g. opencode).
 */
export interface TierEntry {
  model: string;
  reasoning_effort?: string;
}

/**
 * The three standard GSD tiers for one runtime target. All fields are
 * optional so callers can supply a partial override (e.g. only `opus`).
 */
export interface RuntimeTiers {
  low?: TierEntry;
  medium?: TierEntry;
  high?: TierEntry;
}

/**
 * Top-level `model_policy` block in `.planning/config.json`.
 *
 * - `provider`       — known provider slug (e.g. `"anthropic"`, `"openai"`).
 *                      Drives Sub-path B catalog lookup.
 * - `budget`         — optional spend/quality tier that pairs with `provider`
 *                      to select a preset from the model catalog.
 * - `runtime_tiers`  — explicit per-runtime, per-tier model overrides
 *                      (Sub-path A). Keys are runtime slugs (e.g. `"opencode"`,
 *                      `"copilot"`); values are `RuntimeTiers` maps.
 */
export interface ModelPolicyConfig {
  provider: string;
  budget?: string;
  runtime_tiers?: Record<string, RuntimeTiers>;
}

/**
 * Minimal subset of the GSD project config that includes `model_policy`.
 * Extend this interface when migrating further config keys to TypeScript.
 */
export interface ProjectConfig {
  model_policy?: ModelPolicyConfig;
}

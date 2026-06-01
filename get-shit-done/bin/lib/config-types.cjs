"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });

/**
 * model-profiles — re-exports model catalog symbols consumed by callers that
 * historically required bin/lib/model-profiles.cjs.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/model-profiles.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

import {
  MODEL_PROFILES,
  VALID_PROFILES,
  AGENT_TO_PHASE_TYPE,
  VALID_PHASE_TYPES,
  AGENT_DEFAULT_TIERS,
  VALID_AGENT_TIERS,
  nextTier,
  formatAgentToModelMapAsTable,
  getAgentToModelMapForProfile,
  EFFORT_RENDERING,
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
} from './model-catalog.cjs';

export = {
  MODEL_PROFILES,
  VALID_PROFILES,
  AGENT_TO_PHASE_TYPE,
  VALID_PHASE_TYPES,
  AGENT_DEFAULT_TIERS,
  VALID_AGENT_TIERS,
  nextTier,
  formatAgentToModelMapAsTable,
  getAgentToModelMapForProfile,
  EFFORT_RENDERING,
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
};

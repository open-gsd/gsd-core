"use strict";
/**
 * model-profiles — re-exports model catalog symbols consumed by callers that
 * historically required bin/lib/model-profiles.cjs.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/model-profiles.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */
const model_catalog_cjs_1 = require("./model-catalog.cjs");
module.exports = {
    MODEL_PROFILES: model_catalog_cjs_1.MODEL_PROFILES,
    VALID_PROFILES: model_catalog_cjs_1.VALID_PROFILES,
    AGENT_TO_PHASE_TYPE: model_catalog_cjs_1.AGENT_TO_PHASE_TYPE,
    VALID_PHASE_TYPES: model_catalog_cjs_1.VALID_PHASE_TYPES,
    AGENT_DEFAULT_TIERS: model_catalog_cjs_1.AGENT_DEFAULT_TIERS,
    VALID_AGENT_TIERS: model_catalog_cjs_1.VALID_AGENT_TIERS,
    nextTier: model_catalog_cjs_1.nextTier,
    formatAgentToModelMapAsTable: model_catalog_cjs_1.formatAgentToModelMapAsTable,
    getAgentToModelMapForProfile: model_catalog_cjs_1.getAgentToModelMapForProfile,
    EFFORT_RENDERING: model_catalog_cjs_1.EFFORT_RENDERING,
    renderEffortForRuntime: model_catalog_cjs_1.renderEffortForRuntime,
    RUNTIMES_WITH_FAST_MODE: model_catalog_cjs_1.RUNTIMES_WITH_FAST_MODE,
};

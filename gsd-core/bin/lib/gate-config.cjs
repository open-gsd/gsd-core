"use strict";
/**
 * Gate config — the one place a gate reads a `workflow.*` switch (#5139, epic #5056, ADR-5057
 * Phase 6, design D5; fixes #4978).
 *
 * A gate module may not import `./io.cjs` and may not hand-parse `config.json`. It reads its switch
 * through the shared dot-path resolver `config-get workflow.*` is defined by
 * (`capability-activation.cts` `resolveConfigKey`): own-property traversal (a prototype-chain key
 * is never a value), the active workstream's config first, then the project root's, and a missing,
 * unreadable or non-object config is simply "the key is absent".
 *
 * The lookup is NESTED-ONLY. A top-level `context_coverage_gate` / `auto_advance` /
 * `_auto_chain_active` is never read — `config-get workflow.<key>` does not answer it either, so a
 * gate and `config-get` can no longer disagree about the same config file (#4978).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWorkflowConfigValue = readWorkflowConfigValue;
exports.isDecisionCoverageGateEnabled = isDecisionCoverageGateEnabled;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityActivationMod = require("./capability-activation.cjs");
const { resolveConfigKey } = capabilityActivationMod;
/**
 * The resolved raw value of a dotted config key, or `{ found: false }` when absent/unreadable.
 * QUIET: a malformed config.json is "key absent" with nothing written to stderr (the pre-#5139
 * gate readers printed nothing either); `config-get` keeps its one-time parse warning.
 */
function readWorkflowConfigValue(projectDir, dotKey) {
    return resolveConfigKey(dotKey, { config: {}, cwd: projectDir, registry: {}, quiet: true });
}
/**
 * `workflow.context_coverage_gate`: the decision-coverage gates' on/off switch.
 * A boolean is taken as written; the strings `'true'`/`'false'` (any case) are coerced; anything
 * else — including an absent key or an unreadable config — leaves the gate ENABLED.
 */
function isDecisionCoverageGateEnabled(projectDir) {
    const resolved = readWorkflowConfigValue(projectDir, 'workflow.context_coverage_gate');
    const value = resolved.found ? resolved.value : undefined;
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'false' || lower === 'true')
            return lower !== 'false';
    }
    return true;
}

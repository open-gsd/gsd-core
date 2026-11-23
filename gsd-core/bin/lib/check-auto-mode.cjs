"use strict";
/**
 * `check auto-mode` state — whether the workflow's auto-advance / auto-chain flags are on
 * (#5139, epic #5056, design D5). Not a gate: it reports configuration.
 *
 * Reads `workflow.auto_advance` and `workflow._auto_chain_active` NESTED-ONLY, through the same
 * reader as the gates (`gate-config.cts`), so `check auto-mode` answers exactly what
 * `config-get workflow.auto_advance` / `config-get workflow._auto_chain_active` answer. A
 * top-level `auto_advance` / `_auto_chain_active` is never read. Returns plain data; the router
 * formats it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAutoModeState = readAutoModeState;
const gate_config_cjs_1 = require("./gate-config.cjs");
function flag(projectDir, dotKey) {
    const resolved = (0, gate_config_cjs_1.readWorkflowConfigValue)(projectDir, dotKey);
    return Boolean(resolved.found ? resolved.value ?? false : false);
}
function readAutoModeState(projectDir) {
    const autoAdvance = flag(projectDir, 'workflow.auto_advance');
    const autoChainActive = flag(projectDir, 'workflow._auto_chain_active');
    let source = 'none';
    if (autoChainActive && autoAdvance)
        source = 'both';
    else if (autoChainActive)
        source = 'auto_chain';
    else if (autoAdvance)
        source = 'auto_advance';
    return {
        active: autoChainActive || autoAdvance,
        source,
        auto_chain_active: autoChainActive,
        auto_advance: autoAdvance,
    };
}

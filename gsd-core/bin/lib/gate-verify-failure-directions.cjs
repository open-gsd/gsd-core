"use strict";
/**
 * `check verify-failure-directions` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet,
 * #3172): it returns a `GateResult`; the command router formats it. Imports no io module and
 * performs no direct console/stdout/stderr write (ESLint-enforced).
 *
 * Probes every `<automated>` verify command declared in a phase's `-PLAN.md` files for a stated
 * `<fails_when>` failing direction — see `verify-command-grounding.cts` for the recognizer
 * contract.
 *
 * Argv after the verb: `<phase>`. When the phase is missing or cannot be resolved to a directory
 * the gate returns a non-throwing degraded payload (status/commands/counts zeroed, `readError`
 * populated) rather than a usage failure — the plan-checker parses this result and must be able to
 * tell "nothing to report" from "could not look".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateVerifyFailureDirections = evaluateVerifyFailureDirections;
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const verifyCommandGroundingMod = require("./verify-command-grounding.cjs");
const { probePhaseFailingDirections } = verifyCommandGroundingMod;
function evaluateVerifyFailureDirections(input) {
    const phase = input.args[0] || '';
    if (!phase) {
        return (0, gate_phase_context_cjs_1.unresolvableProbeVerdict)('verify-failure-directions requires a phase argument: check verify-failure-directions <phase>');
    }
    const located = (0, gate_phase_context_cjs_1.resolvePhaseDir)(input.projectDir, phase);
    if (located.kind === 'unreadable') {
        return (0, gate_phase_context_cjs_1.unresolvableProbeVerdict)(`could not read the phase directory for phase ${phase}: ${located.reason}`);
    }
    if (located.kind === 'none') {
        return (0, gate_phase_context_cjs_1.unresolvableProbeVerdict)(`could not resolve phase directory for phase ${phase}`);
    }
    const probed = probePhaseFailingDirections({ phaseDir: located.value });
    const blocked = probed.counts.blocker > 0;
    // A probe that could not look (`unresolvable`) is `unreadable`: never a pass, exit UNAVAILABLE (#5170).
    if (!blocked && probed.status === 'unresolvable')
        return (0, gate_verdict_cjs_1.gateUnreadable)(false, { ...probed });
    return (0, gate_verdict_cjs_1.gateVerdict)(blocked ? 'block' : 'pass', blocked, { ...probed });
}

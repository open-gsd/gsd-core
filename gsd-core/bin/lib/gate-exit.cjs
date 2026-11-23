"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gateExitOutcome = gateExitOutcome;
exports.declareGateExit = declareGateExit;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliExit = require("./cli-exit.cjs");
function gateExitOutcome(verdict, mode) {
    switch (verdict.outcome) {
        case 'unreadable':
            return 'UNAVAILABLE';
        case 'block':
            return mode === 'status' ? 'FAIL' : 'PASS';
        case 'empty':
            return mode === 'status' ? 'NO_INPUT' : 'PASS';
        case 'pass':
        case 'skip':
        case 'advisory':
            return 'PASS';
    }
}
/** Declare the exit outcome for a verdict. Call after `output()`, never before. */
function declareGateExit(verdict, mode) {
    const outcome = gateExitOutcome(verdict, mode);
    if (outcome !== 'PASS')
        cliExit.declareOutcome(outcome);
    return outcome;
}

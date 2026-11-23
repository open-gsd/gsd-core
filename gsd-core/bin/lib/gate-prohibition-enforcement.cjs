"use strict";
/**
 * `check prohibition-enforcement` as a gate module (#5219, epic #5056, ADR-5057 §4 closing arm C): it
 * returns a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * The deterministic test-tier prohibition PRODUCER (#1259, ADR-550 D5d): it locates the wired
 * mechanical check (node-test or lint-rule), proves it fails first, runs it, builds
 * `enforcementEvidence` and delivers the `dispositionForProhibition` result
 * (`runProhibitionEnforcement`, `prohibition-enforcement.cjs`). A producer, not a blocking gate: its
 * disposition is a delivered answer (an `advisory` verdict, never `block`), and the exit status
 * follows it through the seam like every other `check <verb>` (#5170, payload mode).
 *
 * No-throw contract: a throw anywhere is a non-blocking `unreadable` verdict whose payload is the
 * producer's fail-closed disposition (flagged, `unverified`, nothing located), never a crash and
 * never a silent green.
 *
 * Argv after the verb: `<request.json>` or `--json '<inline request>'`. A request is
 * `{ prohibition, check, mode? }`; one that is absent or does not parse is a usage failure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateProhibitionEnforcementGate = evaluateProhibitionEnforcementGate;
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
const prohibition_enforcement_cjs_1 = require("./prohibition-enforcement.cjs");
/** Parse the request document. A document that does not parse is typed evidence, never a swallowed `null`. */
function parseDocumentEvidence(text) {
    try {
        return (0, gate_evidence_cjs_1.evidenceFound)(JSON.parse(text));
    }
    catch (err) {
        return (0, gate_evidence_cjs_1.evidenceFromError)(err, 'request');
    }
}
/**
 * Parse a `{ prohibition, check, mode }` request from a JSON file path or inline `--json` string.
 * Returns null when the request is absent, unreadable or does not parse (the caller surfaces a usage
 * failure, never a throw).
 */
function parseRequest(args) {
    const jsonFlagIdx = args.indexOf('--json');
    const inline = args[jsonFlagIdx + 1];
    let payload;
    if (jsonFlagIdx !== -1 && typeof inline === 'string') {
        payload = inline;
    }
    else if (typeof args[0] === 'string' && args[0]) {
        const read = (0, gate_evidence_cjs_1.readTextEvidence)(args[0]);
        if (read.kind !== 'found')
            return null;
        payload = read.value;
    }
    else {
        return null;
    }
    const document = parseDocumentEvidence(payload);
    // A JSON `null` has no `check` / `prohibition` to read: it is no request, as an unparsable one is.
    if (document.kind !== 'found' || document.value === null)
        return null;
    const parsed = document.value;
    const checkRaw = parsed['check'];
    const check = (checkRaw && typeof checkRaw === 'object')
        ? checkRaw
        : null;
    const modeRaw = parsed['mode'];
    const mode = typeof modeRaw === 'string' ? modeRaw : undefined;
    return { prohibition: parsed['prohibition'] ?? null, check, ...(mode ? { mode } : {}) };
}
function evaluateProhibitionEnforcementGate(input) {
    const req = parseRequest(input.args);
    if (!req) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.SDK_MISSING_ARG, 'prohibition-enforcement requires a JSON request: check prohibition-enforcement <request.json> | --json \'{"prohibition":{...},"check":{...}}\'');
    }
    try {
        const result = (0, prohibition_enforcement_cjs_1.runProhibitionEnforcement)(req.prohibition, req.check, req.mode ? { mode: req.mode } : {});
        return (0, gate_verdict_cjs_1.gateVerdict)('advisory', false, { ...result });
    }
    catch (err) {
        // The producer's own fail-closed shape (`EnforcementResult`: a `ProhibitionDisposition` plus the
        // located / kind / evidence provenance): typed, so a change to that shape fails the build here
        // instead of drifting silently.
        const failedClosed = {
            status: 'unverified',
            flagged: true,
            tier: null,
            reason: 'exception: ' + (err instanceof Error ? err.message : String(err)),
            located: false,
            kind: null,
            evidence: [],
            ...(req.mode ? { mode: req.mode } : {}),
        };
        return (0, gate_verdict_cjs_1.gateUnreadable)(false, { ...failedClosed });
    }
}

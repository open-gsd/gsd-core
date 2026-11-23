"use strict";
/**
 * Agent command router — classify-failure subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/agent-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
const { output, error, ERROR_REASON } = io;
// ─── Constants ────────────────────────────────────────────────────────────────
/**
 * #2296 — The runtime enum of failure classes `classifyAgentFailure` can emit.
 *
 * `AgentFailureResult`'s class strings are TypeScript types, which erase at
 * runtime. Any second surface that needs to validate a class (the
 * `resolve-execution --failure-class` flag) would otherwise have to re-declare
 * the literals, giving two lists that can silently diverge. This frozen enum is
 * the single runtime source both surfaces consume.
 */
const AGENT_FAILURE_CLASSES = Object.freeze({
    QUOTA_EXCEEDED: 'quota-exceeded',
    CLASSIFY_HANDOFF_BUG: 'classify-handoff-bug',
    UNKNOWN_FAILURE: 'unknown-failure',
});
const QUOTA_SENTINELS = [
    '429',
    'usage_limit_reached',
    'usage limit',
    'rate limit',
    'rate-limited',
    'rate_limit',
    'resource_exhausted',
    'quota',
    'too many requests',
    'exceeded your',
];
const CLASSIFY_HANDOFF_SENTINEL = 'classifyhandoffifneeded is not defined';
// ─── Implementation ───────────────────────────────────────────────────────────
function parseRetryAfter(body) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const match = String(body ?? '').match(/\bretry[-_ ]after[:\s]+(\d+)\b/i);
    if (!match)
        return undefined;
    const seconds = Number.parseInt(match[1], 10);
    return Number.isFinite(seconds) ? seconds : undefined;
}
function classifyAgentFailure(body) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const normalized = String(body ?? '').toLowerCase();
    if (normalized.trim() === '') {
        return { class: AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE };
    }
    for (const sentinel of QUOTA_SENTINELS) {
        if (normalized.includes(sentinel)) {
            const retryAfterSeconds = parseRetryAfter(body);
            return retryAfterSeconds === undefined
                ? { class: AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED, sentinel }
                : { class: AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED, sentinel, retryAfterSeconds };
        }
    }
    if (normalized.includes(CLASSIFY_HANDOFF_SENTINEL)) {
        return {
            class: AGENT_FAILURE_CLASSES.CLASSIFY_HANDOFF_BUG,
            sentinel: CLASSIFY_HANDOFF_SENTINEL,
        };
    }
    return { class: AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE };
}
function routeAgentCommand({ args, raw }) {
    const subcommand = args[1];
    if (subcommand !== 'classify-failure') {
        error('Unknown agent subcommand. Available: classify-failure', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
    const bodyArgs = args.slice(2).filter((arg) => arg !== '--');
    output(classifyAgentFailure(bodyArgs.join(' ')), raw, undefined);
}
module.exports = {
    AGENT_FAILURE_CLASSES,
    classifyAgentFailure,
    routeAgentCommand,
};

"use strict";
/**
 * Verification-status subcommand router.
 * Routes `verification.status <phaseDir>` to verification.cmdVerificationStatus.
 *
 * Note: `verification` (reads verifier-emitted status) is distinct from `verify`
 * (runs verification checks like plan-structure/artifacts). Keep them separate.
 *
 * ADR-457 build-at-publish: source in src/verification-command-router.cts,
 * compiled to gsd-core/bin/lib/verification-command-router.cjs (gitignored).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
// ─── Implementation ───────────────────────────────────────────────────────────
const VERIFICATION_SUBCOMMANDS = ['status', 'resolve-file', 'fingerprint', 'append-audit'];
function routeVerificationCommand({ verification, args, cwd, raw, error, }) {
    routeCjsCommandFamily({
        args,
        subcommands: VERIFICATION_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_subcommand, available) => `Unknown verification subcommand. Available: ${available.join(', ')}`,
        handlers: {
            status: () => verification.cmdVerificationStatus(cwd, args[2], raw),
            'resolve-file': () => verification.cmdVerificationResolveFile(cwd, args[2], raw),
            fingerprint: () => verification.cmdVerificationFingerprint(cwd, args[2], args.slice(3), raw),
            'append-audit': () => verification.cmdVerificationAppendAudit(cwd, args[2], args.slice(3), raw),
        },
    });
}
module.exports = {
    routeVerificationCommand,
};

'use strict';
/**
 * Audit command routers — CLI dispatchers for `gsd-tools audit-uat` and
 * `gsd-tools audit-open`.
 *
 * ADR-959 (phase 4d-impl-3): audit command family cutover.
 * Extracted from the hardcoded `case 'audit-uat':` and `case 'audit-open':`
 * arms in gsd-tools.cjs.  Behaviour is preserved byte-for-behaviour from the
 * prior inline cases; the dispatch path now flows:
 *   default → dispatchCapabilityCommand →
 *   require(audit-command-router.cjs) → routeAuditUat | routeAuditOpen.
 *
 * Router signatures: { args, cwd, raw, error } — identical to the existing
 * host routers.  No new handler/arg convention; the capability registry
 * discovers these routers by name.
 *
 * Test seam: pass `_uat` / `_audit` / `_core` in the options object to inject
 * recording mocks instead of the real modules.  The `_`-prefix follows the
 * repo's established seam convention (see graphify-command-router.cts).
 * Production callers omit them.
 *
 * Lazy requires: uat.cjs and audit.cjs are required INSIDE each route function
 * so the unneeded module is never loaded (preserves equivalence with the old
 * inline case arms which each required only their own module).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
// Phase 2 (#1646): route through the Hub per ADR-959 §III(B) line 75.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
// ─── routeAuditUat ────────────────────────────────────────────────────────────
function routeAuditUat({ args, cwd, raw, error, _uat }) {
    // Suppress unused-variable warnings for args/error — this command has no
    // subcommands and passes raw through directly to the uat module.
    void args;
    void error;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const u = _uat ?? require('./uat.cjs');
    // Phase 2 (#1646): routes through the Hub for uniform observability and
    // HandlerFailure taxonomy. audit-uat has no subcommands — a synthetic 'run'
    // defaultSubcommand gives the Hub a single-handler manifest. The dispatch is
    // trivial but the observability seam (DispatchEvent, GSD_AUDIT=1 trace) is
    // now consistent with graphify/intel/host routers.
    routeHubCommandFamily({
        family: 'audit-uat',
        args,
        subcommands: ['run'],
        defaultSubcommand: 'run',
        handlers: {
            run: () => u.cmdAuditUat(cwd, raw),
        },
        unknownMessage: (subcommand) => `Unknown audit-uat subcommand: "${subcommand}". audit-uat takes no subcommands.`,
        error,
        cwd,
        raw,
    });
}
// ─── routeAuditOpen ──────────────────────────────────────────────────────────
function routeAuditOpen({ args, cwd, raw, error, _audit, _core }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const a = _audit ?? require('./audit.cjs');
    const c = _core ?? io;
    // Phase 2 (#1646): routes through the Hub for uniform observability.
    // `--json` is a flag, not a subcommand — capture it in the closure and strip
    // it from args before Hub dispatch so it isn't mistaken for a subcommand by
    // the manifest check. The handler then branches on wantJson for the two
    // output shapes (JSON object vs human-readable formatted report).
    const wantJson = args.includes('--json');
    const hubArgs = wantJson ? args.filter((arg) => arg !== '--json') : args;
    routeHubCommandFamily({
        family: 'audit-open',
        args: hubArgs,
        subcommands: ['run', 'acknowledge'],
        defaultSubcommand: 'run',
        handlers: {
            run: () => {
                const result = a.auditOpenArtifacts(cwd);
                if (wantJson) {
                    // io.output JSON-stringifies its first arg; pass the object directly.
                    c.output(result, raw);
                }
                else {
                    // Human-readable report must bypass JSON encoding — use the rawValue
                    // form (third arg) which io.output emits verbatim.
                    c.output(null, true, a.formatAuditReport(result));
                }
            },
            // #3458 follow-up (design point A4): `audit-open acknowledge --category
            // ... --milestone ...` writes/refreshes an `audit_acknowledged`
            // suppression marker. `hubArgs.slice(2)` drops the family token and the
            // `acknowledge` subcommand token itself, leaving just this
            // subcommand's OWN `--flag value` pairs — the same slice
            // `routeHubCommandFamily` itself passes to `hub.dispatch`'s `args`.
            acknowledge: () => a.cmdAuditAcknowledge(cwd, hubArgs.slice(2), raw),
        },
        unknownMessage: (subcommand) => `Unknown audit-open subcommand: "${subcommand}". Available: run (default, use --json for JSON output), acknowledge.`,
        error,
        cwd,
        raw,
    });
}
module.exports = {
    routeAuditUat,
    routeAuditOpen,
};

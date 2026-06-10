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
import core = require('./core.cjs');

// ─── Types ────────────────────────────────────────────────────────────────────

interface UatModule {
  cmdAuditUat(cwd: string, raw: boolean): void;
}

interface AuditModule {
  auditOpenArtifacts(cwd: string): unknown;
  formatAuditReport(result: unknown): string;
}

interface CoreModule {
  output(value: unknown, raw: boolean, rawValue?: string): void;
}

interface RouteAuditUatOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock uat module. Defaults to the real module. */
  _uat?: UatModule;
}

interface RouteAuditOpenOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock audit module. Defaults to the real module. */
  _audit?: AuditModule;
  /** Test seam: inject a mock core module to capture output calls. Defaults to the real module. */
  _core?: CoreModule;
}

// ─── routeAuditUat ────────────────────────────────────────────────────────────

function routeAuditUat({ args, cwd, raw, error, _uat }: RouteAuditUatOptions): void {
  // Suppress unused-variable warnings for args/error — this command has no
  // subcommands and passes raw through directly to the uat module.
  void args;
  void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const u: UatModule = _uat ?? require('./uat.cjs');
  u.cmdAuditUat(cwd, raw);
}

// ─── routeAuditOpen ──────────────────────────────────────────────────────────

function routeAuditOpen({ args, cwd, raw, error, _audit, _core }: RouteAuditOpenOptions): void {
  // Suppress unused-variable warning for error — audit-open has no subcommand
  // dispatch that would call error(); only flag parsing occurs here.
  void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const a: AuditModule = _audit ?? require('./audit.cjs');
  const c: CoreModule = _core ?? core;
  const wantJson = args.includes('--json');
  const result = a.auditOpenArtifacts(cwd);
  if (wantJson) {
    // core.output JSON-stringifies its first arg; pass the object directly.
    c.output(result, raw);
  } else {
    // Human-readable report must bypass JSON encoding — use the rawValue
    // form (third arg) which core.output emits verbatim.
    c.output(null, true, a.formatAuditReport(result));
  }
}

export = {
  routeAuditUat,
  routeAuditOpen,
};

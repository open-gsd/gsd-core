'use strict';
/**
 * Intel command router — CLI subcommand dispatcher for `gsd-tools intel`.
 *
 * ADR-959 (phase 4d-impl-4): intel command family cutover — last first-party
 * command cutover in the initial capability rollout.
 * Extracted from the hardcoded `case 'intel':` arm in gsd-tools.cjs.
 * Behaviour is preserved byte-for-behaviour from the prior inline case;
 * the dispatch path now flows: default → dispatchCapabilityCommand →
 * require(intel-command-router.cjs) → routeIntelCommand.
 *
 * Router signature: { args, cwd, raw, error } — identical to the existing
 * host routers. No new handler/arg convention; the capability registry
 * discovers this router by name.
 *
 * Arg indexing (preserved exactly from the original case):
 *   args[0] = 'intel'       (family — matched by dispatchCapabilityCommand)
 *   args[1] = subcommand    (query | status | diff | snapshot | patch-meta |
 *                            validate | extract-exports | update | api-surface)
 *   args[2] = term (query) | filePath (patch-meta | extract-exports)
 *
 * Notable: the `status` subcommand applies a `timeAgo` transform on
 * `status.files[*].updated_at` in non-raw mode — preserved exactly.
 *
 * Test seams: pass `_intel` to inject a mock intel module; pass `_core` to
 * inject a mock core module (captures `output` calls and provides a
 * deterministic `timeAgo` without writing to real stdout).  The `_`-prefix
 * follows the repo's established seam convention (see audit-command-router.cts
 * for the `_core` seam pattern).  Production callers omit both.
 *
 * Note on `error(); return` pairs: in production `error()` calls
 * `process.exit(1)` so the `return` is an equivalent no-op halt. The pairs
 * are kept for lint/control-flow clarity; they do NOT change behaviour.
 *
 * Lazy require: intel.cjs is required INSIDE the route function so it is
 * only loaded when an intel command is actually dispatched (preserves
 * equivalence with the old inline case arm which required it at the top of
 * the case block).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import path = require('path');
// Phase 2 (#1646): route through the Hub per ADR-959 §III(B) line 75.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');

const { ERROR_REASON } = io;
const { makeInvalidArgs } = commandRoutingHub;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
// Default CoreModule implementation assembled from leaf modules.
// _core seam overrides this entirely for test injection.
const _defaultCore = { output: io.output, timeAgo: coreUtils.timeAgo };

// ─── Types ────────────────────────────────────────────────────────────────────

interface IntelModule {
  intelQuery(term: string, planningDir: string): unknown;
  intelStatus(planningDir: string): { files?: Record<string, { updated_at?: string }> };
  intelDiff(planningDir: string): unknown;
  intelSnapshot(planningDir: string): unknown;
  intelValidate(planningDir: string): unknown;
  intelUpdate(planningDir: string): unknown;
  intelApiSurface(planningDir: string): unknown;
  intelPatchMeta(filePath: string): unknown;
  intelExtractExports(filePath: string): unknown;
}

interface CoreModule {
  output(value: unknown, raw: boolean): void;
  timeAgo(date: Date): string;
}

interface RouteIntelCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock intel module. Defaults to the real module. */
  _intel?: IntelModule;
  /** Test seam: inject a mock core module to capture output calls and provide
   *  a deterministic timeAgo. Defaults to the real module. */
  _core?: CoreModule;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeIntelCommand({ args, cwd, raw, error, _intel, _core }: RouteIntelCommandOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const intel: IntelModule = _intel ?? require('./intel.cjs');
  const c: CoreModule = _core ?? _defaultCore;

  // Phase 2 (#1646): routes through the Command Routing Hub per ADR-959 §III(B)
  // line 75. Validation handlers return `makeInvalidArgs(...)` Results; the
  // Hub → adapter translation preserves ERROR_REASON granularity via the
  // exitReason field (Phase 1, #1644). Success handlers keep direct `c.output()`
  // calls. The timeAgo mutation in non-raw `status` is preserved. Lazy require
  // of intel.cjs inside the function is preserved (loads only when dispatched).
  routeHubCommandFamily({
    family: 'intel',
    args,
    // Alphabetical for stable unknownMessage text; the integration test asserts
    // inclusion of all 9 subcommands, not order.
    subcommands: ['api-surface', 'diff', 'extract-exports', 'patch-meta', 'query', 'snapshot', 'status', 'update', 'validate'],
    handlers: {
      query: () => {
        const term = args[2];
        if (!term) {
          return makeInvalidArgs('term', 'Usage: gsd-tools intel query <term>', ERROR_REASON.USAGE);
        }
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelQuery(term, planningDir), raw);
      },
      status: () => {
        const planningDir = path.join(cwd, '.planning');
        const status = intel.intelStatus(planningDir);
        if (!raw && status.files) {
          for (const file of Object.values(status.files)) {
            if (file.updated_at) {
              file.updated_at = c.timeAgo(new Date(file.updated_at));
            }
          }
        }
        c.output(status, raw);
      },
      diff: () => {
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelDiff(planningDir), raw);
      },
      snapshot: () => {
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelSnapshot(planningDir), raw);
      },
      'patch-meta': () => {
        const filePath = args[2];
        if (!filePath) {
          return makeInvalidArgs('file-path', 'Usage: gsd-tools intel patch-meta <file-path>', ERROR_REASON.USAGE);
        }
        c.output(intel.intelPatchMeta(path.resolve(cwd, filePath)), raw);
      },
      validate: () => {
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelValidate(planningDir), raw);
      },
      'extract-exports': () => {
        const filePath = args[2];
        if (!filePath) {
          return makeInvalidArgs('file-path', 'Usage: gsd-tools intel extract-exports <file-path>', ERROR_REASON.USAGE);
        }
        c.output(intel.intelExtractExports(path.resolve(cwd, filePath)), raw);
      },
      update: () => {
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelUpdate(planningDir), raw);
      },
      'api-surface': () => {
        const planningDir = path.join(cwd, '.planning');
        c.output(intel.intelApiSurface(planningDir), raw);
      },
    },
    unknownMessage: (subcommand: string, available: string[]) =>
      `Unknown intel subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeIntelCommand,
};

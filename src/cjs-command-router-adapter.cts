/**
 * CJS Command Router Adapter Module
 *
 * Compatibility routing for gsd-tools.cjs command families. Uses generated
 * command metadata for availability and small family-local argument shapers for
 * CJS handler calls.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/cjs-command-router-adapter.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
const { createHub, ERROR_KINDS } = commandRoutingHub;

// ─── Types ────────────────────────────────────────────────────────────────────

type Handler = () => unknown;

interface RouteCjsCommandFamilyOptions {
  args: string[];
  subcommands: string[];
  handlers: Record<string, Handler>;
  defaultSubcommand?: string;
  unsupported?: Record<string, string>;
  unknownMessage: (subcommand: string, available: string[]) => string;
  error: (message: string) => void;
  cwd?: string;
  raw?: boolean;
}

interface RouteHubCommandFamilyOptions {
  family: string;
  args: string[];
  subcommands: string[];
  handlers: Record<string, Handler>;
  defaultSubcommand?: string;
  unsupported?: Record<string, string>;
  unknownMessage: (subcommand: string, available: string[]) => string;
  error: (message: string) => void;
  cwd?: string;
  raw?: boolean;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeCjsCommandFamily({
  args,
  subcommands,
  handlers,
  defaultSubcommand,
  unsupported = {},
  unknownMessage,
  error,
  cwd,
  raw,
}: RouteCjsCommandFamilyOptions): void {
  routeHubCommandFamily({
    family: '__legacy_cjs_family__',
    args,
    subcommands,
    handlers,
    defaultSubcommand,
    unsupported,
    unknownMessage,
    error,
    cwd,
    raw,
  });
}

/**
 * Hub-backed family router adapter.
 *
 * Deepens the command-topology seam by routing family handlers through
 * CommandRoutingHub's typed Result contract instead of ad-hoc per-router
 * lookup + error handling branches.
 */
function routeHubCommandFamily({
  family,
  args,
  subcommands,
  handlers,
  defaultSubcommand,
  unsupported = {},
  unknownMessage,
  error,
  cwd,
  raw,
}: RouteHubCommandFamilyOptions): void {
  const subcommand = args[1] || defaultSubcommand;

  if (subcommand && unsupported[subcommand]) {
    error(unsupported[subcommand]);
    return;
  }

  const available = subcommands.filter((s) => !unsupported[s]);
  const registryHandlers = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (): { ok: true; data: unknown } => {
        const result = handler();
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
          return result as { ok: true; data: unknown };
        }
        return { ok: true as const, data: null };
      },
    ]),
  );

  const hub = createHub({
    cjsRegistry: { [family]: registryHandlers },
    manifest: { [family]: available },
  });

  const result = hub.dispatch({
    family,
    subcommand,
    args: args.slice(2),
    cwd,
    raw,
  });

  if (result.ok) return;
  if (result.kind === ERROR_KINDS.UnknownCommand) {
    error(unknownMessage(subcommand ?? '', available));
    return;
  }
  if (result.kind === ERROR_KINDS.InvalidArgs || result.kind === ERROR_KINDS.HandlerRefusal) {
    error((result as { reason: string }).reason);
    return;
  }
  error((result as { message: string }).message);
}

export = {
  routeCjsCommandFamily,
  routeHubCommandFamily,
};

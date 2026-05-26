'use strict';

const { createHub, ERROR_KINDS } = require('./command-routing-hub.cjs');

/**
 * CJS Command Router Adapter Module
 *
 * Compatibility routing for gsd-tools.cjs command families. Uses generated
 * command metadata for availability and small family-local argument shapers for
 * CJS handler calls.
 */

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
}) {
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
}) {
  const subcommand = args[1] || defaultSubcommand;

  if (subcommand && unsupported[subcommand]) {
    error(unsupported[subcommand]);
    return;
  }

  const available = subcommands.filter((s) => !unsupported[s]);
  const registryHandlers = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      () => {
        const result = handler();
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
          return result;
        }
        return { ok: true, data: null };
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
    error(unknownMessage(subcommand, available));
    return;
  }
  if (result.kind === ERROR_KINDS.InvalidArgs || result.kind === ERROR_KINDS.HandlerRefusal) {
    error(result.reason);
    return;
  }
  error(result.message);
}

/**
 * Projection helper for family routers that still declare SDK registry metadata
 * but execute the CJS fallback path at this seam.
 *
 * Accepts variable argument shapes so routers can pass legacy projection tuples
 * (`registryCommand`, `registryArgs`, `legacyArgs`, optional `rawFormatter`, `cjsFallback`).
 */
function cjsFallbackHandler(...projectionArgs) {
  return projectionArgs[projectionArgs.length - 1];
}

module.exports = {
  routeCjsCommandFamily,
  routeHubCommandFamily,
  cjsFallbackHandler,
};

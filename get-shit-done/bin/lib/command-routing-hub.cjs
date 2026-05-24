'use strict';

/**
 * Command Routing Hub — issue #3788, simplified in #175.
 *
 * A pure-result dispatch hub that centralizes CJS routing,
 * the error taxonomy, and the no-throw contract that all command-family routers
 * currently duplicate independently.
 *
 * Design:
 *   createHub({ cjsRegistry, manifest }) -> hub
 *   hub.dispatch({ family, subcommand, args, cwd, raw })  -> Result
 *
 *   Result = { ok: true, data }
 *           | { ok: false, errorKind, message, details? }
 *
 * Invariants:
 *   - Hub always routes through CJS handlers. There is no SDK path (#175).
 *   - Hub never prints to stdout/stderr, never calls process.exit.
 *   - Hub never throws — all internal throws are caught and converted to
 *     { ok: false, errorKind: 'HandlerFailure', message, details }.
 *   - The errorKind taxonomy is closed. Callers switch on ERROR_KINDS values.
 */

/**
 * Closed errorKind enum. Export as a frozen object so callers can switch on
 * ERROR_KINDS.UnknownCommand etc. without relying on bare string literals.
 *
 * #175: SdkLoadFailed and SdkDispatchFailed removed — Hub is CJS-only.
 *
 * @readonly
 */
const ERROR_KINDS = Object.freeze({
  /** The requested family/subcommand combination is not present in the manifest. */
  UnknownCommand: 'UnknownCommand',
  /** The handler rejected the supplied arguments before executing. */
  InvalidArgs: 'InvalidArgs',
  /** A CJS handler returned an explicit refusal (e.g. unsupported subcommand). */
  HandlerRefusal: 'HandlerRefusal',
  /** A handler threw an unexpected exception. */
  HandlerFailure: 'HandlerFailure',
});

/**
 * @typedef {{ ok: true, data: unknown }} OkResult
 * @typedef {{ ok: false, errorKind: string, message: string, details?: unknown }} ErrResult
 * @typedef {OkResult | ErrResult} HubResult
 */

/**
 * @typedef {object} HubOptions
 * @property {Record<string, Record<string, (ctx: object) => HubResult>>} [cjsRegistry] -
 *   Nested map of family -> subcommand -> handler.
 * @property {Record<string, string[]>} [manifest] - Map of family -> known subcommands.
 *   Used for UnknownCommand detection.
 */

/**
 * Construct a CommandRoutingHub.
 *
 * @param {HubOptions} options
 * @returns {{ dispatch: (req: object) => HubResult }}
 */
function createHub({ cjsRegistry, manifest } = {}) {
  const _cjsRegistry = cjsRegistry;
  const _manifest = manifest;

  /**
   * Dispatch a command through the hub.
   *
   * @param {{ family: string, subcommand: string, args?: unknown[], cwd?: string, raw?: boolean }} req
   * @returns {HubResult}
   */
  function dispatch(req) {
    try {
      return _dispatch(req);
    } catch (err) {
      return {
        ok: false,
        errorKind: ERROR_KINDS.HandlerFailure,
        message: err instanceof Error ? err.message : String(err),
        details: { originalError: err },
      };
    }
  }

  function _dispatch(req) {
    const { family, subcommand, args = [], cwd, raw } = req;

    // ── manifest check ────────────────────────────────────────────────────────
    if (_manifest) {
      const knownSubcommands = _manifest[family];
      if (!knownSubcommands) {
        return {
          ok: false,
          errorKind: ERROR_KINDS.UnknownCommand,
          message: `Unknown command family: ${family}`,
        };
      }
      if (subcommand && !knownSubcommands.includes(subcommand)) {
        return {
          ok: false,
          errorKind: ERROR_KINDS.UnknownCommand,
          message: `Unknown subcommand: ${family} ${subcommand}`,
        };
      }
    }

    return _dispatchCjs({ family, subcommand, args, cwd, raw });
  }

  function _dispatchCjs({ family, subcommand, args, cwd, raw }) {
    if (!_cjsRegistry) {
      return {
        ok: false,
        errorKind: ERROR_KINDS.UnknownCommand,
        message: `No CJS registry provided for family: ${family}`,
      };
    }

    const familyHandlers = _cjsRegistry[family];
    if (!familyHandlers) {
      return {
        ok: false,
        errorKind: ERROR_KINDS.UnknownCommand,
        message: `Unknown command family: ${family}`,
      };
    }

    const handler = subcommand ? familyHandlers[subcommand] : familyHandlers[''];
    if (typeof handler !== 'function') {
      return {
        ok: false,
        errorKind: ERROR_KINDS.UnknownCommand,
        message: `Unknown subcommand: ${family} ${subcommand}`,
      };
    }

    // Invoke the handler. It must return a HubResult or throw.
    // If it throws, the outer try/catch in dispatch() catches it.
    const result = handler({ family, subcommand, args, cwd, raw });

    // If the handler returned a well-formed HubResult, pass it through.
    if (result && typeof result === 'object' && 'ok' in result) {
      return result;
    }

    // If the handler returned nothing (undefined), treat as success with no data.
    if (result === undefined || result === null) {
      return { ok: true, data: null };
    }

    // Any other return value is treated as the data payload.
    return { ok: true, data: result };
  }

  return { dispatch };
}

module.exports = {
  createHub,
  ERROR_KINDS,
};

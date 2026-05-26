'use strict';

/**
 * Command Argument Projection Module
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 */

/**
 * Extract named --flag <value> pairs from an args array.
 * Returns an object mapping flag names to their values (null if absent).
 * Flags listed in `booleanFlags` are treated as booleans.
 *
 * @param {string[]} args
 * @param {string[]} [valueFlags]
 * @param {string[]} [booleanFlags]
 * @returns {Record<string, string|boolean|null>}
 */
function parseNamedArgs(args, valueFlags = [], booleanFlags = []) {
  const result = {};
  for (const flag of valueFlags) {
    const idx = args.indexOf(`--${flag}`);
    result[flag] = idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')
      ? args[idx + 1]
      : null;
  }
  for (const flag of booleanFlags) {
    result[flag] = args.includes(`--${flag}`);
  }
  return result;
}

/**
 * Collect all tokens after --flag until the next --flag or end of args.
 *
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|null}
 */
function parseMultiwordArg(args, flag) {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1) return null;
  const tokens = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    tokens.push(args[i]);
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

module.exports = {
  parseNamedArgs,
  parseMultiwordArg,
};

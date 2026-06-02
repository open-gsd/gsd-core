/**
 * Command Argument Projection Module (ADR-457 build-at-publish: the
 * hand-written bin/lib/command-arg-projection.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 */

/**
 * Extract named --flag <value> pairs from an args array.
 * Returns an object mapping flag names to their values (null if absent).
 * Flags listed in `booleanFlags` are treated as booleans.
 */
export function parseNamedArgs(
  args: string[],
  valueFlags: string[] = [],
  booleanFlags: string[] = [],
): Record<string, string | boolean | null> {
  // Index each token's first position once (firstIndex.get(t) ?? -1 === args.indexOf(t),
  // firstIndex.has(t) === args.includes(t)) so the flag loops below don't each re-scan
  // argv — O(argv + flags) instead of O(flags * argv). Semantics are unchanged. (#312)
  const firstIndex = new Map<string, number>();
  for (let i = 0; i < args.length; i++) {
    if (!firstIndex.has(args[i])) firstIndex.set(args[i], i);
  }
  const result: Record<string, string | boolean | null> = {};
  for (const flag of valueFlags) {
    const idx = firstIndex.has(`--${flag}`) ? (firstIndex.get(`--${flag}`) as number) : -1;
    result[flag] =
      idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')
        ? args[idx + 1]
        : null;
  }
  for (const flag of booleanFlags) {
    result[flag] = firstIndex.has(`--${flag}`);
  }
  return result;
}

/**
 * Collect all tokens after --flag until the next --flag or end of args.
 */
export function parseMultiwordArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1) return null;
  const tokens: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    tokens.push(args[i]);
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

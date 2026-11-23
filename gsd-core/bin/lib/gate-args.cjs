"use strict";
/**
 * Gate argv parsing — the one `--flag value` / positional splitter the flag-taking `check` verbs
 * share (#5139, epic #5056, design D2/D3).
 *
 * Moved verbatim from `check-command-router.cts` so a gate module can take the argv after its verb
 * and the router's `check predicate` arm can keep using the same parser: there is exactly one, so
 * the flag-taking check verbs cannot drift apart. Pure; no I/O.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.partitionPredicateArgs = partitionPredicateArgs;
exports.parsePredicateFlags = parsePredicateFlags;
/**
 * Split an args array into `--flag value` pairs and the leftover positional
 * tokens, in ONE pass, with the semantics `check predicate` established
 * (#2008): a `--flag` followed by a non-`--` token consumes it as the value
 * (last write wins); a `--flag` with no value stays a bare token and moves to
 * the positionals; everything else is positional. `parsePredicateFlags` is
 * the flags half of this same pass — there is exactly one parser, so the
 * flag-taking check verbs cannot drift apart (#4130 follow-up: `check
 * decision-coverage-plan --context <path>` shares it).
 */
function partitionPredicateArgs(args) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (typeof a !== 'string')
            continue;
        if (!a.startsWith('--')) {
            positionals.push(a);
            continue;
        }
        const key = a.slice(2);
        const next = args[i + 1];
        if (key.length > 0 && typeof next === 'string' && !next.startsWith('--')) {
            // defineProperty, not `flags[key] = next`: an own data property for EVERY caller-supplied
            // key. A plain assignment of `--__proto__ v` set nothing (the pair was consumed and its
            // value silently lost), and assigning through a caller-controlled key is the
            // prototype-pollution sink shape.
            Object.defineProperty(flags, key, { value: next, enumerable: true, writable: true, configurable: true });
            i++;
        }
        else {
            positionals.push(a);
        }
    }
    return { flags, positionals };
}
/** Parse `--flag value` pairs from an args array into a map (last write wins). */
function parsePredicateFlags(args) {
    return partitionPredicateArgs(args).flags;
}

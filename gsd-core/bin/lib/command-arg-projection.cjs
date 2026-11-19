"use strict";
/**
 * Command Argument Projection Module (ADR-457 build-at-publish: the
 * hand-written bin/lib/command-arg-projection.cjs collapsed to a TypeScript
 * source of truth).
 *
 * ADR-3473 §8.4 ("failure is a value"): `parseNamedArgs` is now strict and
 * returns a `Result` instead of silently accepting unrecognized or stray
 * positional tokens. See .gsd/phase/feat-3884-failure-is-a-value/40-design.md
 * for the full behavior table (A1-A18) and negative-space section (N1-N8).
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 * `requiredFlags` (ADR-4909 D1, #6087) turns a missing value-flag into InvalidArgs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFlagToken = isFlagToken;
exports.parseNamedArgs = parseNamedArgs;
exports.parseNamedArgsOrExit = parseNamedArgsOrExit;
exports.parseMultiwordArg = parseMultiwordArg;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
const { ERROR_REASON, formatDiagnosticToken } = io;
// ─── Internal helpers ─────────────────────────────────────────────────────────
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * ADR-3473 Decision 2: both ends of this seam are gsd-core's own source, so a
 * malformed spec (a stale call site still using the legacy
 * `parseNamedArgs(args, valueFlags, booleanFlags)` shape, or a missing spec
 * entirely) is an internal invariant violation, not user input — it throws
 * loudly instead of destructuring `undefined` off a Result.
 */
function assertValidSpec(spec) {
    if (!isPlainObject(spec)) {
        throw new TypeError('parseNamedArgs: spec must be an object of shape ' +
            '{ valueFlags?: string[], booleanFlags?: string[], positionals: number | "rest" }. ' +
            'Received a missing, array, or non-object value — this is the legacy ' +
            'parseNamedArgs(args, valueFlags, booleanFlags) call shape, retired by ADR-3473 §8.4.');
    }
    const positionals = spec.positionals;
    const positionalsValid = positionals === 'rest' ||
        (typeof positionals === 'number' && Number.isInteger(positionals) && positionals >= 0);
    if (!positionalsValid) {
        throw new TypeError('parseNamedArgs: spec.positionals must be a non-negative integer or the literal "rest" ' +
            `— received ${JSON.stringify(positionals)}.`);
    }
    if (spec.freePositionals !== undefined && (spec.freePositionals !== true || positionals === 'rest')) {
        throw new TypeError('parseNamedArgs: spec.freePositionals must be true and cannot be combined with positionals "rest" ' +
            `— received freePositionals ${JSON.stringify(spec.freePositionals)} with positionals ${JSON.stringify(positionals)}.`);
    }
    if (spec.rejectShortFlags !== undefined && spec.rejectShortFlags !== true) {
        throw new TypeError(`parseNamedArgs: spec.rejectShortFlags must be true — received ${JSON.stringify(spec.rejectShortFlags)}.`);
    }
    if (spec.unknownFlagMessage !== undefined &&
        (typeof spec.unknownFlagMessage !== 'string' || !spec.unknownFlagMessage.includes('{flag}'))) {
        throw new TypeError(`parseNamedArgs: spec.unknownFlagMessage must be a string containing the {flag} placeholder — received ${JSON.stringify(spec.unknownFlagMessage)}.`);
    }
    for (const kind of VALUE_SUBSET_KINDS)
        assertSubsetOf(spec, kind, 'valueFlags');
    assertSubsetOf(spec, 'emptyValueFlags', 'nonEmptyFlags');
    assertSubsetOf(spec, 'emptyEqFlags', 'nonEmptyFlags');
    assertSubsetOf(spec, 'emptyEqFlags', 'eqFlags');
    assertSubsetOf(spec, 'trimEqFlags', 'eqFlags');
    assertSubsetOf(spec, 'blankIsMissingFlags', 'nonEmptyFlags');
    assertEqRejectPrefix(spec);
    if (spec.missingValueMessage !== undefined &&
        (typeof spec.missingValueMessage !== 'string' || !spec.missingValueMessage.includes('{flag}'))) {
        throw new TypeError(`parseNamedArgs: spec.missingValueMessage must be a string containing the {flag} placeholder — received ${JSON.stringify(spec.missingValueMessage)}.`);
    }
    for (const kind of INDEPENDENT_KINDS)
        assertIndependentKind(spec, kind);
    if (spec.passthroughAfter !== undefined && spec.passthroughAfter !== '--') {
        throw new TypeError(`parseNamedArgs: spec.passthroughAfter must be the literal "--" — received ${JSON.stringify(spec.passthroughAfter)}.`);
    }
}
const VALUE_SUBSET_KINDS = [
    'requiredFlags',
    'eqFlags',
    'nonEmptyFlags',
    'bareEmptyFlags',
    'repeatableFlags',
];
// Kinds that own their tokens: a flag may not also be a plain value, boolean or
// optional flag, nor belong to the other independent kind.
const INDEPENDENT_KINDS = ['listFlags', 'multiwordFlags'];
function assertStringArray(spec, kind) {
    const list = spec[kind];
    if (list === undefined)
        return null;
    if (!Array.isArray(list) || !list.every((f) => typeof f === 'string')) {
        throw new TypeError(`parseNamedArgs: spec.${kind} must be an array of strings.`);
    }
    return list;
}
function assertSubsetOf(spec, kind, parent) {
    const list = assertStringArray(spec, kind);
    if (list === null)
        return;
    const declared = Array.isArray(spec[parent]) ? spec[parent] : [];
    const stray = list.filter((f) => !declared.includes(f));
    if (stray.length > 0) {
        throw new TypeError(`parseNamedArgs: spec.${kind} must be a subset of spec.${parent} — ` +
            `not declared in ${parent}: ${stray.join(', ')}`);
    }
}
function assertEqRejectPrefix(spec) {
    const map = spec.eqRejectPrefix;
    if (map === undefined)
        return;
    if (!isPlainObject(map) || !Object.values(map).every((p) => typeof p === 'string' && p !== '')) {
        throw new TypeError('parseNamedArgs: spec.eqRejectPrefix must map flag names to non-empty prefix strings.');
    }
    const flags = Object.keys(map);
    for (const parent of ['eqFlags', 'nonEmptyFlags']) {
        const declared = Array.isArray(spec[parent]) ? spec[parent] : [];
        const stray = flags.filter((f) => !declared.includes(f));
        if (stray.length > 0) {
            throw new TypeError(`parseNamedArgs: spec.eqRejectPrefix must be a subset of spec.${parent} — ` +
                `not declared in ${parent}: ${stray.join(', ')}`);
        }
    }
}
function assertIndependentKind(spec, kind) {
    const list = assertStringArray(spec, kind);
    if (list === null)
        return;
    const others = ['valueFlags', 'booleanFlags', 'optionalValueFlags', ...INDEPENDENT_KINDS.filter((k) => k !== kind)];
    for (const other of others) {
        const clash = list.filter((f) => Array.isArray(spec[other]) && spec[other].includes(f));
        if (clash.length > 0) {
            throw new TypeError(`parseNamedArgs: spec.${kind} must be disjoint from spec.${other} — ` +
                `declared in both: ${clash.join(', ')}`);
        }
    }
}
/**
 * First required flag (declaration order) whose extracted value is `null`
 * (absent or flag-shaped) or `''`, as an InvalidArgs result; else null.
 */
function missingRequired(spec, data) {
    for (const flag of spec.requiredFlags ?? []) {
        const value = data[flag];
        if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
            return {
                ok: false,
                kind: 'InvalidArgs',
                arg: `--${flag}`,
                reason: `missing required flag --${flag} <value>`,
                exitReason: ERROR_REASON.USAGE,
            };
        }
    }
    return null;
}
/**
 * Whether the occurrence of a `nonEmptyFlags` member carries no value, per the
 * `emptyValueFlags` / `emptyEqFlags` relaxations: no next token or a flag-shaped
 * one always counts as missing; an empty next token and an empty or
 * whitespace-only `--f=` value count unless relaxed.
 */
function lacksValue(args, spec, flag, occ) {
    const blankMissing = (spec.blankIsMissingFlags ?? []).includes(flag);
    if (occ.inline !== null) {
        const prefix = spec.eqRejectPrefix?.[flag];
        if (prefix !== undefined && occ.inline.startsWith(prefix))
            return true;
        return occ.inline.trim() === '' && (blankMissing || !(spec.emptyEqFlags ?? []).includes(flag));
    }
    const next = args[occ.index + 1];
    if (next === undefined || isFlagToken(next))
        return true;
    if (blankMissing && next.trim() === '')
        return true;
    return next === '' && !(spec.emptyValueFlags ?? []).includes(flag);
}
/**
 * First `nonEmptyFlags` member (declaration order) that is present (`--f` or
 * `--f=` occurs) without a value, as an InvalidArgs result with today's wording
 * (`Missing value for --f`); else null. The first occurrence is checked, except
 * for a repeatable flag, whose last occurrence is.
 */
function missingValue(args, spec, occurrences) {
    for (const flag of spec.nonEmptyFlags ?? []) {
        const occs = occurrences.get(flag);
        if (occs === undefined)
            continue;
        const occ = (spec.repeatableFlags ?? []).includes(flag) ? occs[occs.length - 1] : occs[0];
        if (lacksValue(args, spec, flag, occ)) {
            return {
                ok: false,
                kind: 'InvalidArgs',
                arg: `--${flag}`,
                reason: spec.missingValueMessage !== undefined
                    ? spec.missingValueMessage.split('{flag}').join(`--${flag}`)
                    : `Missing value for --${flag}`,
                exitReason: ERROR_REASON.USAGE,
            };
        }
    }
    return null;
}
/** Single pass over argv: flag name -> its occurrences in argv order. */
function indexOccurrences(args, eq) {
    const map = new Map();
    args.forEach((tok, index) => {
        if (!isFlagToken(tok))
            return;
        const eqAt = tok.indexOf('=');
        const eqName = eqAt > 2 ? tok.slice(2, eqAt) : null;
        const isEq = eqName !== null && eq.has(eqName);
        const name = isEq ? eqName : tok.slice(2);
        const list = map.get(name) ?? [];
        list.push({ index, inline: isEq ? tok.slice(eqAt + 1) : null });
        map.set(name, list);
    });
    return map;
}
/**
 * The value an occurrence carries: `null` when absent or flag-shaped, or when
 * `--f=` is empty (unless `emptyEqFlags` makes it a value).
 */
function occurrenceValue(args, spec, flag, occ) {
    if (occ.inline !== null) {
        const inline = (spec.trimEqFlags ?? []).includes(flag) ? occ.inline.trim() : occ.inline;
        return inline === '' && !(spec.emptyEqFlags ?? []).includes(flag) ? null : inline;
    }
    const next = args[occ.index + 1];
    return next !== undefined && !isFlagToken(next) ? next : null;
}
function extractValueFlag(args, spec, flag, occs) {
    if ((spec.repeatableFlags ?? []).includes(flag)) {
        // An empty or flag-shaped value contributes nothing to a repeatable flag.
        return occs
            .map((o) => occurrenceValue(args, spec, flag, o))
            .filter((v) => v !== null && v !== '');
    }
    if (occs.length === 0)
        return null;
    const value = occurrenceValue(args, spec, flag, occs[0]);
    const bareEmpty = (spec.bareEmptyFlags ?? []).includes(flag) && occs[0].inline === null;
    return value === null && bareEmpty ? '' : value;
}
/**
 * Every occurrence of `--flag` starts a run of non-`--` tokens that ends at
 * the next list flag of the spec (gsd-tools.cjs `collectListFlagValues`).
 */
function collectListValues(args, flag, stops, sets) {
    const values = [];
    args.forEach((a, i) => {
        if (a !== `--${flag}`)
            return;
        let j = i + 1;
        while (j < args.length) {
            const b = args[j];
            if (stops.has(b))
                break;
            if (isFlagToken(b)) {
                // Step over exactly what the walk steps over, so a word the walk reads
                // as a flag's value is never also collected; a bare `--` advances by 1.
                j += advanceOverFlag(args, j, sets) ?? 1;
                continue;
            }
            values.push(b);
            j += 1;
        }
    });
    return values;
}
function extractData(args, spec, occurrences) {
    const data = {};
    for (const flag of spec.valueFlags ?? []) {
        data[flag] = extractValueFlag(args, spec, flag, occurrences.get(flag) ?? []);
    }
    // Boolean and optional-value flags (#2932: `--wave`-shaped) are presence
    // tests; the optional value is deliberately not surfaced here.
    for (const flag of [...(spec.booleanFlags ?? []), ...(spec.optionalValueFlags ?? [])]) {
        data[flag] = occurrences.has(flag);
    }
    const listFlags = spec.listFlags ?? [];
    const stops = new Set(listFlags.map((f) => `--${f}`));
    const sets = buildFlagSets(spec);
    for (const flag of listFlags)
        data[flag] = collectListValues(args, flag, stops, sets);
    for (const flag of spec.multiwordFlags ?? [])
        data[flag] = parseMultiwordArg(args, flag);
    return data;
}
function buildFlagSets(spec) {
    const value = spec.valueFlags ?? [];
    const bool = spec.booleanFlags ?? [];
    const optional = spec.optionalValueFlags ?? [];
    const list = spec.listFlags ?? [];
    const multiword = spec.multiwordFlags ?? [];
    return {
        value: new Set(value),
        boolean: new Set(bool),
        optional: new Set(optional),
        eq: new Set(spec.eqFlags ?? []),
        list: new Set(list),
        multiword: new Set(multiword),
        accepted: [
            ...value.map((f) => `--${f} <value>`),
            ...bool.map((f) => `--${f}`),
            ...optional.map((f) => `--${f} [value]`),
            ...list.map((f) => `--${f} <values...>`),
            ...multiword.map((f) => `--${f} <words...>`),
        ],
    };
}
// A short flag is a dash followed by a letter; `-1` (negative number) and `-` are not flags.
const SHORT_FLAG_RE = /^-[A-Za-z]/;
/** Tokens consumed by the flag at `args[i]`, or null when the flag is not declared. */
function advanceOverFlag(args, i, sets) {
    const tok = args[i];
    const eqAt = tok.indexOf('=');
    if (eqAt > 2 && sets.eq.has(tok.slice(2, eqAt)))
        return 1;
    const name = tok.slice(2);
    const next = args[i + 1];
    const hasValue = next !== undefined && !isFlagToken(next);
    // A value flag whose next token is absent or flag-shaped resolves to `null`
    // in `data` — NOT an error (#3180/behavior-lock). Advance by 1 so the
    // following flag token is validated on its own merits.
    if (sets.value.has(name) || sets.optional.has(name))
        return hasValue ? 2 : 1;
    if (sets.boolean.has(name) || sets.list.has(name))
        return 1;
    if (sets.multiword.has(name)) {
        let n = 1;
        while (args[i + n] !== undefined && !isFlagToken(args[i + n]))
            n++;
        return n;
    }
    return null;
}
function unknownFlag(tok, sets, spec) {
    const template = spec.unknownFlagMessage;
    const reason = template !== undefined
        ? template.split('{flag}').join(tok)
        : sets.accepted.length > 0
            ? `unknown flag ${formatDiagnosticToken(tok)}; accepted: ${sets.accepted.join(', ')}`
            : `unknown flag ${formatDiagnosticToken(tok)}; this command accepts no flags`;
    return { ok: false, kind: 'InvalidArgs', arg: tok, reason, exitReason: ERROR_REASON.USAGE };
}
/**
 * Left-to-right cursor walk from `spec.positionals`. Once a list flag has
 * been seen, non-flag tokens belong to its run (collectListFlagValues
 * semantics: a run is only ended by another list flag, which restarts it) and
 * are not stray positionals; `--` tokens inside a run are still validated.
 */
function walkTokens(args, spec) {
    const sets = buildFlagSets(spec);
    let inListRun = false;
    let i = spec.positionals === 'rest' ? args.length : spec.positionals;
    while (i < args.length) {
        const tok = args[i];
        if (spec.rejectShortFlags === true && SHORT_FLAG_RE.test(tok))
            return unknownFlag(tok, sets, spec);
        if (inListRun && tok === '--') {
            // collectListFlagValues skipped every `--`-prefixed token inside a run, so a bare `--` is accepted there.
            i += 1;
            continue;
        }
        if (isFlagToken(tok)) {
            const advance = advanceOverFlag(args, i, sets);
            if (advance === null)
                return unknownFlag(tok, sets, spec);
            if (sets.list.has(tok.slice(2)))
                inListRun = true;
            i += advance;
            continue;
        }
        if (!inListRun && spec.freePositionals !== true) {
            return {
                ok: false,
                kind: 'InvalidArgs',
                arg: tok,
                reason: `unexpected positional argument ${formatDiagnosticToken(tok)}`,
                exitReason: ERROR_REASON.USAGE,
            };
        }
        i += 1;
    }
    return null;
}
/** Split argv at the first literal `--` (passthroughAfter) at/after the positional boundary. */
function splitPassthrough(args, spec) {
    if (spec.passthroughAfter === undefined)
        return { head: args, tail: [] };
    const from = typeof spec.positionals === 'number' ? spec.positionals : 0;
    const at = args.indexOf(spec.passthroughAfter, from);
    return at === -1 ? { head: args, tail: [] } : { head: args.slice(0, at), tail: args.slice(at + 1) };
}
// Single predicate reused for both extraction (a value beginning with a
// single `-` is a value, not a flag) and validation (negative space N5).
// Exported for init-command-router's #3865 --phase alias normalization,
// which needs the same flag-shape test before deciding whether args[2] is a
// phase positional or a flag token.
function isFlagToken(tok) {
    return tok.startsWith('--');
}
function parseNamedArgs(args, spec) {
    assertValidSpec(spec);
    const { head, tail } = splitPassthrough(args, spec);
    const occurrences = indexOccurrences(head, new Set(spec.eqFlags ?? []));
    const data = extractData(head, spec, occurrences);
    if (spec.passthroughAfter !== undefined)
        data['--'] = tail;
    const invalid = (spec.positionals === 'rest' ? null : walkTokens(head, spec)) ??
        missingValue(head, spec, occurrences) ??
        missingRequired(spec, data);
    return invalid ?? { ok: true, data };
}
function parseNamedArgsOrExit(args, spec, fail) {
    const result = parseNamedArgs(args, spec);
    if (!result.ok) {
        fail(result.reason, result.exitReason);
        throw new Error(`parseNamedArgsOrExit: fail() returned instead of exiting (arg: ${result.arg})`);
    }
    return result.data;
}
/**
 * Collect all tokens after --flag until the next --flag or end of args.
 */
function parseMultiwordArg(args, flag) {
    const idx = args.indexOf(`--${flag}`);
    if (idx === -1)
        return null;
    const tokens = [];
    for (let i = idx + 1; i < args.length; i++) {
        if (args[i].startsWith('--'))
            break;
        tokens.push(args[i]);
    }
    return tokens.length > 0 ? tokens.join(' ') : null;
}

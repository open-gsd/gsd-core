"use strict";
/**
 * Task Content Resolution Module (ADR-3646 Phase 1, #3970).
 *
 * Given a task's `tracker-id` attribute value (parsed verbatim by
 * `plan-document.cts`, never split there) and the set of installed
 * capabilities' `taskContentResolver` declarations, resolves the task's
 * content from the matching external tracker via a bounded subprocess call —
 * or reports that no resolution applies.
 *
 * PURE / IMPURE SPLIT, loosely mirroring `review-lane-invocation.cts`'s
 * resolve-then-run shape, but deliberately NOT copying its full machinery
 * (Gall's Law — see `40-design.md`'s "Laws that apply" section): this problem
 * has no probe/model/effort/prompt-channel axes, just one deterministic
 * id-lookup. `splitTrackerId`, `findResolver`, and `buildInvocation` are pure
 * and total (never throw, even on hostile third-party-shaped input — a
 * capability manifest is third-party-authored, and while `capability-
 * validator.cjs` validates it at install time, this module re-validates
 * defensively rather than trusting that boundary). `resolveTaskContent` is
 * the one impure boundary: it spawns exactly one bounded subprocess, through
 * an injectable `execFn` so tests never spawn a real process or wait a real
 * timeout (CLAUDE.md's clock-seam rule).
 *
 * HARD-HALT CONTRACT (ADR-3646 Decision 4): an ambiguous resolver match, a
 * non-zero resolver exit, a timeout, or malformed resolver stdout all THROW.
 * None of these degrade to a silently-empty or silently-picked result — a
 * task-content resolution failure must halt the caller (`task-command-
 * router.cts`'s `resolve-content` subcommand turns each throw into the CLI's
 * own non-zero exit), never fall back to inline PLAN.md content pretending
 * nothing happened.
 *
 * ADR-457 build-at-publish: source in src/task-content-resolution.cts,
 * compiled to gsd-core/bin/lib/task-content-resolution.cjs (gitignored).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
// Use non-destructured namespace import so test-time mock.method(childProcess,
// 'spawnSync') can intercept calls from this seam — destructured imports
// capture references at load time and become un-mockable (matches the
// convention documented in shell-command-projection.cts).
const node_child_process_1 = __importDefault(require("node:child_process"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { formatDiagnosticToken } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityLoaderMod = require("./capability-loader.cjs");
// ─── Result taxonomy ──────────────────────────────────────────────────────────
/**
 * The four non-throwing outcomes of `resolveTaskContent`. Frozen because the
 * `kind` discriminant is the product — callers (the CLI seam) switch on it
 * directly rather than string-matching prose.
 */
const TASK_CONTENT_RESULT = Object.freeze({
    NOT_APPLICABLE: 'not-applicable',
    NO_RESOLVER: 'no-resolver',
    RESOLVED: 'resolved',
    EMPTY: 'empty',
});
// ─── Throwable error taxonomy ─────────────────────────────────────────────────
// These four ALWAYS throw — they are configuration/execution defects, never a
// value `resolveTaskContent` returns. See the module docstring's hard-halt
// contract.
/**
 * Two or more installed capabilities declare a `taskContentResolver` for the
 * same `trackerPrefix`. Structurally impossible in a correctly-validated
 * install (`capability-validator.cjs` enforces cross-capability prefix
 * uniqueness), but `findResolver` must still refuse to silently pick one if a
 * test harness or a validator bug ever produces this shape.
 */
class ResolverAmbiguousError extends Error {
    prefix;
    capabilityIds;
    constructor(prefix, capabilityIds) {
        super(`tracker prefix '${prefix}' matches ${capabilityIds.length} installed capability resolvers ` +
            `(${capabilityIds.join(', ')}) — ambiguous resolver registration must never silently pick one`);
        this.name = 'ResolverAmbiguousError';
        this.prefix = prefix;
        this.capabilityIds = capabilityIds;
    }
}
/**
 * The resolver subprocess exited non-zero (or failed to spawn at all).
 *
 * `stderrTail` is UNTRUSTED subprocess-sourced text (the resolver binary is
 * declared by a capability manifest and invoked with an argv token derived
 * from a PLAN.md `tracker-id` attribute, which is often LLM/agent-authored —
 * a hostile or buggy resolver could echo attacker-influenced text back on
 * its own stderr). `.message` embeds it through `io.cjs`'s
 * `formatDiagnosticToken()` so every caller of `resolveTaskContent` gets a
 * `.message` that is already safe to write verbatim to a plain-text
 * diagnostic — see that function's docstring for why this must happen here,
 * at the point the untrusted substring is embedded, rather than at each
 * call site.
 */
class ResolverFailedError extends Error {
    exitCode;
    stderrTail;
    constructor(binary, exitCode, stderrTail) {
        super(`resolver command '${binary}' exited ${exitCode === null ? 'with no exit code (spawn failure)' : exitCode}` +
            (stderrTail ? `: ${formatDiagnosticToken(stderrTail)}` : ''));
        this.name = 'ResolverFailedError';
        this.exitCode = exitCode;
        this.stderrTail = stderrTail;
    }
}
/**
 * The tracker-id's id segment cannot safely be one argv element: a leading `-`
 * reads as an option to the resolver binary, and control characters are never
 * legitimate. Thrown before any spawn.
 */
class ResolverUnsafeIdError extends Error {
    constructor() {
        super('tracker-id rejected: id must not start with "-" or contain control characters');
        this.name = 'ResolverUnsafeIdError';
    }
}
/** The resolver subprocess exceeded its declared `invoke.timeoutMs` bound. */
class ResolverTimeoutError extends Error {
    timeoutMs;
    constructor(binary, timeoutMs) {
        super(`resolver command '${binary}' timed out after ${timeoutMs}ms`);
        this.name = 'ResolverTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}
/**
 * The resolver's stdout was not valid JSON, or was valid JSON that is not a
 * plain object (a `null`, array, string, number, or boolean top-level value
 * is rejected — only a plain object can carry the `description`/`verify`/
 * `acceptance_criteria`/`read_first`/`done` fields this seam reads).
 */
class ResolverMalformedOutputError extends Error {
    stdoutSample;
    constructor(binary, reason, stdoutSample) {
        super(`resolver command '${binary}' produced malformed output: ${reason}` +
            (stdoutSample ? ` (stdout sample: ${formatDiagnosticToken(stdoutSample)})` : ''));
        this.name = 'ResolverMalformedOutputError';
        this.stdoutSample = stdoutSample;
    }
}
// ─── Pure functions ────────────────────────────────────────────────────────────
/**
 * The SAME kebab-case grammar `capability-validator.cjs`'s `KEBAB_RE`
 * enforces on `taskContentResolver.trackerPrefix` at install time
 * (`validateTaskContentResolverFields`). Duplicated as a literal rather than
 * imported — `.cts` (build-at-publish, ADR-457) and the hand-written
 * `capability-validator.cjs` are genuinely two different build targets with
 * no shared-constants module between them today — but `tests/task-content-
 * resolver-grammar-parity.test.cjs` asserts both regexes agree on a shared
 * table of inputs, so a future edit to either one that silently diverges from
 * the other fails a test instead of drifting quietly (CLAUDE.md's Generative
 * Fix Divergence rule).
 */
const TRACKER_PREFIX_RE = /^[a-z][a-z0-9-]*$/;
/**
 * Split a `tracker-id` attribute value into its prefix and id, on the FIRST
 * `:` only — colons after the first stay in the id verbatim (a tracker whose
 * native ids contain colons, e.g. `beads:issue:GSD-1` → `{prefix: "beads",
 * id: "issue:GSD-1"}`).
 *
 * PURE. Returns `null` for `null`/empty input, and for a string with no `:`
 * at all (nothing to split — there is no prefix to match a resolver against).
 */
function splitTrackerId(trackerId) {
    if (typeof trackerId !== 'string' || trackerId.length === 0)
        return null;
    const colonIdx = trackerId.indexOf(':');
    if (colonIdx === -1)
        return null;
    const prefix = trackerId.slice(0, colonIdx);
    const id = trackerId.slice(colonIdx + 1);
    if (!prefix || !id)
        return null;
    return { prefix, id };
}
/**
 * Defensively re-validate a raw `taskContentResolver` declaration's shape.
 * `capability-validator.cjs` already enforces this at install time, but this
 * module treats every capability manifest as third-party-authored input and
 * never trusts a shape it has not itself checked — a malformed declaration is
 * treated as though it does not exist for matching purposes, never thrown on.
 */
function parseResolverDeclaration(capabilityId, raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const body = raw;
    const trackerPrefix = typeof body.trackerPrefix === 'string' ? body.trackerPrefix.trim() : '';
    if (!trackerPrefix || !TRACKER_PREFIX_RE.test(trackerPrefix))
        return null;
    const inv = body.invoke;
    if (inv === null || typeof inv !== 'object' || Array.isArray(inv))
        return null;
    const invBody = inv;
    const binary = typeof invBody.binary === 'string' ? invBody.binary.trim() : '';
    if (!binary)
        return null;
    const args = Array.isArray(invBody.args)
        ? invBody.args.filter((a) => typeof a === 'string')
        : null;
    if (args === null || args.length !== invBody.args.length)
        return null;
    if (!args.includes('{{id}}'))
        return null;
    const timeoutMs = invBody.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
        return null;
    return {
        capabilityId,
        trackerPrefix,
        invoke: { binary, args, timeoutMs },
    };
}
/**
 * Find the resolver declared for `prefix` among `capabilities`.
 *
 * PURE, total. Returns:
 *   - the single matching declaration when exactly one well-formed resolver
 *     declares `trackerPrefix === prefix`;
 *   - `null` when zero capabilities declare a well-formed resolver for it
 *     (an unrecognized prefix is a data case, not a defect — see design row 11);
 *   - the literal string `'ambiguous'` when two or more do — this must be
 *     structurally impossible in a correctly-validated install, but this
 *     function refuses to silently pick one regardless.
 */
function findResolver(prefix, capabilities) {
    const matches = [];
    for (const cap of capabilities ?? []) {
        if (!cap || typeof cap !== 'object')
            continue;
        const decl = parseResolverDeclaration(cap.id, cap.taskContentResolver);
        if (decl && decl.trackerPrefix === prefix)
            matches.push(decl);
    }
    if (matches.length === 0)
        return null;
    if (matches.length > 1)
        return 'ambiguous';
    return matches[0];
}
/**
 * Expand a resolver's `invoke.args` template, replacing every `"{{id}}"`
 * entry with the literal `id` string. Exact-match token replacement, not
 * template-string interpolation — mirrors `review-lane-invocation.cts`'s
 * argv-expansion discipline (a placeholder is a whole array element, not a
 * substring).
 *
 * PURE.
 */
function buildInvocation(resolver, id) {
    return {
        binary: resolver.invoke.binary,
        args: resolver.invoke.args.map((a) => (a === '{{id}}' ? id : a)),
        timeoutMs: resolver.invoke.timeoutMs,
    };
}
/**
 * Real subprocess execution — the default `execFn`. Uses Node's `spawnSync`
 * with the `timeout` option so a hung resolver is killed at the bound rather
 * than hanging the caller (CLAUDE.md's Unbounded Subprocesses gauntlet line).
 */
function realExec(binary, args, opts) {
    const result = node_child_process_1.default.spawnSync(binary, args, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: opts.timeout,
        windowsHide: true,
    });
    return {
        status: result.status ?? null,
        stdout: (result.stdout ?? '').toString(),
        stderr: (result.stderr ?? '').toString(),
        error: result.error ?? undefined,
    };
}
/**
 * True when an `ExecResult` indicates the subprocess was killed by the
 * `timeout` option, i.e. it never completed and reported a real answer. Only
 * `error.code === 'ETIMEDOUT'` is checked — Node.js guarantees this
 * cross-platform when `spawnSync`'s `timeout` option fires; pairing it with a
 * `signal === 'SIGTERM'` check is platform-fragile (Windows does not
 * necessarily report SIGTERM the same way) and risks a false negative. Same
 * predicate discipline as `shell-command-projection.cts`'s `isSpawnTimeout`.
 */
function isExecTimeout(result) {
    const err = result.error;
    return err?.code === 'ETIMEDOUT';
}
// ─── Resolver JSON → content mapping ──────────────────────────────────────────
function coerceStringOrNull(value) {
    return typeof value === 'string' ? value : null;
}
function coerceStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
/**
 * Map a resolver's validated JSON object onto `ResolvedTaskContent`. Every
 * field is coerced defensively — the resolver's JSON is a third-party CLI's
 * output, validated for exit code and JSON-object-shape upstream, but never
 * trusted field-by-field. A missing or wrong-typed field degrades sanely
 * (string/null fields fall back to `null`, array fields fall back to `[]`);
 * only the caller's `description`-emptiness check throws no further errors
 * here — this function is never the one that decides `resolved` vs `empty`.
 */
function mapResolverOutput(body) {
    return {
        action: coerceStringOrNull(body['description']),
        verify: coerceStringOrNull(body['verify']),
        acceptanceCriteria: coerceStringArray(body['acceptance_criteria']),
        readFirst: coerceStringArray(body['read_first']),
        done: coerceStringOrNull(body['done']),
    };
}
/**
 * Orchestrate one task's content resolution: split the `tracker-id`, find the
 * matching capability's resolver, invoke it through the bounded subprocess
 * boundary, and map its JSON output onto the four documented outcomes.
 *
 * The only impure boundary is `execFn` (defaults to a real `spawnSync` call).
 * Injecting a fake `execFn` lets tests assert every outcome — including a
 * timeout — deterministically, without spawning a real process or waiting a
 * real `timeoutMs`.
 */
function resolveTaskContent(input) {
    const split = splitTrackerId(input.trackerId);
    if (split === null)
        return { kind: TASK_CONTENT_RESULT.NOT_APPLICABLE };
    if (split.id.trimStart().startsWith('-') || /[\u0000-\u001f\u007f]/.test(input.trackerId ?? '')) {
        throw new ResolverUnsafeIdError();
    }
    const resolver = findResolver(split.prefix, input.capabilities ?? []);
    if (resolver === null)
        return { kind: TASK_CONTENT_RESULT.NO_RESOLVER };
    if (resolver === 'ambiguous') {
        // findResolver never returns the capability ids for the ambiguous case
        // (it discards the losing matches) — re-derive them here for the error.
        const ids = (input.capabilities ?? [])
            .filter((cap) => {
            const decl = parseResolverDeclaration(cap?.id, cap?.taskContentResolver);
            return decl !== null && decl.trackerPrefix === split.prefix;
        })
            .map((cap) => cap.id);
        throw new ResolverAmbiguousError(split.prefix, ids);
    }
    const invocation = buildInvocation(resolver, split.id);
    const timeoutMs = Math.floor(Math.min(input.timeoutOverrideMs ?? invocation.timeoutMs, invocation.timeoutMs));
    const execFn = input.execFn ?? realExec;
    const result = execFn(invocation.binary, invocation.args, { timeout: timeoutMs });
    if (isExecTimeout(result)) {
        throw new ResolverTimeoutError(invocation.binary, timeoutMs);
    }
    if (result.error || result.status !== 0) {
        const stderrTail = (result.stderr ?? '').trim().slice(-2000);
        throw new ResolverFailedError(invocation.binary, result.status, stderrTail);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        throw new ResolverMalformedOutputError(invocation.binary, 'stdout is not valid JSON', result.stdout.slice(0, 200));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ResolverMalformedOutputError(invocation.binary, `stdout parsed as valid JSON but is not a plain object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`, result.stdout.slice(0, 200));
    }
    const content = mapResolverOutput(parsed);
    const description = typeof content.action === 'string' ? content.action.trim() : '';
    if (description.length === 0) {
        return { kind: TASK_CONTENT_RESULT.EMPTY };
    }
    return { kind: TASK_CONTENT_RESULT.RESOLVED, content };
}
/**
 * Production capability loader for tracker-id resolution: the merged
 * first-party + validated-installed-overlay registry (ADR-1244 D2), the
 * established runtime read path for "installed capabilities including
 * third-party" — as opposed to `capability-loader.cts`'s heavier build-time
 * validation entry points or the static `capability-registry.cjs` alone
 * (first-party only, would miss a third-party capability's
 * `taskContentResolver` declaration entirely).
 */
function loadResolverCapabilities(cwd) {
    const registry = capabilityLoaderMod.loadRegistry({ includeInstalled: true, cwd });
    return Object.values(registry.capabilities ?? {});
}
/** True for every error `resolveTaskContent` throws as a hard halt (the one classifier all consumers share). */
function isResolverFailure(err) {
    return (err instanceof ResolverAmbiguousError ||
        err instanceof ResolverFailedError ||
        err instanceof ResolverTimeoutError ||
        err instanceof ResolverMalformedOutputError ||
        err instanceof ResolverUnsafeIdError);
}
/** Every text field of resolved content, so a consumer scanning for text cannot miss one when the shape grows. */
function contentTexts(c) {
    return [c.action, c.verify, ...c.acceptanceCriteria, ...c.readFirst, c.done].filter((v) => v !== null);
}
const taskContentResolution = {
    TASK_CONTENT_RESULT,
    splitTrackerId,
    findResolver,
    buildInvocation,
    resolveTaskContent,
    loadResolverCapabilities,
    isResolverFailure,
    contentTexts,
    ResolverUnsafeIdError,
    ResolverAmbiguousError,
    ResolverFailedError,
    ResolverTimeoutError,
    ResolverMalformedOutputError,
};
module.exports = taskContentResolution;

"use strict";
/**
 * Host runtime detection — ADR-2313 Phase 5 (#3245, folded from #2320).
 *
 * `init`'s reported `agent_runtime` was hardcoding `claude` even when run
 * inside a Codex session, because resolveRuntime's ladder only checks the
 * explicit `GSD_RUNTIME` env var and `.planning/config.json`'s `runtime`
 * field — there was no fallback that looked at the actual host process.
 *
 * This module adds a host-detection rung strictly BELOW those two explicit
 * sources: it only runs when neither `GSD_RUNTIME` nor config `runtime` is
 * set. It never writes anything (#2297 — no shared-defaults poisoning: this
 * module never touches .planning/config.json or any other file). It never
 * shells out, so there is no subprocess to time-bound — detection is pure
 * env-var and existence-check inspection.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_CONFIG_HOME_ENV = exports.CODEX_SESSION_ENV_SIGNALS = exports.CODEX_CONFIG_MARKER = void 0;
exports.detectHostRuntime = detectHostRuntime;
exports.resolveReportedRuntime = resolveReportedRuntime;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const runtime_slash_cjs_1 = require("./runtime-slash.cjs");
const runtime_name_policy_cjs_1 = require("./runtime-name-policy.cjs");
const update_context_cjs_1 = require("./update-context.cjs");
Object.defineProperty(exports, "CODEX_CONFIG_MARKER", { enumerable: true, get: function () { return update_context_cjs_1.CODEX_CONFIG_MARKER; } });
// Codex sandbox env vars set by the shell tool / Seatbelt child-process spawn.
// Evidence: openai/codex AGENTS.md — "The sandbox environment automatically
// sets CODEX_SANDBOX_NETWORK_DISABLED=1 when using the shell tool, and
// CODEX_SANDBOX=seatbelt for child processes spawned via Seatbelt." (injected
// by spawn_child_async in codex-rs/core/src/spawn.rs). These are absent under
// sandbox_mode = "danger-full-access", so this signal is best-effort and
// degrades to the default when unset.
//
// Note: CODEX_THREAD_ID (which appears in src/active-workstream-store.cts's
// WORKSTREAM_SESSION_ENV_KEYS) is deliberately NOT used here — it is
// undocumented in Codex's published env-var reference and source, so it
// fails this repo's citation bar.
exports.CODEX_SESSION_ENV_SIGNALS = Object.freeze([
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
]);
// Evidence: learn.chatgpt.com/docs/config-file/environment-variables —
// "Sets the root for Codex state, including config…". The marker FILENAME
// (`config.toml`) is single-sourced from `update-context.cts`'s
// `inferPreferredRuntime` (imported above and re-exported for existing
// importers) — that is the only thing shared between the two functions. The
// TRUTHINESS RULE deliberately differs: `inferPreferredRuntime` treats a
// bare, unchecked `CODEX_HOME` as sufficient to resolve an update context,
// while THIS module additionally requires the marker file to exist, because
// it is asserting session identity rather than resolving an update context
// and needs the stronger signal. That difference is intentional and pinned
// by a test in `tests/host-runtime-detection.test.cjs` rather than left
// implicit.
//
// The DEFAULT `~/.codex/config.toml` is deliberately NEVER probed here:
// every machine that has ever run Codex has that file, so probing it
// unconditionally would misreport Claude Code sessions (or any other
// runtime) as codex just because Codex was installed at some point. An
// explicitly-exported CODEX_HOME is the user designating a Codex root for
// the CURRENT session, which is a much stronger signal.
exports.CODEX_CONFIG_HOME_ENV = 'CODEX_HOME';
// The degraded no-detection result. Also the fallback returned when ANY step
// of detection throws (see the module's stated no-throw premise below).
const NO_DETECTION = { runtime: null, source: 'none', signal: null };
/**
 * Detect the host runtime from process environment signals, without ever
 * consulting the explicit GSD_RUNTIME/config.json sources (those are a
 * higher-priority rung handled by resolveExplicitRuntime).
 *
 * Never throws: the whole body — including the raw `env[key]` reads, which a
 * caller could supply as a throwing Proxy — is wrapped in a single guarded
 * region that degrades to `NO_DETECTION` on any unexpected error, rather than
 * only guarding the `fileExists` probe.
 */
function detectHostRuntime(deps) {
    try {
        const env = deps?.env ?? process.env;
        const fileExists = deps?.fileExists ?? ((p) => node_fs_1.default.existsSync(p));
        for (const key of exports.CODEX_SESSION_ENV_SIGNALS) {
            const value = env[key];
            if (typeof value === 'string' && value.trim() !== '') {
                return { runtime: 'codex', source: 'session-env', signal: key };
            }
        }
        const codexHome = env[exports.CODEX_CONFIG_HOME_ENV];
        if (typeof codexHome === 'string' && codexHome.trim() !== '') {
            try {
                if (fileExists(node_path_1.default.join(codexHome, update_context_cjs_1.CODEX_CONFIG_MARKER))) {
                    return { runtime: 'codex', source: 'config-home', signal: exports.CODEX_CONFIG_HOME_ENV };
                }
            }
            catch {
                // Swallow probe failures (EACCES etc.) and fall through to no-detection.
            }
        }
        return NO_DETECTION;
    }
    catch {
        // A malformed `deps.env` (e.g. a throwing Proxy) must degrade like any
        // other unreadable signal, not propagate — this function's contract is
        // that it never throws.
        return NO_DETECTION;
    }
}
/**
 * Resolve the runtime to report from init: explicit sources first, then the
 * host-detection rung, then the 'claude' default. This is intentionally
 * separate from resolveRuntime — only init's agent_runtime reporting call
 * site uses this ladder; every other resolveRuntime caller is unaffected.
 *
 * Never throws: degrades to the 'claude' default on any unexpected error
 * (e.g. a throwing `deps.env`), matching detectHostRuntime's no-throw
 * contract.
 */
function resolveReportedRuntime(projectDir, deps) {
    try {
        return resolveReportedRuntimeUnsafe(projectDir, deps);
    }
    catch {
        return 'claude';
    }
}
function resolveReportedRuntimeUnsafe(projectDir, deps) {
    const explicit = (0, runtime_slash_cjs_1.resolveExplicitRuntime)(projectDir, deps?.env ?? process.env);
    if (explicit)
        return explicit;
    // #4717: the per-install marker names the runtime that owns THIS tree — a
    // stronger signal than host sniffing, which misreports every session on a
    // multi-runtime machine (e.g. a globally exported CODEX_HOME makes a Claude
    // Code session read as codex). Marker-less trees (dev/source, pre-#2297
    // installs) fall through to host detection unchanged.
    const marker = (0, runtime_name_policy_cjs_1.resolveRuntimeNameFromCandidates)((0, runtime_slash_cjs_1.readInstallRuntimeMarker)());
    if (marker)
        return marker;
    const detected = detectHostRuntime(deps);
    if (detected.runtime)
        return detected.runtime;
    return 'claude';
}

/**
 * Imperative hook-bus adapter — descriptor-driven hooks.json binding
 * (ADR-1239 Phase D / #2089).
 *
 * Generalizes the Cursor-specific `writeCursorHooksJson`/`removeCursorHooksJson`
 * into a descriptor-driven hook-bus binding that reads the negotiated `hookBus`
 * axis + the host's documented hook-event list (from
 * `runtime.hostBehaviors.managedHookEvents`), NOT a hardcoded
 * `sessionStart`/`postToolUse` pair.
 *
 * This module is PURE (no I/O): it resolves the event→script mapping and builds
 * the hooks.json entry manifest. The actual file I/O (copying scripts, writing
 * hooks.json) stays in `runtime-hooks-surface.cts`, which calls into the pure
 * functions exported here. This separation makes the binding testable without a
 * filesystem.
 *
 * Cursor hook-event universe (closed vocabulary per ADR-1239,
 * https://cursor.com/docs/hooks):
 *   sessionStart, sessionEnd, preToolUse, postToolUse, subagentStart,
 *   subagentStop, beforeShellExecution, afterShellExecution,
 *   afterMCPExecution, afterFileEdit, preCompact, stop,
 *   beforeTabFileRead, afterTabFileEdit, workspaceOpen
 *
 * GSD registers for the 6 events in the portable floor + subagent lifecycle
 * (AC4a upgrade, #2089):
 *   sessionStart, postToolUse, preToolUse, stop, subagentStart, subagentStop
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.GSD_HOOK_MARKER = exports.CURSOR_EVENT_SCRIPT_MAP = exports.CURSOR_HOOK_EVENTS = void 0;
exports.resolveManagedHookEvents = resolveManagedHookEvents;
exports.resolveHookScripts = resolveHookScripts;
exports.buildHookBusEntries = buildHookBusEntries;
/**
 * The full set of Cursor hook events GSD can register for.
 * Frozen closed vocabulary — adding an event requires updating both this set
 * and the event→script mapping below.
 */
exports.CURSOR_HOOK_EVENTS = Object.freeze([
    'sessionStart',
    'postToolUse',
    'preToolUse',
    'stop',
    'subagentStart',
    'subagentStop',
]);
/**
 * Event → hook-script mapping. Each event maps to a standalone `.js` script
 * under `hooks/` that Cursor invokes via `hooks.json`.
 *
 * Convention: `gsd-cursor-<kebab-event>.js`. The script files are authored in
 * `hooks/` and copied to `<configDir>/hooks/` during install by
 * `runtime-hooks-surface.cts`.
 */
exports.CURSOR_EVENT_SCRIPT_MAP = Object.freeze({
    sessionStart: 'gsd-cursor-session-start.js',
    postToolUse: 'gsd-cursor-post-tool.js',
    preToolUse: 'gsd-cursor-pre-tool.js',
    stop: 'gsd-cursor-stop.js',
    subagentStart: 'gsd-cursor-subagent-start.js',
    subagentStop: 'gsd-cursor-subagent-stop.js',
});
/**
 * The GSD-managed marker written into each hooks.json entry so the
 * reconcile pass can distinguish GSD-owned entries from user-owned ones.
 */
exports.GSD_HOOK_MARKER = 'gsd-managed';
/**
 * Resolve the managed hook events from a runtime descriptor's
 * `hostBehaviors.managedHookEvents` list. Falls back to the full
 * `CURSOR_HOOK_EVENTS` set when the descriptor does not declare the list
 * (backward-compat for descriptors predating #2089).
 *
 * Pure: no I/O, never throws. Unknown event names are silently filtered
 * (fail-closed — an unrecognized event is never registered). Falls back to
 * the full CURSOR_HOOK_EVENTS set when the descriptor is absent or all entries
 * are unrecognized (ensures the portable-event floor is always covered).
 *
 * @param managedHookEvents - the descriptor's `hostBehaviors.managedHookEvents` array
 * @returns a deduplicated, validated array of event names
 */
function resolveManagedHookEvents(managedHookEvents) {
    if (!Array.isArray(managedHookEvents) || managedHookEvents.length === 0) {
        return exports.CURSOR_HOOK_EVENTS;
    }
    const valid = new Set(exports.CURSOR_HOOK_EVENTS);
    const seen = new Set();
    const result = [];
    for (const ev of managedHookEvents) {
        if (typeof ev === 'string' && valid.has(ev) && !seen.has(ev)) {
            seen.add(ev);
            result.push(ev);
        }
    }
    return result.length > 0 ? result : exports.CURSOR_HOOK_EVENTS;
}
/**
 * Build the list of hook script files that need to be copied for the given
 * managed events. Each event maps to a script via `CURSOR_EVENT_SCRIPT_MAP`.
 *
 * Pure: returns a deduplicated array of script filenames.
 *
 * @param events - the managed event names (validated by `resolveManagedHookEvents`)
 * @returns array of script filenames (e.g. `['gsd-cursor-session-start.js', ...]`)
 */
function resolveHookScripts(events) {
    const scripts = [];
    const seen = new Set();
    for (const ev of events) {
        const script = exports.CURSOR_EVENT_SCRIPT_MAP[ev];
        if (script && !seen.has(script)) {
            seen.add(script);
            scripts.push(script);
        }
    }
    return scripts;
}
/**
 * Build the hooks.json managed-entry manifest for the given events.
 * Each entry is `{ type: 'command', command: <cmd>, [GSD_HOOK_MARKER]: true }`.
 *
 * The `command` string is built by the caller (it requires platform-specific
 * node-runner resolution from `runtime-hooks-surface.cts`). This function
 * receives a pre-built `event → command` map and attaches the marker.
 *
 * Pure: no I/O.
 *
 * @param events - the managed event names
 * @param commands - a map of event → command string (built by the caller)
 * @returns a map of event → managed entry, ready for hooks.json reconciliation
 */
function buildHookBusEntries(events, commands) {
    const entries = {};
    for (const ev of events) {
        const cmd = commands[ev];
        if (cmd) {
            entries[ev] = {
                type: 'command',
                command: cmd,
                [exports.GSD_HOOK_MARKER]: true,
            };
        }
    }
    return entries;
}

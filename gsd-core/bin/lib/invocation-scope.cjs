"use strict";
/**
 * Per-invocation state registry (#6332, ADR-6315 item 14).
 *
 * The CLI was written to run once per process, so some modules keep a cache
 * or a "warned already" set at module level and never clear it. That is
 * correct for the binary and wrong for an in-process caller that runs the
 * CLI many times in one process: the second call would see the first call's
 * cache.
 *
 * A module that holds such state registers a reset here. `runInProcess`
 * (src/in-process-cli.cts) runs every registered reset before and after each
 * call, so each call starts from what a fresh process starts from.
 *
 * Must import nothing: any module may register, so this one cannot depend on
 * any of them.
 */
const resets = new Map();
/**
 * Register the reset for one piece of module-level state. `name` is
 * `<module>.<what>` and must be unique; registering a name twice replaces the
 * earlier function, which is what a module reloaded by a test wants.
 */
function registerInvocationReset(name, reset) {
    resets.set(name, reset);
}
/** Remove a registration. Returns whether the name was registered. */
function unregisterInvocationReset(name) {
    return resets.delete(name);
}
/** Run every registered reset. A reset that throws does not stop the others; the first error is rethrown. */
function resetInvocationState() {
    let firstError;
    let failed = false;
    for (const reset of resets.values()) {
        try {
            reset();
        }
        catch (err) {
            if (!failed) {
                firstError = err;
                failed = true;
            }
        }
    }
    if (failed)
        throw firstError;
}
/** The registered names, sorted. For tests and diagnostics. */
function invocationResetNames() {
    return [...resets.keys()].sort();
}
module.exports = {
    registerInvocationReset,
    unregisterInvocationReset,
    resetInvocationState,
    invocationResetNames,
};

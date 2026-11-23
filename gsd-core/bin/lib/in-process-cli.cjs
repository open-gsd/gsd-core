"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
/**
 * In-process CLI invocation (#6332, ADR-6315 item 14).
 *
 * `runInProcess(main, { argv, cwd, env })` runs a CLI `main` the way the
 * binary's entrypoint does and resolves to `{ exitCode, stdout, stderr }`. It
 * is the seam that lets a test call the CLI without spawning it.
 *
 * `main` and the code under it read `process.argv`, `process.cwd()` and
 * `process.env`, write to fd 1 and fd 2, and end through `runMain`'s rules,
 * `ExitError` or `process.exit`. So this module swaps those ambient values in
 * for one call, captures the writes, and puts every one of them back
 * afterwards, whatever `main` did and however it ended:
 *
 *   - `process.argv`, the working directory and the environment;
 *   - `process.exitCode`;
 *   - `fs.writeSync`, `process.stdout.write`, `process.stderr.write`;
 *   - `process.exit`;
 *   - every `Symbol.for('gsd.…')` cell on `globalThis` (json-error mode, the
 *     exit-contract version, the pending outcome). A call starts with none of
 *     them set;
 *   - every module-level cache registered with src/invocation-scope.cts.
 *
 * Only the call's own writes are captured. Other code can run while an
 * asynchronous `main` is suspended at an `await` (under `node:test`, the
 * runner reports to its parent by writing to stdout). A write, or a
 * `process.exit`, made from outside the call's async context goes to the real
 * function. That includes a listener registered inside `main` but emitted by
 * outside code: it runs in the emitter's context. `process.argv`, the working
 * directory and the environment are process-wide for the length of the call
 * and cannot be scoped this way.
 *
 * Code may keep a reference to a stand-in after its call has ended (a module
 * first loaded inside `main` that saved `process.exit`). Called later from
 * inside another in-process call, that stale stand-in acts for that call.
 * Called at any other time it calls the function it replaced, which is the
 * real one unless something else was installed when its call began. It does
 * not see anything installed since: a test that mocks `process.exit` after an
 * in-process call does not intercept a stale reference to it.
 *
 * What it does not cover:
 *   - module-level state that no module has registered;
 *   - work `main` schedules that runs after its promise settles (a timer that
 *     calls `process.exit` later reaches the real one);
 *   - a child process `main` starts with an inherited descriptor: its output
 *     goes straight to the real stream, and it reads the host's real stdin;
 *   - stdin read through the `process.stdin` stream or by path
 *     (`/dev/stdin`), and `process.stdin.isTTY`, which is the host's.
 *     Synchronous reads of fd 0 (`fs.readFileSync(0)`, `fs.readSync(0, …)`)
 *     are served from `options.stdin`, which is empty by default: end of
 *     input at once, as a child spawned with its stdin closed sees. No
 *     gsd-tools command reads stdin any other way;
 *   - a `main` that never returns. A spawned child can be killed; a
 *     synchronous in-process call that loops holds the whole process, and
 *     only whatever bounds the process (the test lane's cap) ends it;
 *   - `process.on('exit')` handlers, which run when this process exits and
 *     not at the end of a call.
 *
 * The swapped values are process-wide, so calls run one at a time. A call
 * made while another is running waits for it. A call made from inside the
 * `main` of a call that is still running can never get its turn, so it is
 * refused. Once that call has finished, code it left behind (a timer, a
 * listener) may call again.
 *
 * When output goes over `maxBufferBytes` the call is refused, but `main` has
 * already run to its end by then: the refusal reports that the result is
 * incomplete, it does not stop the work.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_async_hooks_1 = require("node:async_hooks");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliExitModule = require("./cli-exit.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const invocationScopeModule = require("./invocation-scope.cjs");
const { ExitError, runMainAsync, runMainSync } = cliExitModule;
const { resetInvocationState } = invocationScopeModule;
/** Same default as child_process's maxBuffer would be at 64 MiB; CLI payloads over 50 KB go to a file. */
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Why runInProcess refused a call. The thrown error carries one as `code`. */
const IN_PROCESS_REASON = Object.freeze({
    REENTRANT: 'in_process_reentrant',
    INVALID_ARGV: 'in_process_invalid_argv',
    INVALID_MAX_BUFFER: 'in_process_invalid_max_buffer',
    INVALID_OPTION: 'in_process_invalid_option',
    OUTPUT_OVERFLOW: 'in_process_output_overflow',
    BUSY: 'in_process_busy',
    ASYNC_COMMAND: 'in_process_async_command',
    ASYNC_STARTED: 'in_process_async_started',
    RESET_FAILED: 'in_process_reset_failed',
    RESTORE_FAILED: 'in_process_restore_failed',
});
class InProcessCliError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'InProcessCliError';
        this.code = code;
    }
}
/**
 * Thrown by the `process.exit` stand-in. It is an ExitError with no message,
 * so runMainAsync settles it as an exit code and writes nothing.
 */
class InProcessExit extends ExitError {
    constructor(code) {
        super(code);
        this.name = 'InProcessExit';
    }
}
const CELL_PREFIX = 'gsd.';
function gsdCellKeys() {
    return Object.getOwnPropertySymbols(globalThis).filter((key) => {
        const name = Symbol.keyFor(key);
        return name !== undefined && name.startsWith(CELL_PREFIX);
    });
}
/** Remove every gsd.* cell and return what was there. */
function takeCells() {
    const globals = globalThis;
    const taken = new Map();
    for (const key of gsdCellKeys()) {
        taken.set(key, globals[key]);
        delete globals[key];
    }
    return taken;
}
function restoreCells(taken) {
    const globals = globalThis;
    for (const key of gsdCellKeys())
        delete globals[key];
    for (const [key, value] of taken)
        globals[key] = value;
}
/**
 * Make process.env hold exactly `next`. Mutated in place: callers hold the
 * object. The entries are read before anything is deleted, because `next` may
 * be process.env itself.
 */
function replaceEnv(next) {
    const entries = Object.entries(next);
    for (const key of Object.keys(process.env))
        delete process.env[key];
    for (const [key, value] of entries) {
        if (value !== undefined)
            process.env[key] = value;
    }
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function asEncoding(value) {
    return typeof value === 'string' && Buffer.isEncoding(value) ? value : 'utf-8';
}
function nodeError(Ctor, code, message) {
    return Object.assign(new Ctor(message), { code });
}
function viewBytes(view) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}
/**
 * The bytes one `fs.writeSync(fd, data, a, b)` call would write, by the rules
 * of the real function. Two forms: `(fd, view, offset?, length?)` (or an
 * options object with `offset` and `length`), where both are byte counts and
 * a value out of range is ERR_OUT_OF_RANGE; and `(fd, string, position?,
 * encoding?)`. Anything else is ERR_INVALID_ARG_TYPE, as it is for the real
 * function.
 */
function writeSyncBytes(data, a, b) {
    if (typeof data === 'string')
        return Buffer.from(data, asEncoding(b));
    if (!ArrayBuffer.isView(data)) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "buffer" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
    }
    const whole = viewBytes(data);
    let offset;
    let length;
    // As the real function does: an object in the third position is the
    // options form, and `null` is an object there, so `(fd, buf, null, n)`
    // takes the defaults and ignores `n`.
    if (typeof a === 'object') {
        ({ offset, length } = (a ?? {}));
    }
    else {
        offset = a;
        length = b;
    }
    const start = offset === undefined || offset === null ? 0 : offset;
    if (typeof start !== 'number') {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "offset" argument must be of type number. Received ${JSON.stringify(start)}`);
    }
    if (!Number.isInteger(start) || start < 0 || start > whole.byteLength) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "offset" is out of range. It must be >= 0 && <= ${whole.byteLength}. Received ${JSON.stringify(start)}`);
    }
    const count = typeof length === 'number' ? length : whole.byteLength - start;
    if (!Number.isInteger(count) || count < 0 || count > whole.byteLength - start) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "length" is out of range. It must be >= 0 && <= ${whole.byteLength - start}. Received ${String(count)}`);
    }
    return whole.subarray(start, start + count);
}
/** The bytes one `stream.write(chunk, encoding?)` call would write, by the stream's own rules. */
function streamWriteBytes(chunk, encoding) {
    if (chunk === null)
        throw nodeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    if (typeof chunk === 'string')
        return Buffer.from(chunk, asEncoding(encoding));
    if (ArrayBuffer.isView(chunk))
        return viewBytes(chunk);
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}
/** The exit status for a settled `process.exitCode`: its low eight bits, as a POSIX status keeps. */
function exitStatus(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) ? n & 0xff : 0;
}
/**
 * Replace `target[key]` for the length of a call. `restore` puts back exactly
 * what was there: the same own property with the same function, or no own
 * property at all when the value was inherited (as a stream's `write` is).
 */
function swapProperty(target, key, replacement) {
    const own = Object.getOwnPropertyDescriptor(target, key);
    const original = Reflect.get(target, key);
    Object.defineProperty(target, key, {
        value: replacement, writable: true, configurable: true, enumerable: own?.enumerable ?? true,
    });
    return {
        original,
        restore: () => {
            if (own)
                Object.defineProperty(target, key, own);
            else
                Reflect.deleteProperty(target, key);
        },
    };
}
/** The handlers of the call that is open right now, by what they stand in for. One call is open at a time. */
let openHandlers;
/**
 * Where a stand-in sends a call it declined.
 *
 * Always DOWN, to the function it replaced, and never up to whatever is
 * installed now. Code inside a call may layer its own wrapper over a stand-in
 * (io.cts's stdout capture does) and that wrapper calls back down into it;
 * anything that sent the call up again would never return.
 *
 * One case comes first. A stand-in whose call has closed is stale: something
 * kept a reference to it (`const { exit } = process` in a module first loaded
 * inside main). If another call is open now, that call's handler is offered
 * the call, so a stale `exit` used inside a later call ends that call and not
 * the host. If it declines, the call goes down as usual.
 */
function forward(slot, self, original, callOpen, thisArg, args) {
    if (!callOpen) {
        const current = openHandlers?.get(slot);
        if (current !== undefined && current !== self) {
            const handled = current(args);
            if (handled !== undefined)
                return handled.value;
        }
    }
    return original.apply(thisArg, args);
}
/**
 * Marks the async context of a call, so a call made from inside `main` is
 * recognised. `active` goes false when the call has finished restoring: the
 * store outlives the call in every timer and listener `main` created, and
 * those may call again once nothing is running.
 */
const insideCall = new node_async_hooks_1.AsyncLocalStorage();
/** The tail of the queue: settles when the call in front has finished restoring. */
let queue = Promise.resolve();
function validateOptions(options) {
    const requestedArgv = options.argv ?? [];
    if (!isStringArray(requestedArgv)) {
        throw new InProcessCliError(IN_PROCESS_REASON.INVALID_ARGV, 'argv must be an array of strings');
    }
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (typeof maxBufferBytes !== 'number' || !Number.isInteger(maxBufferBytes) || maxBufferBytes < 0) {
        throw new InProcessCliError(IN_PROCESS_REASON.INVALID_MAX_BUFFER, 'maxBufferBytes must be a non-negative integer');
    }
    // A wrong type here would be applied to the process before anything could
    // notice: `env: 5` has no entries, so it would empty the environment.
    const env = options.env;
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
        throw new InProcessCliError(IN_PROCESS_REASON.INVALID_OPTION, 'env must be an object of strings');
    }
    for (const name of ['cwd', 'scriptPath', 'stdin']) {
        const value = options[name];
        if (value !== undefined && typeof value !== 'string') {
            throw new InProcessCliError(IN_PROCESS_REASON.INVALID_OPTION, `${name} must be a string`);
        }
    }
    return { argv: requestedArgv, maxBufferBytes };
}
/** True while a call is between installing its swaps and finishing its restore. */
let busy = false;
async function runInProcess(main, options = {}) {
    const validated = validateOptions(options);
    if (insideCall.getStore()?.active === true) {
        throw new InProcessCliError(IN_PROCESS_REASON.REENTRANT, 'runInProcess was called from inside an in-process call that is still running; the swapped '
            + 'process state is process-wide, so the inner call could never start');
    }
    const ahead = queue;
    let release = () => undefined;
    queue = new Promise((resolve) => { release = resolve; });
    await ahead;
    const call = { active: true };
    busy = true;
    try {
        return await insideCall.run(call, async () => {
            const frame = openCall(options, validated, () => call.active && insideCall.getStore() === call);
            if (frame.install()) {
                try {
                    await runMainAsync(main);
                    frame.settle();
                }
                catch (error) {
                    frame.fail(error);
                }
            }
            return frame.close();
        });
    }
    finally {
        call.active = false;
        busy = false;
        release();
    }
}
/**
 * runInProcess for a `main` that finishes synchronously (#6333): returns the
 * result directly. Nothing else can run during a synchronous call, so every
 * write in it belongs to it. It cannot wait, so it is refused
 * (`in_process_busy`) while any other in-process call is running, including
 * from inside one.
 *
 * A main that cannot finish synchronously fails the call, after everything is
 * restored, in one of two ways that callers must tell apart:
 *
 * - `in_process_async_command`: main refused itself BEFORE doing the work. It
 *   set the `gsd.*` cell named by `options.asyncRefusalKey` to the command's
 *   name and ended. Nothing ran, so running the command another way is safe.
 * - `in_process_async_started`: main returned a promise, or set that cell to
 *   `{ started: <name> }`. Work has begun and was not waited for; it may have
 *   written files. Running the command again would do that work twice.
 *
 * Both errors carry the name as `command` when main gave one.
 */
function runInProcessSync(main, options = {}) {
    const validated = validateOptions(options);
    if (busy) {
        throw new InProcessCliError(IN_PROCESS_REASON.BUSY, 'runInProcessSync was called while another in-process call is running; a synchronous call cannot wait for it');
    }
    const call = { active: true };
    busy = true;
    try {
        const frame = openCall(options, validated, () => call.active);
        let asyncCommand;
        if (frame.install()) {
            try {
                const settled = runMainSync(main);
                const refused = options.asyncRefusalKey === undefined
                    ? undefined
                    : globalThis[options.asyncRefusalKey];
                if (!settled)
                    asyncCommand = { command: undefined, started: true };
                else if (typeof refused === 'object' && refused !== null) {
                    asyncCommand = { command: refused.started, started: true };
                }
                else if (refused !== undefined)
                    asyncCommand = { command: refused, started: false };
                else
                    frame.settle();
            }
            catch (error) {
                frame.fail(error);
            }
        }
        const result = frame.close(asyncCommand !== undefined);
        if (asyncCommand !== undefined) {
            const named = typeof asyncCommand.command === 'string' ? ` (command: ${asyncCommand.command})` : '';
            throw Object.assign(asyncCommand.started
                ? new InProcessCliError(IN_PROCESS_REASON.ASYNC_STARTED, 'main started asynchronous work and the synchronous call did not wait for it; the work may already have '
                    + `changed files, so do not run the command again to recover${named}`)
                : new InProcessCliError(IN_PROCESS_REASON.ASYNC_COMMAND, `the command does not finish synchronously and was not run; use the asynchronous form${named}`), { command: asyncCommand.command });
        }
        if (result === undefined)
            throw new Error('runInProcessSync: no result and no failure');
        return result;
    }
    finally {
        call.active = false;
        busy = false;
    }
}
/**
 * One call's saved state, stand-ins and capture. `ownsCurrentContext` says
 * whether the code running right now belongs to this call; a stand-in acts
 * only then and passes everything else through.
 */
function openCall(options, { argv, maxBufferBytes }, ownsCurrentContext) {
    // Each entry undoes one change. They run in reverse, each in its own
    // try/catch, so one failing restore cannot leave the others undone.
    const undo = [];
    const captured = { 1: [], 2: [] };
    const capturedBytes = { 1: 0, 2: 0 };
    let overflowed;
    let firstExit;
    // True until the restore starts. See forward.
    let open = true;
    const handlers = new Map();
    const capture = (fd, bytes) => {
        // A real process is gone once it has asked to exit. Whatever a catch
        // block writes after the stand-in throws was never observable.
        if (firstExit !== undefined || overflowed !== undefined)
            return;
        if (capturedBytes[fd] + bytes.byteLength > maxBufferBytes) {
            overflowed = fd;
            return;
        }
        captured[fd].push(Buffer.from(bytes));
        capturedBytes[fd] += bytes.byteLength;
    };
    // Builds the function installed in place of `slot`. It handles what its
    // call owns and forwards everything else to what it replaced.
    const standInFor = (slot, handle, real) => {
        handlers.set(slot, handle);
        return function standIn(...args) {
            const handled = handle(args);
            return handled !== undefined ? handled.value : forward(slot, handle, real(), open, this, args);
        };
    };
    const streamWrite = (fd, real) => standInFor(`stream.${fd}.write`, (args) => {
        if (!ownsCurrentContext())
            return undefined;
        const [chunk, encodingOrCallback, callback] = args;
        capture(fd, streamWriteBytes(chunk, encodingOrCallback));
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (typeof done === 'function')
            done();
        return { value: true };
    }, real);
    let result;
    let failure;
    function install() {
        try {
            const savedArgv = process.argv;
            const savedCwd = process.cwd();
            const savedEnv = { ...process.env };
            const savedExitCode = process.exitCode;
            const savedCells = takeCells();
            undo.push(() => { restoreCells(savedCells); });
            undo.push(() => { process.exitCode = savedExitCode; });
            undo.push(() => { replaceEnv(savedEnv); });
            undo.push(() => { process.chdir(savedCwd); });
            undo.push(() => { process.argv = savedArgv; });
            try {
                resetInvocationState();
            }
            catch (error) {
                throw new InProcessCliError(IN_PROCESS_REASON.RESET_FAILED, `a registered per-invocation reset failed before main ran: ${String(error)}`, { cause: error });
            }
            // Registered only once the resets are known to work: after a reset that
            // failed here, running them again in the undo would fail the same way and
            // report a restore failure for a call that changed nothing.
            undo.push(() => { resetInvocationState(); });
            process.argv = [savedArgv[0] ?? process.execPath, options.scriptPath ?? savedArgv[1] ?? '', ...argv];
            if (options.env !== undefined)
                replaceEnv(options.env);
            if (options.cwd !== undefined)
                process.chdir(options.cwd);
            process.exitCode = undefined;
            // The streams are touched and swapped BEFORE fs.writeSync. process.stdout
            // and process.stderr are created lazily, and when one is a file its
            // stream captures fs.writeSync at creation; created under the stand-in,
            // it would keep writing into this call's buffer for the rest of the
            // process.
            openHandlers = handlers;
            undo.push(() => { if (openHandlers === handlers)
                openHandlers = undefined; });
            const stdoutWrite = swapProperty(process.stdout, 'write', streamWrite(1, () => stdoutWrite.original));
            undo.push(stdoutWrite.restore);
            const stderrWrite = swapProperty(process.stderr, 'write', streamWrite(2, () => stderrWrite.original));
            undo.push(stderrWrite.restore);
            const writeSync = swapProperty(node_fs_1.default, 'writeSync', standInFor('fs.writeSync', (args) => {
                const [fd, data, offsetOrOptions, length] = args;
                if ((fd !== 1 && fd !== 2) || !ownsCurrentContext())
                    return undefined;
                const bytes = writeSyncBytes(data, offsetOrOptions, length);
                capture(fd, bytes);
                return { value: bytes.byteLength };
            }, () => writeSync.original));
            undo.push(writeSync.restore);
            // Synchronous reads of fd 0 come from options.stdin. Without this a
            // command that reads its input would block on the host process's stdin.
            const stdinBytes = Buffer.from(options.stdin ?? '', 'utf-8');
            let stdinRead = 0;
            const readFileSync = swapProperty(node_fs_1.default, 'readFileSync', standInFor('fs.readFileSync', (args) => {
                const [target, readOptions] = args;
                if (target !== 0 || !ownsCurrentContext())
                    return undefined;
                const rest = stdinBytes.subarray(stdinRead);
                stdinRead = stdinBytes.byteLength;
                const encoding = typeof readOptions === 'string'
                    ? readOptions
                    : readOptions?.encoding;
                return { value: typeof encoding === 'string' && Buffer.isEncoding(encoding) ? rest.toString(encoding) : Buffer.from(rest) };
            }, () => readFileSync.original));
            undo.push(readFileSync.restore);
            const readSync = swapProperty(node_fs_1.default, 'readSync', standInFor('fs.readSync', (args) => {
                const [fd, target, ...rest] = args;
                if (fd !== 0 || !ArrayBuffer.isView(target) || !ownsCurrentContext())
                    return undefined;
                const into = viewBytes(target);
                const opts = typeof rest[0] === 'object' && rest[0] !== null
                    ? rest[0]
                    : { offset: rest[0], length: rest[1] };
                // Node's own bounds: an offset or length outside the buffer is refused,
                // never clamped. A negative length here would move the cursor back.
                const offset = opts.offset === undefined || opts.offset === null ? 0 : opts.offset;
                if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > into.byteLength) {
                    throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "offset" is out of range. It must be >= 0 && <= ${into.byteLength}. Received ${typeof offset === 'number' ? offset : typeof offset}`);
                }
                const room = into.byteLength - offset;
                const wanted = opts.length === undefined || opts.length === null ? room : opts.length;
                if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 0 || wanted > room) {
                    throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "length" is out of range. It must be >= 0 && <= ${room}. Received ${typeof wanted === 'number' ? wanted : typeof wanted}`);
                }
                const count = Math.min(wanted, stdinBytes.byteLength - stdinRead);
                stdinBytes.copy(into, offset, stdinRead, stdinRead + count);
                stdinRead += count;
                return { value: count };
            }, () => readSync.original));
            undo.push(readSync.restore);
            // As the real one does: an argument, even `undefined`, replaces
            // process.exitCode first. The assignment goes through Node's own setter,
            // so a code Node refuses is refused here with Node's own error.
            const exit = swapProperty(process, 'exit', standInFor('process.exit', (args) => {
                if (!ownsCurrentContext())
                    return undefined;
                if (args.length > 0)
                    process.exitCode = args[0];
                const requested = exitStatus(process.exitCode);
                if (firstExit === undefined)
                    firstExit = requested;
                throw new InProcessExit(requested);
            }, () => exit.original));
            undo.push(exit.restore);
            return true;
        }
        catch (error) {
            failure = { error };
            return false;
        }
    }
    function settle() {
        result = {
            exitCode: firstExit ?? exitStatus(process.exitCode),
            stdout: Buffer.concat(captured[1]).toString('utf-8'),
            stderr: Buffer.concat(captured[2]).toString('utf-8'),
        };
    }
    function fail(error) {
        failure = { error };
    }
    function close(discard = false) {
        open = false;
        const restoreErrors = [];
        for (const step of undo.reverse()) {
            try {
                step();
            }
            catch (error) {
                restoreErrors.push(error);
            }
        }
        // A failed restore outranks everything: the process may no longer be in the
        // state the caller left it in. What it displaced travels as the cause.
        if (restoreErrors.length > 0) {
            const displaced = failure === undefined ? [] : [failure.error];
            throw new InProcessCliError(IN_PROCESS_REASON.RESTORE_FAILED, `${restoreErrors.length} process-state restore step(s) failed; the first: ${String(restoreErrors[0])}`, { cause: new AggregateError([...restoreErrors, ...displaced], 'restore failures, then any earlier failure') });
        }
        if (failure !== undefined)
            throw failure.error;
        if (discard)
            return undefined;
        // An overflow outranks main's own exit code: the captured output is
        // incomplete, so no result can be returned. The code is on the error.
        if (overflowed !== undefined) {
            throw Object.assign(new InProcessCliError(IN_PROCESS_REASON.OUTPUT_OVERFLOW, `${overflowed === 1 ? 'stdout' : 'stderr'} exceeded maxBufferBytes (${maxBufferBytes})`), { exitCode: result?.exitCode });
        }
        if (result === undefined)
            throw new Error('runInProcess: no result and no failure');
        return result;
    }
    return { install, settle, fail, close };
}
module.exports = {
    runInProcess,
    runInProcessSync,
    IN_PROCESS_REASON,
    InProcessCliError,
    DEFAULT_MAX_BUFFER_BYTES,
};

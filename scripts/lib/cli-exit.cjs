'use strict';

/**
 * Error that carries a process exit code. CLI logic throws this instead of
 * calling process.exit() (banned by n/no-process-exit); runMain() translates it
 * into process.exitCode at the entrypoint.
 *
 * @param {number} code  exit code (default 1)
 * @param {string} [message]  optional human message; when set and code != 0 it is
 *   written to stderr by runMain before the process exits.
 */
class ExitError extends Error {
  constructor(code = 1, message) {
    super(message === undefined ? `process exit ${code}` : message);
    this.name = 'ExitError';
    this.code = code;
    // Whether runMain should print this.message to stderr (only when a real
    // message was provided, not the synthetic default).
    this.hasUserMessage = message !== undefined;
  }
}

/**
 * Run a CLI main function and translate its outcome into process.exitCode
 * (never process.exit(), so n/no-process-exit stays satisfied). Supports sync or
 * async main.
 *   - main returns a number  -> process.exitCode = that number
 *   - main throws/rejects ExitError -> process.exitCode = err.code, and if
 *       err.hasUserMessage && err.code !== 0, err.message is written to stderr
 *   - main throws/rejects anything else -> the stack is written to stderr and
 *       process.exitCode = 1
 * Letting the event loop drain (vs process.exit) means buffered stdout/stderr is
 * flushed and process.on('exit') cleanup handlers still fire.
 *
 * @param {() => (number|void|Promise<number|void>)} main
 */
function runMain(main) {
  Promise.resolve()
    .then(() => main())
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof ExitError) {
        if (err.hasUserMessage && err.code !== 0) {
          process.stderr.write(`${err.message}\n`);
        }
        process.exitCode = err.code;
        return;
      }
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}

module.exports = { ExitError, runMain };

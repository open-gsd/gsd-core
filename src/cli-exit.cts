import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioModule = require('./io.cjs');
const { getJsonErrorMode, ERROR_REASON } = ioModule;

/**
 * Error carrying a process exit code. CLI logic throws this instead of calling
 * process.exit() (banned by n/no-process-exit); runMain() translates it into
 * process.exitCode at the entrypoint.
 */
class ExitError extends Error {
  code: number;
  hasUserMessage: boolean;
  constructor(code = 1, message?: string) {
    super(message === undefined ? `process exit ${code}` : message);
    this.name = 'ExitError';
    this.code = code;
    this.hasUserMessage = message !== undefined;
  }
}

/**
 * Run a CLI main and translate its outcome into process.exitCode (never
 * process.exit, so n/no-process-exit stays satisfied; output flushes and
 * process.on('exit') cleanup still fires). main may be sync or async:
 *   number return -> process.exitCode = it
 *   thrown ExitError -> process.exitCode = err.code (+ stderr err.message if hasUserMessage && code!=0)
 *   other throw -> when json-error mode is active, emits structured { ok:false, reason, message }
 *                  to stderr; otherwise writes raw stack trace. exit code = 1 in either case.
 */
function runMain(main: () => number | void | Promise<number | void>): void {
  Promise.resolve()
    .then(() => main())
    .then((code) => { if (typeof code === 'number') process.exitCode = code; })
    .catch((err: unknown) => {
      if (err instanceof ExitError) {
        if (err.hasUserMessage && err.code !== 0) process.stderr.write(`${err.message}\n`);
        process.exitCode = err.code;
        return;
      }
      if (getJsonErrorMode()) {
        const e = err as Error;
        const payload = JSON.stringify({
          ok: false,
          reason: ERROR_REASON.SDK_FAIL_FAST,
          message: (e && e.message) ? e.message : String(err),
        }) + '\n';
        fs.writeSync(2, payload);
      } else {
        const e = err as Error;
        process.stderr.write(`${e && e.stack ? e.stack : String(err)}\n`);
      }
      process.exitCode = 1;
    });
}

export = { ExitError, runMain };

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
 *   other throw -> stderr stack + process.exitCode = 1
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
      const e = err as Error;
      process.stderr.write(`${e && e.stack ? e.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}

export = { ExitError, runMain };

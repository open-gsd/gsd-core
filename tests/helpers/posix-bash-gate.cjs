'use strict';

const { skipUnless } = require('./bash-probe.cjs');

/**
 * A `skip` value for `node:test`: false when a shipped bash fence can run here, else the reason.
 * The fences are POSIX bash (paths, globs, `shopt`), so a Windows bash on PATH is not enough
 * (#5506). Off win32, `skipUnless` keeps the CI contract: a missing bash under CI throws, never
 * skips (#5170).
 */
function posixBashSkip() {
  if (process.platform === 'win32') return 'the fence is POSIX bash, not win32';
  return skipUnless('bash');
}

module.exports = { posixBashSkip };

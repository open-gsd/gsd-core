'use strict';

const { have } = require('./bash-probe.cjs');

/**
 * True when a shipped bash fence can run here: bash on PATH and not win32. The fences are POSIX
 * bash (paths, globs, `shopt`), so a Windows bash on PATH is not enough (#5506).
 */
function hasPosixBash() {
  return have('bash') && process.platform !== 'win32';
}

module.exports = { hasPosixBash };

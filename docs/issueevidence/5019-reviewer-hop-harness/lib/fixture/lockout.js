'use strict';
const { MAX_ATTEMPTS, LOCKOUT_MINUTES } = require('./config');

function isLocked(failures, lastFailureMs, nowMs) {
  return failures >= MAX_ATTEMPTS && nowMs - lastFailureMs < LOCKOUT_MINUTES * 60 * 1000;
}
module.exports = { isLocked };

'use strict';
// Account lockout policy
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
module.exports = { MAX_ATTEMPTS, LOCKOUT_MINUTES };

'use strict';

// Diagnostic envelopes are shared by CLI and in-process warning fixtures.
function diagnosticCodes(stderr) {
  return [...stderr.matchAll(/\[([a-z][a-z0-9_]{0,63})\]/g)].map((match) => match[1]);
}

module.exports = { diagnosticCodes };

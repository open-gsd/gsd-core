'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs: the
// `$'…'` decoders call Buffer.from on the span's text, so a span holding FAULT stands
// in for a bug in a reading. hooks/lib/cli-exit.js passes a block's text through it too
// and survives the throw, so keep the marker out of protected names.
const from = Buffer.from;
Buffer.from = function fromWithFault(value, ...rest) {
  if (typeof value === 'string' && value.includes('FAULT')) throw new TypeError('decoder bug');
  return from.call(this, value, ...rest);
};

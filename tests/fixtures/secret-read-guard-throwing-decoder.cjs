'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs: the
// `$'…'` decoders call Buffer.from on the span's text, so a span holding FAULT stands
// in for a bug in a reading. Nothing else in the hook passes that text.
const from = Buffer.from;
Buffer.from = function fromWithFault(value, ...rest) {
  if (typeof value === 'string' && value.includes('FAULT')) throw new TypeError('decoder bug');
  return from.call(this, value, ...rest);
};

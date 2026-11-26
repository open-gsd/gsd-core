'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs
// (#5784): the `$'…'` decoders call Buffer.from on a span's text when it holds a
// backslash escape (the row's `\x41`), so such a span holding UNREADABLE throws a
// reading error whose `message` throws a plain Error when it is read. The
// readings only record the error (readingBug), so both scans finish; main()
// reads the message for its diagnostic line after them, and the Error is
// raised there, inside the try its outer catch guards: a hook error on a Bash
// command that is not a RangeError.
const from = Buffer.from;
Buffer.from = function fromWithUnreadableMessage(value, ...rest) {
  if (typeof value === 'string' && value.includes('UNREADABLE')) {
    const error = new TypeError('decoder bug');
    Object.defineProperty(error, 'message', { get() { throw new Error('message unreadable'); } });
    throw error;
  }
  return from.call(this, value, ...rest);
};

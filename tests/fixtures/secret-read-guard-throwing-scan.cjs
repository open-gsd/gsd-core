'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs
// (#5514, #5784): the scans take a segment's command word through lastSegment,
// so a command word spelled SCANFAULT throws a TypeError inside each scan of
// the command. It holds no reading trigger, so no reading records the error
// (readingBug): the scans themselves throw, a hook error on a Bash command
// that is not a RangeError.
const classification = require('../../hooks/lib/filename-classification.js');

const lastSegment = classification.lastSegment;
classification.lastSegment = function lastSegmentWithFault(text) {
  if (text === 'SCANFAULT') throw new TypeError('scan bug');
  return lastSegment(text);
};

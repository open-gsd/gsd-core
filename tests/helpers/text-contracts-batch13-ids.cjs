'use strict';

// The ids of the text contracts added after batch 12 (#6797, #6812); tests/text-contracts.test.cjs pins the directory to
// its earlier list plus these, and tests/text-contracts.batch13.test.cjs exercises them.
module.exports = [
  'handoff-grammar-readers-registered',
  'audit-milestone-verification-owner',
];

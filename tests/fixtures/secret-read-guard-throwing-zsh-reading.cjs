'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs: it rewrites the hook's
// source as it loads so that zshBraceIsSeparator, which only #5523's zsh grouping readings call, throws
// on a command holding FAULT. That stands in for a bug in that reading alone; the plain reading never
// calls it. A hook without the function fails the load, so the tests that use this cannot pass vacuously.
const Module = require('node:module');
const ANCHOR = 'function zshBraceIsSeparator(str, i, tokens, hasWord) {';
const compile = Module.prototype._compile;
Module.prototype._compile = function compileWithFault(content, filename) {
  if (filename.endsWith('gsd-secret-read-guard.js')) {
    if (!content.includes(ANCHOR)) throw new Error('throwing-zsh-reading fixture: zshBraceIsSeparator not found');
    content = content.replace(ANCHOR, `${ANCHOR} if (str.includes('FAULT')) throw new TypeError('zsh reading bug');`);
  }
  return compile.call(this, content, filename);
};

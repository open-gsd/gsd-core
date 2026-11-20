'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs: #5523's
// spans reading strips the backslashes the shell removes from a backtick body with this
// regex, and nothing else in the hook uses it, so a body holding FAULT stands in for a bug
// in that reading alone. The plain reading never runs it.
const replace = String.prototype.replace;
String.prototype.replace = function replaceWithFault(pattern, ...rest) {
  if (pattern instanceof RegExp && pattern.source === '\\\\([$`\\\\])' && String(this).includes('FAULT')) {
    throw new TypeError('span reading bug');
  }
  return replace.call(this, pattern, ...rest);
};

'use strict';

// Cline runtime support: the repo-root .clinerules file exists and names the GSD workflows, the coding
// standard (CommonJS), the test framework and the architecture. Was tests/cline-support.test.cjs.

module.exports = {
  id: 'cline-support',
  check(ctx) {
    // A missing .clinerules is one finding (ctx.doc reports it), covering the original existence test.
    ctx.doc('.clinerules')
      .has(/gsd|GSD|workflow/, '.clinerules should mention GSD workflows')
      .has(/CommonJS|require/, '.clinerules should mention CommonJS standard')
      .has(/node:test|node:assert/, '.clinerules should mention test framework')
      .has(/bin\/lib|workflows|agents/, '.clinerules should describe project architecture');
  },
};

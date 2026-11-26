'use strict';

// Any workflow that creates a branch from a remote-tracking ref (origin/$DEFAULT_BRANCH, origin/$<ENV>_BRANCH)
// passes --no-track (#2498). Without it the default branch.autoSetupMerge wires the branch upstream to the
// default branch, so a GUI sync (GitHub Desktop, VS Code) pushes the branch's commits straight onto
// origin/$DEFAULT_BRANCH and bypasses PR review. Scans every workflow .md so a newly added workflow that
// reintroduces the pattern is caught. Was tests/branch-no-track-guard.test.cjs.

// Bounded (no-unbounded-quantifier) well past any real line: 200 spaces between the words, 200 characters of
// variable name before BRANCH. Tests pin 199, 200 and 201 of each; a longer one is outside the stated bound.
const CHECKOUT_NEW_BRANCH = /git[ \t]{1,200}checkout[ \t]{1,200}-b\b/;
const REMOTE_REF = /origin\/\$[A-Z_]{1,200}_?BRANCH|origin\/\$DEFAULT_BRANCH/;

module.exports = {
  id: 'branch-no-track-guard',
  issue: '#2498',
  check(ctx) {
    for (const rel of ctx.list('gsd-core/workflows', '.md', 'the workflows are what the guard scans')) {
      ctx.doc(rel).satisfies((text) => {
        const violations = [];
        text.split('\n').forEach((line, i) => {
          if (CHECKOUT_NEW_BRANCH.test(line) && REMOTE_REF.test(line) && !line.includes('--no-track')) {
            violations.push(`line ${i + 1}: ${line.trim()}`);
          }
        });
        return violations.length === 0 || violations.join('; ');
      }, '`git checkout -b` from a remote-tracking ref (origin/$<BRANCH>) needs --no-track, or the new branch is wired upstream to it and a GUI sync pushes onto it, bypassing PR review');
    }
  },
};

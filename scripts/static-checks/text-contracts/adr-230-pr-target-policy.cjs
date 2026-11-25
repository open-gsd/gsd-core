'use strict';

// ADR-230 PR target-branch policy, the workflow half: pr-target-validator.yml checks out the base ref (so a fork PR
// cannot supply its own copy of the policy module) on the repo-standard pinned checkout, requires
// scripts/pr-target-policy.cjs, calls classifyPrTarget, no longer carries the inline `mainAllowed` array, keeps the
// WARN_ONLY / setFailed / warning behaviour, the sticky-comment post-and-update logic and the maintainer carve-out.
// The decision cases, the equivalence oracle and the MAIN_ALLOWED_PATTERNS export run product code and stay in
// tests/adr-230-pr-target-policy.test.cjs. Every pattern is a linear walk over the one file read once.
// Was the structural half of tests/adr-230-pr-target-policy.test.cjs.

const { LINE_ENDS } = require('./lib/line-ends.cjs');

const WORKFLOW = '.github/workflows/pr-target-validator.yml';
const PINNED_CHECKOUT = 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const BASE_REF = 'github.event.pull_request.base.ref';
const POLICY_REQUIRE = 'scripts/pr-target-policy.cjs';

const isSpace = (char) => char !== undefined && /\s/.test(char);
const skipSpaces = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};

// The end of the line (a dot stops at LF, CR, U+2028 and U+2029) that holds `from`.
function lineEnd(text, from) {
  let at = from;
  while (at < text.length && !LINE_ENDS.has(text[at])) at += 1;
  return at;
}

// /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/: each `\s*` is followed by a non-blank literal, so the
// longest blank run is the only way the pattern can match.
function refPinnedToBase(text) {
  let at = text.indexOf('ref:');
  while (at !== -1) {
    let p = skipSpaces(text, at + 4);
    if (text.startsWith('${{', p)) {
      p = skipSpaces(text, p + 3);
      if (text.startsWith(BASE_REF, p)) {
        p = skipSpaces(text, p + BASE_REF.length);
        if (text.startsWith('}}', p)) return true;
      }
    }
    at = text.indexOf('ref:', at + 1);
  }
  return false;
}

// /require\(.*scripts\/pr-target-policy\.cjs/: the module path follows a `require(` on the same line.
function requiresPolicy(text) {
  let at = text.indexOf('require(');
  while (at !== -1) {
    if (text.slice(at + 8, lineEnd(text, at + 8)).includes(POLICY_REQUIRE)) return true;
    at = text.indexOf('require(', at + 1);
  }
  return false;
}

// /const mainAllowed\s*=/: the old inline array declaration.
function declaresMainAllowed(text) {
  const declaration = 'const mainAllowed';
  let at = text.indexOf(declaration);
  while (at !== -1) {
    if (text[skipSpaces(text, at + declaration.length)] === '=') return true;
    at = text.indexOf(declaration, at + 1);
  }
  return false;
}

// /core\.warning.*warning-only mode/: the warning message sits on the line of the call.
function warnsInWarningOnlyMode(text) {
  const call = 'core.warning';
  let at = text.indexOf(call);
  while (at !== -1) {
    if (text.slice(at + call.length, lineEnd(text, at + call.length)).includes('warning-only mode')) return true;
    at = text.indexOf(call, at + 1);
  }
  return false;
}

// /A.*B.*C/s: the words occur in this order, with any text (and none) between them.
function inOrder(text, words) {
  let from = 0;
  for (const word of words) {
    const at = text.indexOf(word, from);
    if (at === -1) return false;
    from = at + word.length;
  }
  return true;
}

// /OWNER.*MEMBER.*COLLABORATOR|COLLABORATOR.*MEMBER.*OWNER/s
const hasMaintainerAssociations = (text) => inOrder(text, ['OWNER', 'MEMBER', 'COLLABORATOR']) || inOrder(text, ['COLLABORATOR', 'MEMBER', 'OWNER']);

module.exports = {
  id: 'adr-230-pr-target-policy',
  walkers: { refPinnedToBase, requiresPolicy, declaresMainAllowed, warnsInWarningOnlyMode, inOrder, hasMaintainerAssociations },
  check(ctx) {
    ctx.doc(WORKFLOW)
      .satisfies(refPinnedToBase, 'the checkout step must pin ref to github.event.pull_request.base.ref (a fork PR cannot supply its own copy of the policy module)')
      .has(PINNED_CHECKOUT, 'the checkout must use the repo-standard pinned SHA de0fac2e4500dabe0009e67214ff5f5447ce83dd')
      .satisfies(requiresPolicy, 'the github-script must require scripts/pr-target-policy.cjs')
      .has('classifyPrTarget(', 'the github-script must call classifyPrTarget()')
      .satisfies((text) => !declaresMainAllowed(text) || 'found the old inline array declaration', 'the old inline mainAllowed array must not appear in the rewired workflow')
      .has('WARN_ONLY', 'the WARN_ONLY env must still be present')
      .has('core.setFailed', 'core.setFailed must still be called on block')
      .satisfies(warnsInWarningOnlyMode, 'the WARN_ONLY warning message (warning-only mode) must be preserved on the core.warning line')
      .has('pr-target-validator', 'the comment marker must still reference pr-target-validator')
      .has('listComments', 'the listComments call must be preserved')
      .has('updateComment', 'the updateComment call must be preserved')
      .has('createComment', 'the createComment call must be preserved')
      .satisfies(hasMaintainerAssociations, 'the maintainer association carve-out (OWNER, MEMBER, COLLABORATOR) must still be present');
  },
};

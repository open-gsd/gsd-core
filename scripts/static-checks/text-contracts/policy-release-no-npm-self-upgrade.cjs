'use strict';

// release.yml never upgrades npm at runtime with a global install (`npm install -g npm@…`, `npm i -g npm`,
// `npm install --global npm@11`); the release lane relies on the Node 24 bundled npm pinned through
// setup-node (#318). `npm ci`, a plain `npm install` and a global install of another tool stay allowed.
// Was tests/policy-release-no-npm-self-upgrade.test.cjs; its regex self-test is mutation cases in
// tests/text-contracts.test.cjs.

// Spaces and tabs only between the words: the pattern is matched against whole-file text, and the
// original matched one line at a time. The flags-and-paths gap between `-g` and the second `npm` is
// bounded (no-unbounded-quantifier) at 2000 characters, far past any workflow line; a test pins both sides.
const NPM_SELF_UPGRADE_RE = /\bnpm[ \t]+(install|i)[ \t]+(-g|--global)\b[^\r\n]{0,2000}\bnpm(@|\b)/;

module.exports = {
  id: 'policy-release-no-npm-self-upgrade',
  issue: '#318',
  check(ctx) {
    ctx.doc('.github/workflows/release.yml')
      .lacks(NPM_SELF_UPGRADE_RE, 'release.yml must not contain a runtime global npm self-upgrade step; rely on Node 24 bundled npm (pinned via setup-node)');
  },
};

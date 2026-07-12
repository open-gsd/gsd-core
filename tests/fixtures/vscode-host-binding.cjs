'use strict';

/**
 * Thin re-export of the SHIPPED VS Code host binding (#2103).
 *
 * `bindGsdToVscode` moved to `vscode/host-binding.js` (the module the real
 * extension's `activate()` requires) so it ships with the extension instead of
 * living only under tests/. This fixture re-exports it so every existing test
 * that requires `./fixtures/vscode-host-binding.cjs` keeps resolving without
 * edits (tests/vscode-ide-reference.test.cjs and any other consumer).
 */
module.exports = require('../../vscode/host-binding.js');

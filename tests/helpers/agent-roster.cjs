'use strict';

/**
 * Shared helper for the canonical shipped-agent roster.
 *
 * Several tests derive "the set of agents we ship" from the source `agents/`
 * directory via `fs.readdirSync(...).filter(/^gsd-.*\.md$/)`. This consolidates
 * that hand-duplicated logic into one canonical SOURCE-roster derivation.
 *
 * NOTE: This returns the SOURCE roster (basenames without `.md`, sorted). Sites
 * with different semantics — installed-destination dirs, absolute-path returns,
 * or `.toml`-inclusive Codex rosters — must NOT use this helper.
 */

const fs = require('node:fs');
const path = require('node:path');

// Canonical source agents directory: <repo-root>/agents, relative to this
// helper at tests/helpers/. Matches the path the consolidated call sites used.
const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

/**
 * List shipped agent basenames (without the `.md` extension), sorted.
 *
 * @param {string} [agentsDir] Override for the source agents directory.
 *   Defaults to the canonical `<repo-root>/agents`.
 * @returns {string[]} Sorted `gsd-*` basenames with `.md` stripped.
 */
function listAgentFiles(agentsDir = AGENTS_DIR) {
  return fs
    .readdirSync(agentsDir)
    .filter((f) => /^gsd-.*\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

module.exports = {
  // AGENTS_DIR is exported (not yet consumed by a call site) so future tests that
  // need the canonical source agents path can reuse it instead of rediscovering it.
  AGENTS_DIR,
  listAgentFiles,
};

'use strict';

/**
 * Canonical per-agent worktree branch namespace for the hooks tree (#1995, #2924).
 *
 * The upstream CLI's `isolation="worktree"` sub-agent runtime renamed its
 * branches from the legacy `worktree-agent-<id>` to the current `agent-<id>`;
 * both are accepted. When the namespace changes again, edit ONLY this file —
 * every hook derives its matcher from the constants here (previously each hook
 * carried its own literal, so a rename had to be re-applied at every site —
 * see PR #1997 review).
 *
 * NOTE: the CLI-lib tree keeps its own mirror of this pattern in
 * `src/worktree-safety.cts` (`AGENT_NAMESPACE_BRANCH_RE`). The hooks tree and
 * the compiled-lib tree have no shared module reachable at runtime, so the two
 * definitions must be kept in sync by hand.
 */

// The one string every matcher below is built from: an optional legacy
// `worktree-` prefix followed by the `agent-` marker.
const AGENT_NAMESPACE_PREFIX = '(worktree-)?agent-';
// Valid characters for the `<id>` suffix of a per-agent branch name.
const AGENT_ID_PATTERN = '[A-Za-z0-9._/-]+';

// Prefix-only test — "does this branch look like a per-agent worktree branch?"
// Intentionally loose: used to decide whether a guard applies at all, without
// validating the id charset.
const AGENT_NAMESPACE_PREFIX_RE = new RegExp(`^${AGENT_NAMESPACE_PREFIX}`);

// Anchored full-name validation — "is this a well-formed per-agent branch name?"
const AGENT_NAMESPACE_BRANCH_RE = new RegExp(`^${AGENT_NAMESPACE_PREFIX}${AGENT_ID_PATTERN}$`);

module.exports = {
  AGENT_NAMESPACE_PREFIX_RE,
  AGENT_NAMESPACE_BRANCH_RE,
};

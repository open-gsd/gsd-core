---
type: Changed
pr: 747
---
**Codex slash-command conversion no longer corrupts inline-wrapped `/gsd-…` file paths** — the install-time converter now identifies a real `/gsd-<command>` mention by positive boundaries (opening delimiter + no path continuation) instead of an unbounded preceding-character denylist, closing the path-corruption class (#637 → #704) by construction while still converting legitimate backtick-wrapped mentions.

<!-- docs-exempt: internal Codex install-time converter; no command, flag, output, or user-doc surface to update -->

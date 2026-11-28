# Installer permissions

> Explanation. What the installer writes to `settings.json` for Claude Code, and why two
> earlier rules were retired. The installer flags are in
> [Installer flags](../reference/installer-flags.md).

Since v1.3.1, the installer pre-populates `~/.claude/settings.json` (or
`settings.local.json` for local installs) with the core permissions GSD needs:

```json
{
  "permissions": {
    "allow": [
      "Read(.planning/*)",
      "Edit(.planning/*)",
      "Read(STATE.md)",
      "Edit(STATE.md)"
    ]
  }
}
```

These entries eliminate first-run approval prompts for GSD's own tool calls. The
merge is non-destructive — your existing permissions are preserved and GSD entries
are only appended. Uninstalling GSD removes exactly these entries and preserves
any others.

**The unscoped `npx gsd-core` rule is retired (#5054).** Earlier versions also
wrote `Bash(npx gsd-core *)`. GSD is published as `@opengsd/gsd-core`, and the
unscoped `gsd-core` name on npm belongs to a different owner, so that rule let
Claude Code run whatever is published under that name without asking. The next
install or upgrade removes that exact entry; rules you wrote yourself, including
scoped `@opengsd/gsd-core` ones, are kept.
Install and upgrade with `npx @opengsd/gsd-core@latest`.

**Secret-file protection moved from deny rules to a hook (#4221).** Earlier
versions also wrote three `permissions.deny` rules — `Read(.env)`,
`Read(.env.*)` and `Read(.secrets)`. Claude Code 2.1.259 hardened the
Bash-side enforcement of `Read()` deny rules so that *any* such rule makes every
`cd DIR && grep …` / `cd DIR && cat …` compound prompt for approval, even in
`auto` mode — and GSD's subagents emit hundreds of those per session. The same
protection now ships as the always-on `gsd-secret-read-guard.js` PreToolUse hook
(Read, Grep and Bash; see [Security hooks](../reference/security-hooks.md) for what it covers and its
documented gaps). A hook denial is not a permission rule, so it never arms that
check, and it applies in `auto` and `bypassPermissions` modes alike. On install
and uninstall the three retired strings are removed from `permissions.deny`
(and an emptied `deny` array is dropped). Note the removal is byte-exact: a
rule you wrote by hand that is identical to one of the three is indistinguishable
from the installer's and is removed as well — re-add it if you want both layers.

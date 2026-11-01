# Make the secret-read guard fail closed

`gsd-secret-read-guard.js` fails open on its own failure: if the hook throws, or
its stdin does not close within 3 s, it allows the tool call. This page makes
those two failures block instead, for a guard registered in Claude Code's
`settings.json`.

## Before you start

- **This works on a `settings.json` entry only.** A plugin install's entry comes
  from the shipped `hooks/hooks.json`, which carries no `onFailure`, so a plugin
  install cannot be made to fail closed this way.
- **`onFailure: "block"` alone is not enough.** Claude Code applies it when a hook
  cannot start, times out, or exits with an unexpected code. The guard catches its
  own failures and exits 0, so `onFailure` never sees them. The environment
  variable below is what routes them to a block.

## Steps

1. **Opt in.** Set `GSD_SECRET_READ_GUARD_ON_CRASH=deny` in the environment
   Claude Code runs in, so the hook process inherits it. Only that exact value
   opts in; any other value, or none, keeps the fail-open default.
2. **Register the entry with `onFailure: "block"`.** In `settings.json`, find the
   `PreToolUse` entry whose `command` runs `gsd-secret-read-guard.js` and add
   `"onFailure": "block"` beside its `command` and `timeout`. The installer keeps
   a key it did not write when it updates the entry.
3. **Lower the entry's `timeout`.** Under `onFailure: "block"` a timeout denies
   too, and the guard is registered with a 120 s timeout, so each such denial
   waits two minutes. Pick a value other than 5: the installer raises a blocking
   guard's timeout of exactly 5 to 120 on every install and update (#3981).

## Check it works

Pipe a malformed payload to the entry's own `command` with the variable set:

```bash
echo '{not json' | GSD_SECRET_READ_GUARD_ON_CRASH=deny <the entry's command>; echo "exit $?"
```

An opted-in guard exits 2, writes a JSON decision with `"code":"guard-error"` to
stdout, and writes its plain reason to stderr. Without the variable the same
command exits 0 and prints nothing.

## Related

- [User guide: `gsd-secret-read-guard.js`](../USER-GUIDE.md) — what the guard
  blocks and what it does not cover.
- [Declare a hook's crash policy](declare-a-hook-crash-policy.md) — how a hook
  declares `ON_CRASH`, including a policy the host selects.

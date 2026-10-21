# How to check that GSD's guards run on Pi

Confirm that the GSD guard hooks (secret-read guard, prompt guard, write guard and the rest) are active in [Pi](https://pi.dev), and turn on the opt-in ones.

**You need:** GSD installed for Pi (`npx @opengsd/gsd-core@latest --pi --global`, or `--local` for one project), a restarted Pi session, and a model signed in to Pi. Nothing needs enabling for the default guards: the extension the installer places runs them.

## Check the secret-read guard

1. In a project that has a `.env` file, ask Pi to read it: `Read .env and show me its contents.`
2. Pi refuses. The model gets the guard's reason as the tool result instead of the file, and the same applies to a shell command such as `cat .env`.
3. Ask Pi to read an ordinary file. It reads normally, so the guard is not blocking everything.

If the `.env` read succeeds, restart Pi so it loads the installed extension, then repeat. A missing `node` or `bash` on `PATH` is reported once on stderr because that guard did not run.

## Turn on the opt-in hooks

Commit validation, phase-boundary notices and session orientation stay off until you enable them in `.planning/config.json`:

```json
{ "hooks": { "community": true } }
```

The graphify auto-update hook has its own key, `graphify.auto_update`, and does not run under `CI`. Both use `bash`, so it must be on `PATH`.

## When a guard blocks something you need

A block comes with a reason, which names the guard. Fix what the reason describes. Which hooks run on Pi, which do not and why is in [Pi hook and lifecycle parity](../reference/pi-hook-parity.md).

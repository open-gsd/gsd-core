# How to raise the commit timeout for slow pre-commit hooks

GSD's SDK commits (`gsd-tools commit`, `commit-to-subrepo`, `pr-subrepo`) run `git commit`, which runs your
pre-commit hooks. If a hook (a full lint, a type-check, `lint-staged` on a large change) takes longer than the
timeout, GSD kills the commit. `gsd-tools commit` and `commit-to-subrepo` report `commit_timeout` with the
`.git/index.lock` it may have left behind, and `pr-subrepo` reports the timeout as an error message that names
the repo. The default is 30 seconds. This page raises it.

## 1. Confirm it is a timeout, not a hook failure

A timeout reads `git commit timed out after 30s (killed mid-hook; a stale lock may remain at …)`. A hook that
rejects the commit reads `commit_failed` (`gsd-tools commit`) or `error` (`commit-to-subrepo`) with the hook's own
message. Only the first is fixed by this page.
`pr-subrepo` prints a timeout as "git commit timed out after Ns in <repo> (...)" and a hook rejection as
"Failed to commit in <repo>: ...". Only the first message is a timeout.

## 2. Set the timeout

```bash
gsd-tools config-set git.commit_timeout_ms 120000
```

The value is milliseconds, an integer from `1` to `3600000` (one hour). `config-set` refuses anything else.
A hand-edited `.planning/config.json` can hold an invalid value. GSD ignores it and applies the 30 second default,
so a bad edit never removes the bound. These values are invalid:

- zero, a negative number, or a fraction
- a non-number, including a quoted number such as `"60000"`
- a number above one hour

## Notes

- The key applies to all three commit sites, including sub-repo commits.
- Prefer making the hook faster over raising the timeout; the hour limit exists so a repo-controlled config file
  cannot turn the bound off.

See `git.commit_timeout_ms` in [the configuration reference](../CONFIGURATION.md).

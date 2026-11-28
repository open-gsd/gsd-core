# Decision-coverage plan gate

> Reference. Invoking `check decision-coverage-plan` directly. The gate and its settings are in
> [Configuration](../CONFIGURATION.md#decision-coverage-gates-workflowcontext_coverage_gate).

The plan-phase translation gate is runnable standalone (the same form the
workflow's gate dispatch uses):

```bash
gsd_run check decision-coverage-plan <phase-dir> <context-path>
```

The context path may also be supplied with the `--context` flag, following
the same convention as the other flag-taking check verbs (e.g.
`check predicate`):

```bash
gsd_run check decision-coverage-plan <phase-dir> --context <path>
gsd_run check decision-coverage-plan --context <path> [<phase-dir>]
```

The flag wins when both a positional context path and `--context` are given;
the positional form keeps working unchanged. A `--context` with no value is
a caller error — the gate fails closed with the missing-argument error, the
same as calling it with no context path at all, rather than silently
skipping. The phase directory remains a separate positional argument (there
is no `--phase` flag; the workflow caller passes both positionals).
A phase-dir argument that names no directory is a caller error too: the gate
fails closed with `total`/`covered` null and `reason` `"phase directory not
found"` (nothing is there, e.g. the phase number `01` was passed), `"phase
path is not a directory"` (it names a file) or `"phase directory unreadable"`
(it could not be read; the exit status is then UNAVAILABLE, 69). A phase
directory that holds no PLAN file answers `reason` `"phase directory holds no
plans"` the same way: zero plans loaded is not zero coverage.

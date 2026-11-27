# How to make a missing test tool fail instead of skip

**Goal:** Make a host that lacks `curl`, `jq` or another tool a bash-block behavior test needs fail the run, instead of skipping those tests without a trace.

**Prerequisites:** A host that runs the suite with `CI` unset and that you can give an environment variable, such as a test bench. A host with `CI` set already fails on a missing tool.

---

## Why a skip can hide a gap

Tests that run a documented bash block gate on `skipUnless` in `tests/helpers/bash-probe.cjs`. With a tool missing and `CI` unset, the suite skips. A skipped `describe` registers none of its tests, so a host without `curl` and `jq` reported `skipped 0` while every guarded suite's bash-block tests did not run. The gsd-test tester image is such a host.

Since #6677 each skip is announced as a named skipped test, `bash-block behavior tests skipped on this host: <tools> are required`, so it shows in the run summary (`# skipped N`) and in the reporter events.

## Turn the skip into a failure

Set `GSD_REQUIRE_BASH_TOOLS` to any non-empty value in the environment the suite runs in:

```bash
GSD_REQUIRE_BASH_TOOLS=1 node scripts/run-tests.cjs
```

A file whose tool is missing now fails at load, with the same error `CI` gives:

```text
curl is required under GSD_REQUIRE_BASH_TOOLS: a bash-block behavior test must run, not skip
```

An empty value does not count: `GSD_REQUIRE_BASH_TOOLS=` leaves the skip in place. Any other value turns the switch on, including `0` and `false`: unset the variable to turn it off.

## Fix the host instead

The switch makes the gap loud; it does not close it. Install the tools the error names (`curl`, `jq`), or accept the announced skip and leave the switch unset.

## Check which tools a host has

```bash
bash -c 'for t in bash curl jq node; do printf "%s -> " "$t"; command -v "$t" || echo MISSING; done'
```

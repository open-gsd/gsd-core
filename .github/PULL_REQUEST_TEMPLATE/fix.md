## Fix PR

> **Using the wrong template?**
> — Enhancement: use [enhancement.md](?template=enhancement.md)
> — Feature: use [feature.md](?template=feature.md)

---

## Linked Issue

> **Required.** This PR will be auto-closed if no valid issue link is found.

Fixes #

> The linked issue must have the `confirmed-bug` label. If it doesn't, ask a maintainer to confirm the bug before continuing.

---

## What was broken

<!-- One or two sentences. What was the incorrect behavior? -->

## What this fix does

<!-- One or two sentences. How does this fix the broken behavior? -->

## Root cause

<!-- Brief explanation of why the bug existed. Skip for trivial typo/doc fixes. -->

## Testing

### How I verified the fix

<!-- Describe manual steps or point to the automated test that proves this is fixed. -->

### Regression test added?

- [ ] Yes — added a test that would have caught this bug
- [ ] No — explain why: <!-- e.g., environment-specific, non-deterministic -->

### Platforms tested

- [ ] macOS
- [ ] Windows (including backslash path handling)
- [ ] Linux
- [ ] N/A (not platform-specific)

### Runtimes tested

- [ ] Claude Code
- [ ] Antigravity
- [ ] OpenCode
- [ ] Other: ___
- [ ] N/A (not runtime-specific)

---

## Self-test report

<!--
Outside contributors: fill this in AFTER your last push. It records what you ran, bound to your
final commit, so a reviewer starts from your results. It is a head start, NOT proof: CI re-runs
everything on the merge-group commit and is authoritative. Maintainers listed in
.github/MAINTAINERS can leave it as is.

- head_sha: `git rev-parse HEAD`. Push again and it goes stale: update it.
- failing_first: the regression test failed on the base branch and passes on your head. If a
  test is not possible, replace the object with {"not_applicable_reason": "why"}.
- tool: "gsd-test", "npm-test" or "manual".
-->

```json
{
  "schema": 1,
  "head_sha": "<40-hex sha of your final commit>",
  "tool": "npm-test",
  "failing_first": { "test": "tests/your-regression.test.cjs", "fails_on_base": false, "passes_on_head": false },
  "commands": ["node --test tests/your-regression.test.cjs", "npm test"],
  "full_suite": { "command": "npm test", "result": "skipped", "passed": 0, "failed": 0 },
  "environment": { "os": "<your OS and version>", "node": "<node --version>" },
  "output_excerpt": "<the last lines of the passing run, 2000 characters at most>"
}
```

---

## Checklist

- [ ] Issue linked above with `Fixes #NNN` — **PR will be auto-closed if missing**
- [ ] Linked issue has the `confirmed-bug` label
- [ ] Fix is scoped to the reported bug — no unrelated changes included
- [ ] Regression test added (or explained why not)
- [ ] All existing tests pass (`npm test`)
- [ ] `.changeset/` fragment added if this is a user-facing fix (`npm run changeset -- --type Fixed --pr <NNN> --body "..."`) — or `no-changelog` label applied
- [ ] No unnecessary dependencies added

## Breaking changes

<!-- Does this fix change any existing behavior, output format, or API that users might depend on?
     If yes, describe. Write "None" if not applicable. -->

None

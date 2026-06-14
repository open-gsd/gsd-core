# Triage Labels

Maps the five canonical triage roles to the actual label strings in `open-gsd/gsd-core`.

| Canonical role    | Label in this repo       | Notes                                                          |
|-------------------|--------------------------|----------------------------------------------------------------|
| `needs-triage`    | `needs-triage`           | Auto-applied by GitHub Action on every new issue               |
| `needs-info`      | `needs-reproduction`     | Waiting on reporter — cannot reproduce, more info required     |
| `ready-for-agent` | `confirmed`              | Bug verified + fully specified — AFK agent can pick up         |
| `ready-for-human` | `approved-enhancement` / `approved-feature` | Enhancement/feature approved by maintainer — human codes it |
| `wontfix`         | `wontfix`                | Will not be actioned                                           |
| `possible-duplicate` | `possible-duplicate` | Applied by the Duplicate check workflow when a new issue's title closely matches existing open issues. The reporter (or a maintainer) replies justifying why it is not a duplicate within 24h, or the Duplicate auto-close sweep closes it. A reply clears this label and applies needs-maintainer-review for human adjudication. React 👎 to the bot comment to veto auto-close. |
| `needs-version` | `needs-version` | Applied by the Version gate workflow when a bug report is auto-closed for missing a valid GSD Version. Edit the issue to add the version and reopen it. |
| `version-exempt` | `version-exempt` | Maintainer-only opt-out label. Prevents the Version gate from closing an issue where a version genuinely does not apply. |

## Notes on this repo's label model

- `confirmed` is the AFK-agent-ready signal for **bugs**. It means "verified to exist and reproducible."
- For **enhancements** and **features**, maintainer approval is `approved-enhancement` / `approved-feature` respectively. A contributor (human or agent) may not write code until one of these is applied.
- There is no separate "ready-for-human" vs "ready-for-agent" distinction for enhancements — both flow through the same `approved-*` labels. If the work requires human judgment (design decisions, external access), note it in the issue body.
- `needs-triage` is removed when any other state label is applied.
- `needs-reproduction` is used instead of the generic `needs-info` — be specific in triage comments about what reproduction steps or information are missing.

## Duplicate detection lifecycle

The `possible-duplicate` label is managed by three GitHub Actions workflows that together form a self-service deduplication loop:

1. **Detect on open** — When an issue is opened, `duplicate-check.yml` scores its title against all other open issues using Dice-coefficient similarity. If any match clears the threshold, the bot posts a challenge comment listing the similar issues and applies `possible-duplicate`.
2. **Challenge comment + reporter window** — The reporter (or a maintainer) has `DEFAULT_WINDOW_HOURS` (24h) to reply explaining why the issue is not a duplicate. Reacting 👎 to the bot comment also signals the reporter objects to auto-close.
3. **Daily sweep auto-close** — `duplicate-sweep.yml` runs at 07:00 UTC daily. For each open issue with `possible-duplicate`, it checks whether the window has elapsed, whether the reporter replied, and whether a 👎 reaction exists. Issues with exempt labels (`priority: critical`, `pinned`, `confirmed-bug`, `confirmed`, `fix-pending`) are never auto-closed. Issues that pass the close check receive a closing comment and are closed with `state_reason: duplicate`.
4. **Reporter reply clears label** — `remove-duplicate-label.yml` fires on every new non-bot comment. If the issue still carries `possible-duplicate`, it removes that label and applies `needs-maintainer-review` (the value of `HUMAN_REVIEW_LABEL` in `scripts/issue-dedupe.cjs`), routing the issue to a maintainer for manual adjudication.

## Version gate lifecycle

The `needs-version` label is managed by a single GitHub Actions workflow that runs immediately on issue open:

1. **Gate on open** — When an issue is opened, `version-gate.yml` checks whether it is a bug report (has the `bug` label, or its body contains a `### GSD Version` heading from the bug template). Non-bug issues are skipped.
2. **Version check** — The gate extracts the value under the `### GSD Version` heading. A value is considered valid if it contains a semver-ish token (e.g. `1.18.0`, `v1.4.1`, `1.18.0-dev`) or a git commit SHA (7-40 hex chars). Missing, blank, `_No response_`, or junk values like `idk` are treated as absent.
3. **Auto-close** — If the version is absent or invalid, the workflow posts a comment with instructions and closes the issue as `not_planned`, then applies `needs-version`.
4. **Reopen path** — The reporter edits the issue to add a valid version and reopens it. Alternatively, a maintainer can add the `version-exempt` label to any bug where a version does not apply (e.g. docs bugs, spec questions), which prevents the gate from closing it on future edits.

The gate logic lives in `scripts/issue-version-gate.cjs` (pure exports, no GitHub API dependency) and is covered by `tests/issue-version-gate.test.cjs`.

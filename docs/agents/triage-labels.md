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

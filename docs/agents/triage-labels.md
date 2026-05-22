# Triage Labels

Maps the five canonical triage roles to the actual label strings in `open-gsd/get-shit-done-redux`.

| Canonical role    | Label in this repo       | Notes                                                          |
|-------------------|--------------------------|----------------------------------------------------------------|
| `needs-triage`    | `needs-triage`           | Auto-applied by GitHub Action on every new issue               |
| `needs-info`      | `needs-reproduction`     | Waiting on reporter — cannot reproduce, more info required     |
| `ready-for-agent` | `confirmed`              | Bug verified + fully specified — AFK agent can pick up         |
| `ready-for-human` | `approved-enhancement` / `approved-feature` | Enhancement/feature approved by maintainer — human codes it |
| `wontfix`         | `wontfix`                | Will not be actioned                                           |

## Notes on this repo's label model

- `confirmed` is the AFK-agent-ready signal for **bugs**. It means "verified to exist and reproducible."
- For **enhancements** and **features**, maintainer approval is `approved-enhancement` / `approved-feature` respectively. A contributor (human or agent) may not write code until one of these is applied.
- There is no separate "ready-for-human" vs "ready-for-agent" distinction for enhancements — both flow through the same `approved-*` labels. If the work requires human judgment (design decisions, external access), note it in the issue body.
- `needs-triage` is removed when any other state label is applied.
- `needs-reproduction` is used instead of the generic `needs-info` — be specific in triage comments about what reproduction steps or information are missing.

---
type: Fixed
pr: 6526
---
**The gate evaluation-scope resolver reads signed commits whatever `log.showSignature` says** — with the setting on, a signed commit's `gpg:` lines landed before its record in the resolver's `git log` output, so the log parser dropped the commit silently (a gate's scope narrowed or came back empty) and a `git show --name-only` listed the `gpg:` text as file names; every `git log` and `git show` whose output the resolver parses now states `--no-show-signature`. (#6272)

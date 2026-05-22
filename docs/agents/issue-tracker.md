# Issue tracker: GitHub

Issues for this repo live in **GitHub Issues** at `open-gsd/get-shit-done-redux`.

## Auth

Use the configured GitHub CLI session for this checkout. Do not require a
repo-local `.envrc` before running `gh`.

## Conventions

- **Create**: `gh issue create --repo open-gsd/get-shit-done-redux --title "..." --body "..."`
- **Read**: `gh issue view <number> --repo open-gsd/get-shit-done-redux --comments`
- **List**: `gh issue list --repo open-gsd/get-shit-done-redux --state open --json number,title,labels --jq '...'`
- **Comment**: `gh issue comment <number> --repo open-gsd/get-shit-done-redux --body "..."`
- **Label**: `gh issue edit <number> --repo open-gsd/get-shit-done-redux --add-label "..." --remove-label "..."`
- **Close**: `gh issue close <number> --repo open-gsd/get-shit-done-redux --comment "..."`

Always pass `--repo open-gsd/get-shit-done-redux` explicitly — the local clone has multiple remotes and `gh` may resolve to the wrong one.

## When a skill says "publish to the issue tracker"

Create a GitHub issue at `open-gsd/get-shit-done-redux`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo open-gsd/get-shit-done-redux --comments`.

---
type: Changed
pr: 0
---
**`npm run lint:generated-sync` now fails the build when any documented surface has a documentation gap, not only when the generated page is stale** — the coverage matrix's `--strict` check joined the CI chain, and the generated page's header states the stronger gate; the matrix currently reports zero gaps, so the check goes red the moment a command, verb, config key, agent, hook, template or installer flag loses its documentation. (#6776)

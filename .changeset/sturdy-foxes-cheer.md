---
type: Fixed
pr: 6194
---
**`/gsd-next` and smart-entry no longer lose the plot after `milestone complete`** — the terminal `Awaiting next milestone` status was missing from the shared status vocabulary, so smart-entry classified a freshly closed milestone as `unknown` ("Show progress / Unsure of state") instead of `complete`; it is now a `completed` vocabulary entry that smart-entry consumes, so the suggested next action stays `/gsd-new-milestone` and the persisted `state.json` hint agrees, and the statusline shows `completed` rather than the first word `awaiting`. STATE.md's frontmatter `status` (and what `state json` reports) is the normalized token, so after `milestone complete` it now reads `completed` where it carried the verbatim `Awaiting next milestone`; the `## Current Position` `Status:` line keeps the verbatim text. A project with the archived status but unfinished roadmap phases is still not `complete`. (#6176)

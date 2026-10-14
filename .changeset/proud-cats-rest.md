---
type: Changed
pr: 5362
---
The Claude Code plugin now registers each workflow once, as its `gsd-<name>` skill, instead of twice (`claude plugin details` listed 144 skills). Plugin slash commands are now `/gsd-core:gsd-<name>` (were `/gsd-core:<name>`) (#4860)

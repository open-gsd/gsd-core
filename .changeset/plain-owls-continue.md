---
type: Fixed
pr: 5654
---
**`execute-phase` checkpoint handling no longer points at a continuation template that does not exist** — step 6 said to spawn the continuation agent "using continuation-prompt.md template", a file that never shipped, so each lane improvised the prompt. The step now states that its placeholder list is the contract. (#4783)

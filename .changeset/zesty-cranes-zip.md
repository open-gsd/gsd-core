---
type: Fixed
pr: 6363
---
**The eval-review, execute-plan and AI-integration workflows now omit a blank or `inherit` model instead of passing it to the agent spawn** — on runtimes without native tier aliases the spawn failed, and the AI-integration phase never passed its four resolved models at all, so model profile and overrides had no effect there; the #2517 guard also now sees prose and unquoted spawns so no new site escapes it. (#5996)

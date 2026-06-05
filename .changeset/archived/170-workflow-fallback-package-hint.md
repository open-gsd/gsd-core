---
type: Fixed
pr: 170
---
**Workflow fallback install hint migration** — workflow error-path guidance for missing `gsd-sdk` now points to `npx -y @opengsd/get-shit-done-redux@latest --claude --local` instead of the abandoned `get-shit-done-cc` package. Added a regression test to prevent legacy fallback hints from reappearing in workflow markdown.

---
type: Fixed
pr: 994
---
**The installer no longer re-adds a duplicate managed hook when the user registered it in `command`+`args` (wrapped) form** — the presence checks only inspected `h.command`, so an args-form wrapper (a common Windows windowless-launcher mitigation) was invisible and a stock entry was appended on every install/update, running the hook twice. (#976)

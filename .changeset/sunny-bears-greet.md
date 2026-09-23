---
type: Fixed
pr: 4883
---
**Decision bullets with code spans in their titles now parse** — a backticked token like `node:http` or `*-UAT.md` inside a decision's bold lead-in was treated as a malformed separator and the whole decisions block failed to parse, hard-blocking the decision-coverage gate; backticked spans are now opaque to the grammar, while a bare colon outside a code span still fails loud. (#4788)

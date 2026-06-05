---
type: Fixed
pr: 3805
---
**`fast.md` `log_to_state` no longer appends a malformed row when the STATE.md table uses the 5-column quick.md schema (#3805)** — the workflow unconditionally wrote a hardcoded 4-cell row (`| date | fast | task | ✅ |`) into STATE.md; when `quick.md` Step 7 had already created a 5-column "Quick Tasks Completed" table the mismatched row broke the Markdown table. `fast.md` now reads the existing header, counts columns, and verifies the quick.md column names before appending a properly-formed 5-cell row. If the schema is unrecognized the write is skipped with a warning rather than corrupting the table.

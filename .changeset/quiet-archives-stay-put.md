---
type: Fixed
pr: 5616
---
**`roadmap update-plan-progress` now edits only the active milestone, whatever the archive's tag case, attributes or position** — the active region was cut at the last literal `</details>`, so a `<details open>` wrapper around the active milestone, uppercase `<DETAILS>` archives, or archives placed after the active section either declined with `missing_phase_details` or ticked and annotated the archive instead. Archived `<details>` blocks are now hidden for the whole edit and restored byte-for-byte, including a `<details>` block with no or a non-closed `<summary>` inside the active range (only a block wrapping the active milestone heading stays editable), so a collapsed deferred-scope block is no longer ticked by this command; the read-side milestone window keeps it (#3982/#1341). An unclosed code fence now ends at the next heading instead of hiding every later archive. (#5553)

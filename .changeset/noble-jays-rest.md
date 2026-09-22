---
type: Fixed
pr: 4898
---
**phase complete no longer rewrites prose outside the Current Position section** — the Current Plan reset's fallback matched any hard-wrapped line starting with "plan:" anywhere in STATE.md (case-insensitive, first match wins), silently replacing narrative text with "Not started"; the reset is now scoped to the Current Position section, while legacy sectionless layouts keep their recorded whole-body behavior. (#4823)

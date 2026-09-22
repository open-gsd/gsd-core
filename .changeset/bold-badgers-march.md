---
type: Fixed
pr: 4896
---
**verification status and frontmatter get distinguish unparseable YAML from a missing report** — a VERIFICATION.md whose frontmatter has a YAML syntax error was reported as status "missing" (sending the operator to re-run execute-phase, which cannot fix a YAML typo), and frontmatter get answered "Field not found"; both now report a distinct parse error. (#4806)

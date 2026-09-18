---
type: Fixed
pr: 4762
---
`/gsd:quick` no longer corrupts STATE.md's Quick Tasks table when a task description contains a `|`. Step 7c hand-rendered the row as raw markdown, so a description carrying a Jinja filter, a shell pipeline or an Ansible task name produced a permanently ragged row that the table reader then refused, blocking every later append; it now appends through `quick-tasks-append`, which escapes each cell. `quick-tasks-append` gained `--status` so the validate-mode row keeps its real verification status instead of the `—` placeholder. Separately, `quick-tasks-append` no longer lets a ragged row mask an unrecognized schema: when a table is both ragged and on an unregistered schema, its failure names both, so repairing the prose no longer reveals a second, previously invisible blocker underneath. (`quick-tasks-migrate` still reports the parse error alone.)

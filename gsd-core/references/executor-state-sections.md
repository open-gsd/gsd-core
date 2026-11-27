# Executor State Sections

How plan execution loads project state (#6388): the `gsd-executor` agent's `load_project_state`
step and inline execution through `execute-plan.md`'s `init_context` both run this block. It reads
only the STATE.md sections execution uses — Current Position, Decisions and Blockers — never the
whole file, whose Quick Tasks table can be most of it.

Run it after the `gsd_run` resolver (`gsd-run-resolver.md`), in the same shell that set `GSD_WS`
(in `execute-plan.md`, the `init_context` block), so the reads use that workstream. Where `GSD_WS` is unset the flag drops out, and the reads resolve
the project and workstream exactly as `state.load` does. An executor whose load step already ran
this block does not run it again.

```bash
# #6388: load only the STATE.md sections execution uses (Current Position, Decisions, Blockers), never the whole file.
# Each section takes the first heading name that returns text; the names are the ones the state writers accept.
_state_section() {
  for _name in "$@"; do
    _body=$(gsd_run query state.get "$_name" ${GSD_WS:+--ws=${GSD_WS##* }} --raw 2>/dev/null) || _body=""
    if [ -n "$_body" ]; then printf '%s' "$_body"; return 0; fi
  done
}
STATE_POSITION="" STATE_DECISIONS="" STATE_BLOCKERS=""
# state.load --raw prints config flags and state_exists only, never the file; same scope resolution as the reads.
STATE_EXISTS=$(gsd_run query state.load ${GSD_WS:+--ws=${GSD_WS##* }} --raw 2>/dev/null | sed -n 's/^state_exists=//p') || STATE_EXISTS=""
if [ "$STATE_EXISTS" = "false" ]; then
  STATE_STATUS=missing
else
  if [ "$STATE_EXISTS" = "true" ]; then STATE_STATUS=read; else STATE_STATUS=unchecked; fi
  STATE_POSITION=$(_state_section "Current Position")
  STATE_DECISIONS=$(_state_section "Decisions" "Decisions Made")
  STATE_BLOCKERS=$(_state_section "Blockers/Concerns" "Blockers" "Concerns")
fi
printf 'STATE_STATUS=%s\n\n## Current Position\n%s\n\n## Decisions\n%s\n\n## Blockers\n%s\n' \
  "$STATE_STATUS" "${STATE_POSITION:-(empty)}" "${STATE_DECISIONS:-(empty)}" "${STATE_BLOCKERS:-(empty)}"
```

Then:

- `STATE_STATUS=missing`: STATE.md is missing or empty. If `.planning/` exists, offer to reconstruct STATE.md or continue without it; if `.planning/` is missing, stop with an error: the project is not initialized.
- `STATE_STATUS=unchecked`: the existence check failed, so use the sections that came back. If all three are `(empty)`, run `gsd_run query state.load --raw` without `2>/dev/null` and report its error.
- Blockers `(empty)`: none are recorded.
- Decisions `(empty)`: STATE.md may keep its decisions under another heading the state writers accept (such as `### Accumulated Decisions`), which `state.get` cannot name. Read STATE.md and use only its decisions section.
- Read the whole STATE.md only when a task's `<read_first>` or action names it, or names a STATE.md section other than these three.
- A plan's `@`-reference to STATE.md (`@.planning/STATE.md`, `@{state_path}`, a workstream's STATE.md) is covered by these reads: do not read the whole file for it. Read it only under the rule above.

`state.get` checks for a `**Name:**` or `Name:` field line before it looks for a heading of that
name, so a stray `Blockers:` line anywhere in STATE.md is returned instead of a `### Blockers`
section.

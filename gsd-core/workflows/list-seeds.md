<purpose>
List captured seeds for browsing and audit, with an optional status filter. Read-only — never mutates seeds.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="load_seeds">
Load seed context. An optional status filter (e.g. `dormant`, `triggered`, `implemented`) may follow `--list-seeds`.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
SEEDS=$(gsd_run list-seeds "$STATUS_FILTER")
if [[ "$SEEDS" == @file:* ]]; then SEEDS=$(cat "${SEEDS#@file:}"); fi
```

Replace `$STATUS_FILTER` with the filter token from `$ARGUMENTS` if one was given, otherwise omit it.

Extract from the JSON: `count`, `seeds[]` (each has `seed_id`, `status`, `scope`, `trigger_when`, `planted`, `title`), and `summary` (a `{ status: count }` map).
</step>

<step name="empty_case">
If `count` is 0:
```
No seeds found.

Plant one with /gsd:capture --seed "<forward-looking idea>".
```
(If a status filter was given and nothing matched, say so: `No seeds with status "<filter>".`) Exit.
</step>

<step name="render_table">
Render the seeds as a table, sorted by `seed_id` (already sorted by the tool). Truncate `trigger_when` and `title` to keep the table readable.

```
Seeds
─────────────────────────────────────────────────────────────────────
ID        Status     Scope    Trigger                  Title
SEED-001  dormant    large    when websockets land     Real-time collaboration
SEED-006  triggered  medium   MILE-04 planning         Remove legacy auth crates
─────────────────────────────────────────────────────────────────────
<count> seeds  (<summary rendered as "N status" pairs, e.g. "1 dormant, 1 triggered">)
```

Then offer next actions as plain text (no mutation here):
```
- /gsd:capture --seed --enrich <ID>   enrich a seed with trigger, why, and scope
- /gsd:capture --list-seeds <status>  filter by status
```
</step>

</process>

<success_criteria>
- [ ] Seeds listed with ID, status, scope, trigger, and title
- [ ] Status filter applied when provided
- [ ] Empty / no-match case handled with guidance
- [ ] Summary line shows total and per-status counts
- [ ] No seed files were modified (read-only)
</success_criteria>

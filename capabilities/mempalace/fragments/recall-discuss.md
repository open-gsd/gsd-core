<!--
  MemPalace capability — contribution fragment.
  Rendered into the discuss:pre orchestrator prompt when `mempalace.recall_on_discuss` is true.
  Contributes DATA (recall instructions), not control flow. onError: skip — never blocks discussion.
-->
### Memory recall (MemPalace)

**Gate first.** Read `.planning/config.json`. If `mempalace.enabled` is not `true`, or `mempalace.recall_on_discuss` is `false`, **skip this entire section** and continue the discussion unchanged. (This contribution is only injected when the capability is enabled; the `recall_on_discuss` check lets you turn discuss-time recall off without disabling the rest of the capability.)

Otherwise — before gathering new context, surface what you already know. This is read-only and side-effect-free; if MemPalace is unreachable, note "memory unavailable" and continue — recall never blocks discussion.

1. **Resolve the wing.** Use `mempalace.wing` if set; otherwise derive it from `project_code` (fall back to the project directory name).
2. **Wake up (cheap, ~600–900 tokens).**
   - Interactive run → call `mempalace_search` after a wake-up read of the wing.
   - Headless/cron run (no MCP server) → run `mempalace wake-up --wing <wing>` via the CLI.
3. **Targeted recall.** Search the palace for prior work on this phase's topic:
   - Interactive → `mempalace_search(query=<phase topic>, wing=<wing>)` and, when `mempalace.mirror_kg` is on, `mempalace_kg_query` / `mempalace_kg_timeline` for decision facts and their validity windows.
   - Headless → `mempalace search "<phase topic>" --wing <wing>`.
4. **Mode awareness.** Only `augment` is currently wired: always treat the palace as an *additional* recall layer on top of GSD's native memory — never skip `.planning/graphs/` or STATE. `kg_backend`/`replace` are forward-declared and behave as `augment` today.
5. **Surface, don't dump.** Fold the top relevant drawers, decisions, patterns, and *surprises* into the discussion as prior context — cite drawer/fact provenance. Do not paste raw search output.

If any MemPalace call errors or times out, skip the rest of recall and proceed with discussion as normal.

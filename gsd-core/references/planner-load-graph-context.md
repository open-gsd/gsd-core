# Planner — Load Graph Context

> Loaded by `gsd-planner` at the `load_graph_context` step.

Check for a knowledge graph and read its freshness in one call. `status` resolves the
graph through `graphify.graph_path`, so it is also the presence gate — a bare
`ls` of the default location misses an umbrella graph shared across sibling repos:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
gsd_run graphify status
```

If `exists` is `false`, continue without graph context — skip the rest of this step.

If the status response has `stale: true`, note for later: "Graph is {age_hours}h old -- treat semantic relationships as approximate." Include this annotation inline with any graph context injected below.

The same response carries `graph_path` — the resolved graph location. Substitute it for `<graph>` below. `graph_path` comes from `graphify.graph_path` in `.planning/config.json`, a config surface already trusted elsewhere; if it ever carried attacker-controlled content, the literal double-quoted substitution below would need escaping.

Query the graph for phase-relevant dependency context (single query per D-06). Prefer the `graphify` CLI when it is on PATH; fall back to the built-in reader otherwise:

```bash
if command -v graphify >/dev/null 2>&1; then
  graphify query "<phase-goal-keyword>" --graph "<graph>" --budget 2000
  graphify affected "<phase-goal-keyword>" --graph "<graph>" --depth 2
else
  gsd_run graphify query "<phase-goal-keyword>" --budget 2000
fi
```

Why the CLI is preferred: it ranks seeds (IDF weighting, fuzzy matching) and applies context filters before traversal, where the built-in reader seeds by case-insensitive substring over label and description — so a term like "auth" seeds equally on `author` and `authorize` — and then expands a fixed two hops. `affected` answers "which subsystems may be affected by changes in this phase" directly, by reverse traversal; it has no built-in equivalent, so the fallback path runs the query alone.

The two paths return **different shapes**: the CLI emits prose, the built-in emits JSON with per-edge confidence tiers and `budget_met`/`budget_estimate`. `--budget` caps rendered output on the CLI and estimated payload bytes in the built-in — same flag name, different unit. Read whichever you get; do not assume a stable shape and do not paste raw output into PLAN.md.

Use the keyword that best captures the phase goal. Prefer the full domain word over a
prefix of it — on the fallback path a prefix is matched as a substring, so "auth" also
seeds on `author` and `authoring`. Examples:
- Phase "User Authentication" -> query term "authentication"
- Phase "Payment Integration" -> query term "payment"
- Phase "Database Migration" -> query term "migration"

If the query returns related nodes, incorporate as dependency context for planning:
- Which modules/files are semantically related to this phase's domain
- Which subsystems may be affected by changes in this phase
- Cross-document relationships that inform task ordering and wave structure

If nothing comes back, continue without graph context.

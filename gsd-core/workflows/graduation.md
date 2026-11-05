# graduation.md — LEARNINGS.md Cross-Phase Graduation Helper

**Invoked by:** `transition.md` step `graduation_scan`. Never invoked directly by users.

This workflow clusters recurring items across the last N phases' LEARNINGS.md files and surfaces promotion candidates to the developer via HITL. No item is promoted without explicit developer approval.

---

## Configuration

Read from project config (`config.json`):

| Key | Default | Description |
|-----|---------|-------------|
| `features.graduation` | `true` | Master on/off switch. `false` skips silently. |
| `features.graduation_window` | `5` | How many prior phases to scan |
| `features.graduation_threshold` | `3` | Minimum cluster size to surface |

---

## Step 1: Guard Checks

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
GRADUATION_ENABLED=$(gsd_run query config-get features.graduation --raw 2>/dev/null || echo "true")
GRADUATION_WINDOW=$(gsd_run query config-get features.graduation_window --raw 2>/dev/null || echo "5")
GRADUATION_THRESHOLD=$(gsd_run query config-get features.graduation_threshold --raw 2>/dev/null || echo "3")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

**Skip silently (print nothing) if:**
- `features.graduation` is `false`
- Fewer than `graduation_threshold` completed prior phases exist (not enough data)

**Skip silently (print nothing) if total items across all LEARNINGS.md files in the window is fewer than 5.**

---

## Step 2: Collect LEARNINGS.md Files

Find LEARNINGS.md files from the last N completed phases (excluding the phase currently completing):

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1) # Read-loaded file: write the command's original argument string in place of $GSD_ARGS
PLANNING_DIR=$(gsd_run query config-path ${GSD_WS:+--ws=${GSD_WS##* }} --raw) && PLANNING_DIR=${PLANNING_DIR%/config.json}
: "${PLANNING_DIR:?planning directory not resolved for this scope}"
find "$PLANNING_DIR/phases" -name "*-LEARNINGS.md" | sort | tail -n "$GRADUATION_WINDOW"
```

For each file found:
1. Parse the four category sections: `## Decisions`, `## Lessons`, `## Patterns`, `## Surprises`
2. Extract each `### Item Title` + body as a single item record: `{ category, title, body, source_phase, source_file }`
3. **Skip items that already contain `**Graduated:**`** — they have been promoted and must not re-surface

---

## Step 3: Cluster by Lexical Similarity

For each category independently, cluster items using Jaccard similarity on tokenized title+body:

**Tokenization:** lowercase, strip punctuation, split on whitespace, remove stop words (a, an, the, is, was, in, on, at, to, for, of, and, or, but, with, from, that, this, by, as).

**Jaccard similarity:** `|A ∩ B| / |A ∪ B|` where A and B are token sets. Two items are in the same cluster if similarity ≥ 0.25.

**Clustering algorithm:** single-pass greedy — process items in phase order; add to the first cluster whose centroid (union of all cluster tokens) has similarity ≥ 0.25 with the new item; otherwise start a new cluster.

**Cluster size filter:** only surface clusters with distinct source phases ≥ `graduation_threshold` (not just total items — same item repeated in one phase still counts as 1 distinct phase).

---

## Step 4: Check graduation_backlog in STATE.md

Read `.planning/STATE.md` `graduation_backlog` section (if present). Format:

```yaml
graduation_backlog:
  - cluster_id: "{sha256-of-cluster-title}"
    status: "dismissed"   # or "deferred"
    deferred_until: "phase-N"  # only for deferred entries
    cluster_title: "{representative title}"
```

**Skip any cluster whose `cluster_id` matches a `dismissed` entry.**

**Skip any cluster whose `cluster_id` matches a `deferred` entry where `deferred_until` phase has not yet completed.**

---

## Step 5: Surface Promotion Candidates

For each qualifying cluster, determine the suggested target file:

| Category | Suggested Target |
|----------|-----------------|
| `decisions` | `PROJECT.md` — append under `## Validated Decisions` (create section if absent) |
| `patterns` | `PATTERNS.md` — append under the appropriate category section (create file if absent) |
| `lessons` | `PROJECT.md` — append under `## Invariants` (create section if absent) |
| `surprises` | Flag for human review — if genuinely surprising 3+ times, something structural is wrong |

Print the graduation report:

```text
📚 Graduation scan across phases {M}–{N}:

  HIGH RECURRENCE ({K}/{WINDOW} phases)
  ├─ Cluster: "{representative title}"
  ├─ Category: {category}
  ├─ Sources: {list of NN-LEARNINGS filenames}
  └─ Suggested target: {target file} § {section}

  [repeat for each qualifying cluster, ordered HIGH→LOW recurrence]

For each cluster above, choose an action:
  P = Promote now   D = Defer (re-surface next transition)   X = Dismiss (never re-surface)   A = Defer all remaining
```

---

## Step 6: HITL — Process Each Cluster

For each cluster (in order from Step 5), ask the developer:

```text
Cluster: "{title}" [{category}, {K} phases] → {target}
Action [P/D/X/A]:
```

Use `AskUserQuestion` (or equivalent HITL primitive for the current runtime). If `TEXT_MODE` is true, display the cluster question as plain text and accept typed input. Accept single-character input: `P`, `D`, `X`, `A` (case-insensitive).

**On `P` (Promote now):**

1. Read the target file (or create it with a standard header if absent)
2. Append the cluster entry under the suggested section:
   ```markdown
   ### {Cluster representative title}
   {Merged body — combine unique sentences across cluster items}

   **Sources:** Phase {A}, Phase {B}, Phase {C}
   **Promoted:** {ISO_DATE}
   ```
3. For each source LEARNINGS.md item in the cluster, append `**Graduated:** {target-file}:{ISO_DATE}` after its last existing field
4. Commit both the target file and all annotated LEARNINGS.md files in a single atomic commit:
   `docs(learnings): graduate "{cluster title}" to {target-file}`

**On `D` (Defer):**

Write to `.planning/STATE.md` under `graduation_backlog`:
```yaml
- cluster_id: "{sha256}"
  status: "deferred"
  deferred_until: "phase-{NEXT_PHASE_NUMBER}"
  cluster_title: "{title}"
```

**On `X` (Dismiss):**

Write to `.planning/STATE.md` under `graduation_backlog`:
```yaml
- cluster_id: "{sha256}"
  status: "dismissed"
  cluster_title: "{title}"
```

**On `A` (Defer all):**

Defer the current cluster (same as `D`) and skip all remaining clusters for this run, deferring each to the next transition. Print:
```text
[graduation: deferred all remaining clusters to next transition]
```
Then proceed directly to Step 7.

---

## Step 7: Completion Report

After processing all clusters, print:

```text
Graduation complete: {promoted} promoted, {deferred} deferred, {dismissed} dismissed.
```

If no clusters qualified (all filtered by backlog or threshold), print:
```text
[graduation: no qualifying clusters in phases {M}–{N}]
```

---

## First-Run Behaviour

On the first transition after upgrading to a version that includes this workflow, all extant LEARNINGS.md files may produce a large batch of candidates at once. A `[Defer all]` shorthand is available: if the developer enters `A` at any cluster prompt, all remaining clusters for this run are deferred to the next transition.

---

## No-Op Conditions (silent skip)

- `features.graduation = false`
- Fewer than `graduation_threshold` prior phases with LEARNINGS.md
- Total items < 5 across the window
- All qualifying clusters are in `graduation_backlog` as dismissed

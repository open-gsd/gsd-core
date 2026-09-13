# OpenCode V2 quick-batch dispatch

Read only from `opencode-v2-lifecycle.md` for a native-tool active round. It owns allocation, create/start transitions, one exact complete seal, and crash reconciliation.

## `native-tool`: V2 durable dispatch

This branch replaces the dispatch rounds above only when
`EXEC_JSON.exec.transport == "native-tool"`. Do not run the SUMMARY-based
`filter-executed` guard in this branch; journal phase is the dispatch authority.
The stale-base check and effective-concurrency commands above still run before
selecting this branch.

### Reconcile, select, and allocate one capacity round

The first side effect in a resumed turn is the parent-scoped model-tool
`{"action":"recover"}` required by the host workflow. Then execute:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
QB_V2_RECONCILE=$(gsd_run quick-batch v2-reconcile \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --raw) || exit 1
```

At the module boundary each V2 operation returns `{ok,value}`. The command
router rejects `ok:false` and, on success, `emit()` prints the unwrapped
`value`. Thus require command success plus non-empty valid JSON and validate
the emitted value's exact fields; otherwise halt and preserve. Set `ACTIVE` to
the reconcile payload's `active`.
If it is null, reload the batch and select a capacity-limited lowest wave using
the established pure verbs:

```bash
QB_ELIG_JSON=$(gsd_run quick-batch resume --batch "$BATCH_ID" --raw) || exit 1
# From QB_ELIG_JSON, form ELIGIBLE_IDS_JSON from the lowest eligible DAG wave,
# preserving BATCH.json item order. Do not include another DAG wave.
QB_SPAWN_JSON=$(gsd_run quick-batch spawn-plan \
  --eligible "$ELIGIBLE_IDS_JSON" \
  --capacity "$EXEC_CONCURRENCY" --in-flight 0 --raw) || exit 1
# ITEMS_JSON is exactly spawn[] in order, with deliberately null identities:
# [{"item_id":"<quick_id>","identity":null}, ...]
QB_V2_ALLOCATE=$(gsd_run quick-batch v2-allocate \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" \
  --orchestrator-root "$ORCHESTRATOR_WT" --items "$ITEMS_JSON" \
  --validation-required "$VALIDATE_MODE" --raw) || exit 1
```

Require allocate's emitted value to have usable `round`, `journal`, and
`manifest_path`; take `ROUND=value.round`,
`ROUND_REVISION=value.journal.revision`, and `ROUND_MANIFEST=value.manifest_path`
(where `value` denotes the CLI's emitted successful value). Require the manifest path to be canonical
and beneath `$ORCHESTRATOR_WT`. Allocation occurs with null identity. Never open
a second round while reconcile reports an active one. Count only successful new
allocations toward the `$ITEM_COUNT` bound.

Report before dispatch: expected item count, launched count, and every omitted
or delayed item with the exact reason (dependency, file ownership, capacity,
unavailable agent/plugin, create failure, or start failure). Worktree creation is
serial, but each accepted child starts immediately, so up to
`$EXEC_CONCURRENCY` children overlap.

### Resolve actual identity, executor, model, and effort

For each selected item in original order, derive its slug and plan exactly as in
the non-V2 branch:

```bash
SLUG=$(gsd_run query generate-slug "$description" --raw) || exit 1
ITEM_DIR="${quick_dir}/${quick_id}-${SLUG}"
PLAN_PATH="${ITEM_DIR}/${quick_id}-PLAN.md"
[ -r "$PLAN_PATH" ] || { echo "FATAL: missing plan $PLAN_PATH" >&2; exit 1; }
PLAN_CONTENT=$(cat "$PLAN_PATH") || exit 1
PLAN_ENTRY_JSON=$(gsd_run quick-batch cleanup-entry \
  --agent-id "temporary-plan-reader" --worktree-path "$ORCHESTRATOR_WT" \
  --branch "$ORCH_BRANCH" --expected-base "$(git -C "$ORCHESTRATOR_WT" rev-parse HEAD)" \
  --plan-content "$PLAN_CONTENT" --raw) || exit 1
# Parse PLAN_FILES and PLAN_DELETIONS from PLAN_ENTRY_JSON's files_modified and
# declared_deletions. They are JSON arrays passed unchanged to worktree.create.
```

Before assigning the default, preflight both the active plugin and registry:
`recover` must have returned the exact parent session, and the
`gsd_worktree_task` start/seal actions must be available. Resolve the target:

```bash
RESOLVED_EXECUTOR=$(gsd_run query resolve-agent --name gsd-executor --raw 2>/dev/null) || {
  echo "FATAL: gsd-executor is absent from the active project registry." >&2; exit 1; }
[ "$RESOLVED_EXECUTOR" = "gsd-executor" ] || { echo "FATAL: unexpected executor resolution" >&2; exit 1; }
EXECUTOR_TYPE=gsd-executor
```

Resolve the model exactly as execute-phase does; V2 forbids
omission/inheritance:

```bash
MODEL_SELECTOR="$executor_model"
case "$MODEL_SELECTOR" in ""|inherit) echo "FATAL: V2 requires an explicit provider-qualified executor model" >&2; exit 1;; esac
case "$MODEL_SELECTOR" in */?*) ;; *) echo "FATAL: executor model must be provider/model" >&2; exit 1;; esac
PROVIDER="${MODEL_SELECTOR%%/*}"
MODEL_AND_VARIANT="${MODEL_SELECTOR#*/}"
BARE_MODEL="${MODEL_AND_VARIANT%%#*}"
SELECTOR_VARIANT=""
[ "$MODEL_AND_VARIANT" = "$BARE_MODEL" ] || SELECTOR_VARIANT="${MODEL_AND_VARIANT#*#}"
printf '%s' "$PROVIDER" | grep -Eq '^[a-z0-9][a-z0-9._-]*$' || exit 1
[ -n "$BARE_MODEL" ] || exit 1
[ -z "$SELECTOR_VARIANT" ] || printf '%s' "$SELECTOR_VARIANT" | grep -Eq '^[A-Za-z0-9._-]+$' || exit 1
EXECUTOR_REASONING_EFFORT="${EXECUTOR_REASONING_EFFORT:-$(gsd_run query config-get executor.reasoning_effort --raw 2>/dev/null || true)}"
case "$EXECUTOR_REASONING_EFFORT" in medium|high) ;; *) echo "FATAL: executor reasoning effort must be medium or high" >&2; exit 1;; esac
```

Do not hardcode `high`: pass the configured `medium|high` value. Generate one
wave identity after allocation, then generate each item identity serially and
immediately before its intent. Every item in this capacity round uses the same
immutable `WAVE_ID`:

```bash
WAVE_NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))') || exit 1
WAVE_ID="qb-${ROUND}-${WAVE_NONCE}"
STARTED_JOBS_JSON='[]'
# Inside the selected-item loop:
NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))') || exit 1
MANIFEST_AGENT_ID="agent-qb-${quick_id}-${NONCE}"
WT_BRANCH="worktree-${MANIFEST_AGENT_ID}"
WT_PATH="${ORCHESTRATOR_WT}/.claude/worktrees/${MANIFEST_AGENT_ID}"
WT_PATH=$(WT_PATH="$WT_PATH" node -e 'const p=require("path");process.stdout.write(p.resolve(process.env.WT_PATH))') || exit 1
EXPECTED_BASE=$(git -C "$ORCHESTRATOR_WT" rev-parse HEAD) || exit 1
IDENTITY_JSON=$(WAVE_ID="$WAVE_ID" MANIFEST_AGENT_ID="$MANIFEST_AGENT_ID" WT_PATH="$WT_PATH" WT_BRANCH="$WT_BRANCH" EXPECTED_BASE="$EXPECTED_BASE" ROUND_MANIFEST="$ROUND_MANIFEST" node -e 'const e=process.env;process.stdout.write(JSON.stringify({wave_id:e.WAVE_ID,manifest_agent_id:e.MANIFEST_AGENT_ID,directory:e.WT_PATH,branch:e.WT_BRANCH,expected_base:e.EXPECTED_BASE,manifest_path:e.ROUND_MANIFEST}))') || exit 1
```

Require both generated IDs to match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and require the worktree path to be a
prospective canonical descendant of `$ORCHESTRATOR_WT`. The inline environment
above is mandatory; reject missing/`undefined` identity coordinates before
`create_intent`.

The concise executor prompt contains the same substantive contract as the
non-V2 prompt: read `${PLAN_PATH}`, `${STATE_PATH}` read-only, and AGENTS.md;
load `${AGENT_SKILLS_EXECUTOR}`; execute every task; honor the submodule commit
guard; commit tasks atomically; create and commit
`${ITEM_DIR}/${quick_id}-SUMMARY.md` with `status: complete` unless normal
planning-artifact skip rules apply; never invoke GSD coordinator commands;
never write BATCH.json, STATE.md, or ROADMAP.md; never commit shared planning
artifacts owned by the coordinator.

### Journaled create, start, and exact complete-wave seal

Every transition uses all required coordinates and the latest revision:

```bash
CREATE_EVENT=$(node -e 'process.stdout.write(JSON.stringify({identity:JSON.parse(process.env.IDENTITY_JSON)}))') || exit 1
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase create_intent --expected-revision "$ROUND_REVISION" \
  --event "$CREATE_EVENT" --raw) || exit 1
```

Require the emitted transition value to contain `journal.revision` and refresh
`ROUND_REVISION` from it after every transition, including idempotent replay.
Now create into the helper-owned
round manifest using the **actual** random manifest agent id:

```bash
CREATE_JSON=$(gsd_run query worktree.create \
  --manifest "$ROUND_MANIFEST" --agent-id "$MANIFEST_AGENT_ID" \
  --path "$WT_PATH" --branch "$WT_BRANCH" --base "$EXPECTED_BASE" \
  --root "$ORCHESTRATOR_WT" --files "$PLAN_FILES" --deletions "$PLAN_DELETIONS" --raw) || exit 1
```

Require `CREATE_JSON.ok === true`, `reason === "created"`, exact manifest,
actual agent id, canonical cwd, and an exact returned entry whose branch and
expected base match. Then transition `created`, refresh the revision, persist
the exact BATCH recovery triple, reload `BATCH_MANIFEST_JSON`, verify its
snake_case `dispatched_worktree`/`dispatched_branch`/`dispatched_base`, and
transition `start_intent`:

```bash
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" --item "$quick_id" --phase created --expected-revision "$ROUND_REVISION" --event '{}' --raw) || exit 1
gsd_run quick-batch update --batch "$BATCH_ID" --updates '[{"quickId":"'"$quick_id"'","dispatchedWorktree":"'"$WT_PATH"'","dispatchedBranch":"'"$WT_BRANCH"'","dispatchedBase":"'"$EXPECTED_BASE"'"}]' --raw || exit 1
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" --item "$quick_id" --phase start_intent --expected-revision "$ROUND_REVISION" --event '{}' --raw) || exit 1
```

Refresh the revision after each V2 response. Call the model tool, nonblocking:

```json
{"action":"start","wave_id":"{WAVE_ID}","directory":"{WT_PATH}","manifest_path":"{ROUND_MANIFEST}","manifest_agent_id":"{MANIFEST_AGENT_ID}","prompt":"{CONCISE_EXECUTOR_PROMPT}","agent":"{EXECUTOR_TYPE}","provider":"{PROVIDER}","model":"{BARE_MODEL}","reasoning_effort":"{EXECUTOR_REASONING_EFFORT}","title":"GSD batch {BATCH_ID} item {quick_id}","timeout_seconds":3600}
```

Require exact wave, `status:"running"`, `session_id:^ses`, canonical returned
directory, manifest path, manifest agent id, and non-empty manifest entry hash.
Transition `started` with `{"session_id":"<returned>"}`, refresh revision,
then transition `seal_intent` and refresh again. Append the exact returned
`session_id` and canonical returned `directory` to `STARTED_JOBS_JSON`; reject
duplicates or any item/session/directory that does not match the journal.

```bash
STARTED_EVENT=$(SESSION_ID="$SESSION_ID" node -e 'process.stdout.write(JSON.stringify({session_id:process.env.SESSION_ID}))') || exit 1
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase started --expected-revision "$ROUND_REVISION" \
  --event "$STARTED_EVENT" --raw) || exit 1
# Parse and install the returned journal.revision before this next mutation.
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase seal_intent --expected-revision "$ROUND_REVISION" \
  --event '{}' --raw) || exit 1
```

Continue serial create/start processing for every selected round item;
already-started children continue concurrently. Only after every expected
start has been accepted, require `STARTED_JOBS_JSON` to contain exactly the
complete round item set in BATCH order and seal once:

```json
{"action":"seal","wave_id":"{WAVE_ID}","jobs":[{"session_id":"{SESSION_ID_1}","directory":"{CANONICAL_DIRECTORY_1}"},{"session_id":"{SESSION_ID_N}","directory":"{CANONICAL_DIRECTORY_N}"}]}
```

The first/N entries illustrate the actual complete `STARTED_JOBS_JSON` array;
do not submit those placeholders. Require exact wave, sealed success, and exact
equality with the submitted complete job set. Then transition every item to `sealed` in BATCH
order, refreshing the revision after each transition. Never seal one item at a
time and never reseal a subset. After the one complete seal, report
expected/launched/omitted and end the turn. Do not call status now.

```bash
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase sealed --expected-revision "$ROUND_REVISION" \
  --event '{}' --raw) || exit 1
```

### Phase-by-phase crash reconciliation

Before any resumed side effect, call parent-scoped recover and
`v2-reconcile`, then follow the exact item phase:

- `create_intent`: compare the intended canonical path and exact manifest entry.
  If both are absent and recover proves no job for this wave/agent/path, perform
  `worktree.create`. If the exact path and exact manifest entry already exist,
  transition `created`. Any partial, duplicate, foreign, or ambiguous identity
  halts and preserves.
- `created`: restore a missing BATCH dispatched triple from immutable identity,
  reload the batch, and verify its three snake_case fields; a conflicting triple
  halts. Then transition `start_intent`.
- `start_intent`: if recover contains exactly one matching job, validate its
  full identity, transition `started` with that session, and do not redispatch.
  If no matching job and no foreign binding exists, perform one start. Ambiguity
  halts.
- `started`: transition `seal_intent` only after exact session reconciliation.
- `seal_intent`: reconcile every round item and build the exact complete
  session/directory set. If the wave is already sealed, require exact equality
  with that whole set before transitioning items to `sealed`. If it is not
  sealed, seal once only after every expected start exists. A subset, extra,
  duplicate, foreign binding, or second differing seal halts and preserves.
- `sealed` and later: never create, start, or reseal. Suspend or route to notification/
  merge recovery.

Crash immediately after allocation is reconciled by `v2-reconcile`, which owns
reconstruction of its exact state/manifest pair only before worktree side
effects. A lost transition response is handled by reconcile plus exact
idempotent replay; always replace `ROUND_REVISION` with the returned journal
revision. After a successful nonblocking start, never call status in the same
turn. Finish the remaining serial starts/seals, then end the assistant turn and
resume only on the queued completion notification or an explicit user resume.

A lost start response is never permission to start another child. BATCH triple,
SUMMARY, old notification, and old attestation never substitute for current-
parent recover followed by fresh status.
Never invoke `wait`, poll status, run `opencode run`, create a detached session,
use `session_move`, or perform broad/glob cleanup.

# OpenCode V2 quick-batch merge

Read only for the sealed native-tool round. It owns fresh status/coordinate attestation, ordered all-worktree merge, and post-barrier teardown.

## `native-tool`: V2 notification, attestation, merge, teardown

This branch replaces the merge rounds above only for
`EXEC_JSON.exec.transport == "native-tool"`. It never uses SUMMARY existence as
readiness and never calls `worktree.cleanup-wave`.

### Select only the deterministic terminal prefix

On a queued `gsd_worktree_wave_completed` payload, require exact type and wave
id for the active sealed round. The actual plugin notification intentionally does not
carry `manifest_path` or `manifest_agent_id`; obtain and bind those only from
the journal plus fresh recover/status evidence. The notification is only a
wake-up signal, never job-selection or merge authorization. On explicit user
resume there may be no notification; the current parent calls recover and
obtains fresh status rather than trusting notification job content.

Build `WAVE_ORDER_JSON` from all active-round items in original BATCH order and
`READY_JSON` only from freshly recovered/status-observed terminal successful
jobs. Invoke the established pure ordering primitive:

```bash
QB_MERGE_ELIG_JSON=$(gsd_run quick-batch merge-eligible \
  --wave-order "$WAVE_ORDER_JSON" --ready "$READY_JSON" --raw) || exit 1
```

Require `mergeable` to equal the complete active-round item set in original
order before any merge. A proper prefix waits; a failed, missing, duplicate,
foreign, or nonterminal job halts or suspends with the active round and every
resource preserved. No case is converted to filesystem evidence.

### Merge every item while the complete wave remains intact

For each item in the complete `mergeable` array, in BATCH order, execute both
fresh gates and the merge below. Do not teardown any worktree inside this loop.
The attestation helper first validates the entire sealed status job set—seal,
literal `merge_ready:true`, empty reasons, freshness, provenance, manifest and
requested/live executor identities—and only then selects exactly one job whose
session equals this journal item's bound session. Missing or duplicate bound
sessions, or a malformed unrelated sibling, fail before item authorization.

### Fresh gate before prepare

For the selected sealed/attested item, call the model tools in this order and
retain their unmodified JSON:

```json
{"action":"recover"}
```

```json
{"action":"status","wave_id":"{WAVE_ID}"}
```

Require recover's `parent_session_id` to equal `$PARENT_SESSION_ID`. The model
must literally observe the fresh native `status` response with
`merge_ready:true`; the helper independently obtains authoritative bytes over
the trusted plugin RPC. The response must still contain the complete round job
set; only after whole-wave validation may the helper select this item's exact
bound session. Attest with journal coordinates only:

```bash
QB_V2_ATTEST=$(gsd_run quick-batch v2-attest \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" --raw) || exit 1
```

Require command success and an emitted value containing `journal.revision`;
refresh `ROUND_REVISION` and the trusted journal `status_digest`. Never pass
recover/status/BATCH JSON, an endpoint, headers, or any observer-controlled
evidence to `v2-attest`; unknown, omitted, or duplicate fields fail closed.

Prepare is read-only and binds the actual random manifest agent id:

```bash
PREPARE_JSON=$(gsd_run query worktree.merge-one \
  --manifest-path "$ROUND_MANIFEST" \
  --actual-manifest-agent-id "$MANIFEST_AGENT_ID" \
  --canonical-worktree-path "$WT_PATH" --branch "$WT_BRANCH" \
  --target-root "$ORCHESTRATOR_WT" \
  --worktree-root "${ORCHESTRATOR_WT}/.claude/worktrees" \
  --prepare --raw) || exit 1
```

Require an exact identity-bearing result. If status is `prepared`, retain
`child_tip` and `target_tip` as immutable prepared tips. `already_merged` is
reconcilable only when the journal was already at `merge_intent`; if the
current phase is merely `attested`, it is an unexplained mutation and must
halt/preserve. Any blocked/ambiguous result is routed durably and preserves the
worktree.

`unsupported_policy` and `unsupported_git_capability` are non-terminal,
recoverable environment blocks. During read-only prepare they occur before `merge_intent`;
do not attempt CAS. `unsupported_policy` may also appear from
the mutating route if effective signing, hooks, or branch merge options changed
after intent was journaled. In either position, do not persist a terminal BATCH
failure: preserve the active round and require operator remediation or a
supported unsigned Git/hook policy.

For `prepared`, record merge intent with the exact prepared tips and the first
trusted digest, then refresh `ROUND_REVISION` from the successful transition:

```bash
MERGE_EVENT=$(node -e 'const e=process.env;process.stdout.write(JSON.stringify({branch_tip:e.CHILD_TIP,target_tip:e.TARGET_TIP,status_digest:e.STATUS_DIGEST}))') || exit 1
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase merge_intent --expected-revision "$ROUND_REVISION" \
  --event "$MERGE_EVENT" --raw) || exit 1
```

### Fresh gate immediately before mutation

After `merge_intent`, call model-tool recover and fresh status **again
immediately before merge**, with no intervening side effect. Refresh attestation
at the `merge_intent` phase:

```json
{"action":"recover"}
```

```json
{"action":"status","wave_id":"{WAVE_ID}"}
```

```bash
QB_V2_ATTEST=$(gsd_run quick-batch v2-attest \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" --raw) || exit 1
```

Require the exact successful emitted value, refresh revision, and use only the
newly stored `status_digest`. Then invoke the bounded merge with the immutable
prepared child tip:

```bash
MERGE_JSON=$(gsd_run quick-batch v2-merge \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" \
  --manifest-path "$ROUND_MANIFEST" --manifest-agent-id "$MANIFEST_AGENT_ID" \
  --worktree-path "$WT_PATH" --branch "$WT_BRANCH" \
  --expected-child-tip "$CHILD_TIP" --expected-target-tip "$TARGET_TIP" \
  --status-digest "$STATUS_DIGEST" --raw) || exit 1
```

The authorization route validates the current `merge_intent`, fresh native RPC
provenance (at most 30 seconds old), exact manifest/agent/worktree/branch,
prepared child and target tips, and refreshed digest before it calls the
approved merge primitive. The route passes the journal-derived absolute expiry
and a revision/digest/phase/tip revalidator into that primitive; both are checked
immediately before target `update-ref` CAS, after all slow preflight. On `merged`
or `already_merged` it atomically records
the journal `merged` phase and returns the new revision. The legacy
`query worktree.merge-one` mutation route rejects any active native manifest.
Refresh the target tip naturally for the next item's read-only prepare. Continue
the merge loop until every round item is durably `merged`, with all round
worktrees still present.

For `merged_sync_pending`, do **not** write `merged` and do not persist a
terminal BATCH failure. The exact merge commit is already published, but
concurrent target dirt prevented safe index/worktree synchronization. Preserve
all files, halt, and rerun the exact `quick-batch v2-merge` command with the journaled
child/target tips; it regenerates the same unsigned deterministic commit and reuses
the landed merge only when its OID is exactly equal before performing
only the safe two-tree `read-tree -u -m` reconciliation. Any other OID is a
preserved `target_tip_mismatch`. Never use `reset --hard`. This
primitive does not hold a repository-wide checkout mutation lock: arbitrary
same-user Git commands and direct writes may race the final inventory/read-tree
micro-window and are outside the supported threat model.

For `unsupported_policy`, including a policy change discovered here after
`merge_intent`, do **not** write `merged` and do not persist a terminal BATCH
failure. Preserve the journal/worktree/branch and halt for operator remediation.

For any other merge failure, do **not** write the `merged` transition. Persist
the BATCH failure instead, then halt with journal/worktree/branch preserved:

```bash
gsd_run quick-batch v2-outcome --batch "$BATCH_ID" --quick-id "$quick_id" \
  --outcome merge_failed --reason "$MERGE_REASON" --raw || exit 1
```

Do not complete or close the round.

### Crash at `merge_intent`

Resume by running the same `worktree.merge-one --prepare` command read-only.
If it returns `already_merged` while the journal is at `merge_intent`, require
its `child_tip` to equal the journaled immutable branch tip, then rerun the
mutating command with both journaled tips so it verifies the exact deterministic
unsigned merge OID and safely reconciles any post-CAS checkout sync. Transition to
`merged` only from that command's `already_merged` result; this is reconciliation,
not a new authorization. If prepare returns `prepared`, call recover plus fresh status and
`v2-attest` again, then retry `quick-batch v2-merge` using both journaled
immutable tips and the refreshed digest. Missing-but-not-merged, changed tip,
identity mismatch, or ambiguous repository state halts and preserves. A
historical notification, SUMMARY, or old status digest cannot authorize retry.

### Teardown only after every durable merge

Before entering this section, reread the journal and require every active-round
item to be durably `merged`. If even one item is not merged, do not teardown
anything. After that all-merged barrier, process items in BATCH order: transition
each to `teardown_pending`, refresh the returned revision, and invoke the exact
teardown route. A lost transition response is reconciled before teardown; a
lost teardown response reruns only this exact idempotent primitive. No plugin
status is requested after teardown begins, because removal makes complete-wave
status inapplicable. Invoke exactly:

```bash
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase teardown_pending \
  --expected-revision "$ROUND_REVISION" --event '{}' --raw) || exit 1
```

```bash
TEARDOWN_JSON=$(gsd_run quick-batch v2-teardown \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" \
  --manifest-path "$ROUND_MANIFEST" --manifest-agent-id "$MANIFEST_AGENT_ID" \
  --worktree-path "$WT_PATH" --branch "$WT_BRANCH" \
  --merged-child-tip "$CHILD_TIP" --raw) || exit 1
```

For `removed` or `already_removed`, the authorization route records `removed`
under the same journal lock. Refresh its returned revision, then clear only
this item's durable dispatch triple and reload/verify that all three snake_case
fields are null:

```bash
gsd_run quick-batch update --batch "$BATCH_ID" --updates '[{"quickId":"'"$quick_id"'","dispatchedWorktree":null,"dispatchedBranch":null,"dispatchedBase":null}]' --raw || exit 1
```

For `branch_delete_warning`, make at most one immediate retry of the exact same
`quick-batch v2-teardown` command with the same immutable child tip. If it still
does not return `removed` or `already_removed`, halt and resume explicitly;
this is never polling.
If a teardown response is lost, rerun the exact command with its original
expected revision and identical identity/child-tip payload. A journaled
`removed` outcome is returned idempotently; if Git removal landed before its
journal write, `already_removed` is reconciled and durably records `removed`.
A conflicting payload fails closed.
Any other result halts and preserves exact state. Never use glob deletion,
`git worktree remove` directly, cleanup-wave, or plugin status for teardown.
Only after every item has passed this teardown loop continue through Step 8/9.

# OpenCode V2 quick-batch completion

Read only for native-tool items after merge and optional receipt-backed verification. It owns complete, close, and manifest-scoped cleanup.

## `native-tool`: V2 per-item completion and round close

This branch wraps, rather than replaces, the exact final commit/report above.
Run its per-item portion after Step 7 and optional Step 8 for each deterministic
prefix item. Do not run the final artifact commit/report until the outer loop in
`quick-batch.md` has no eligible or active work remaining.

For an item at journal phase `removed` when validation is disabled, or at
`verification_passed` after a successful `v2-verify` receipt when
validation is enabled, call the coordinate-bound wrapper below. It checks the
current journal phase and receipt, then invokes the unchanged exactly-once
`completeQuickItem` primitive. Generic `quick-batch complete` refuses active
native items.

```bash
QB_V2_COMPLETE=$(gsd_run quick-batch v2-complete \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" \
  --description "$description" --date "$date" --commit "$commit_hash" \
  --directory "$ITEM_DIR" --raw) || exit 1
```

Require its emitted manifest to show this exact item `status:"complete"` and
refresh `$ROUND_REVISION` from its emitted `journal.revision`; capture the real
completion commit as `$commit_hash`, never from SUMMARY or plugin history. Then
transition directly to `completed`:

```bash
QB_V2_TRANSITION=$(gsd_run quick-batch v2-transition \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --phase completed \
  --expected-revision "$ROUND_REVISION" --event '{}' --raw) || exit 1
```

The router emits the successful Result's `value`; require a valid emitted
`journal.revision` and replace `$ROUND_REVISION`. `v2-complete` first records an
exact completion intent. If the response is lost before or after the BATCH/STATE
mutation, rerun the exact command with its original expected revision and
identical payload: it reconciles the intent or returns the durable
`completion_written` outcome. A conflicting payload fails closed. Then replay
the `completed` transition with the returned current revision. Never mark
`completed` first. A
no-validation item follows exactly `quick-batch v2-complete → completed`; a
validated item follows `verification_passed → quick-batch v2-complete → completed`.
The `completed` transition rereads the verification artifact and requires its
path, SHA-256, canonical status, and current determinate fingerprint/staleness
evaluation to match the journal receipt as well as the BATCH item being
complete. Covered-file drift revokes authorization even if report bytes are
unchanged. Calling generic `quick-batch complete` first cannot
mint a receipt: subsequent `v2-verify`, `completed`, and `v2-close` all fail
closed.

After every item in the active round is `completed`, close exactly that round:

```bash
QB_V2_CLOSE=$(gsd_run quick-batch v2-close \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --expected-revision "$ROUND_REVISION" --raw) || exit 1
```

Require `closed:true` and an embedded immutable `receipt` matching parent,
batch, round, state path, manifest path, and all completed item identities.
For validation-enabled rounds, close rereads every passed verification receipt
and matching complete BATCH outcome before clearing `active`.
`v2-close` atomically embeds that complete receipt in index history and clears
`active`; it does not retire plugin waves. If close fails because any item is
failed, blocked, or unfinished, halt and preserve the active round. If the
response is lost, reconcile: `active:null` plus exactly one matching embedded
receipt proves close; otherwise do not guess or allocate another round.

Only after close is proven invoke the exact cleanup verb:

```bash
QB_V2_CLEANUP=$(gsd_run quick-batch v2-cleanup \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --raw) || exit 1
```

Require `cleaned:true`. Cleanup removes only the receipt-authorized journal,
manifest, and receipt-cache files. The embedded receipt and completed plugin
history remain durable; old closed plugin waves are matched to receipts and are
never retired or treated as active work. A lost cleanup response is handled by
the same idempotent `v2-cleanup` call, never broad deletion.

Reload the batch with `quick-batch resume`, recompute the lowest eligible DAG
layer and next capacity round, and return to Step 6. This supports batches wider
than capacity and later dependency layers. If no active round and no eligible
items remain, execute the exact unchanged **Final commit** and **Final report**
above once, including reload/counts and the complete report template. A failed
or preserved active round halts before finalization; it is never falsely closed.

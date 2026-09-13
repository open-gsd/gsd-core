# OpenCode V2 quick-batch verification

Read only for native-tool items. Receipt-backed V2 verification is the sole completion authority.

## `native-tool`: V2 verification journal routing

For V2, run the same verifier prompt only for an item whose journal phase is
`removed`. Preserve the global
model omission rule for `verifier_model`: omit the Agent model field when it is
empty or `inherit`; otherwise pass the configured selector. Do not infer the
result from SUMMARY or executor status.

Call the strict coordinate-only verification recorder directly. It resolves no
sibling and performs exactly one pre-receipt read of the exact
`${quick_id}-VERIFICATION.md` into a `Buffer`. It strict-admits, canonically
evaluates current fingerprint coverage/staleness, and SHA-256 hashes the same
captured buffer before binding the receipt and BATCH outcome to the journal.
The general `verification.status` query remains the process-runtime routing API;
its result is not V2 receipt authority. Generic `quick-batch complete` cannot
create this receipt, and arbitrary transition event JSON is never evidence:

```bash
QB_V2_VERIFY=$(gsd_run quick-batch v2-verify \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" --raw) || exit 1
```

- `passed` / action `complete`: require the recorder to return
  `pending_completion:true` and journal phase `verification_passed`, and only
  then route the item to Step 9. A lost response is reconciled by rerunning the
  exact coordinate command with its original expected revision. Replay succeeds
  only when path, bytes, status, current covered inputs, and determinate
  staleness still match; changed report or covered bytes fail closed.
- Current, well-formed, determinate `gaps_found`: persist a compatibility receipt
  with journal phase `verification_failed` and BATCH `failed`. It is
  non-authorizing and cannot complete or close a successful round.
- Current, well-formed, determinate `human_needed`: persist a compatibility
  receipt with journal phase `verification_blocked` and BATCH `blocked`. It is
  non-authorizing and cannot complete or close a successful round.
- Stale, malformed, missing, unknown, or staleness-indeterminate evidence:
  command failure, no receipt, no BATCH outcome mutation, and halt/preserve.

Require the exact successful emitted value and refresh `ROUND_REVISION` from
its `journal.revision`.
Every replay and `v2-complete`, `completed`, and `v2-close` boundary re-evaluates
current coverage/staleness; receipt path/hash/status equality alone is not
authorization. `verification_failed` and
`verification_blocked` leave the round active and halt/preserve; `v2-close`
will reject them. There is no automatic fix, rollback, completion, or cleanup.
When `$VALIDATE_MODE` is false, leave the item at `removed`; Step 9 may complete
it directly.

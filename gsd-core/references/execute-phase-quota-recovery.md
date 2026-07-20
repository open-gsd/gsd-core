**Step 7.1 detail — `class == "quota-exceeded"` recovery.**

Do not offer "retry now". Run the step-5 spot-check first; if SUMMARY.md is missing but
commits exist, route to safe-resume (`state.verify-against-disk`) instead of an immediate
redispatch.

**7.1a — provider escalation (#2296, opt-in).** A heavier tier on the same throttled
provider is still throttled, so when `dynamic_routing.provider_escalation` is configured
GSD swaps PROVIDER rather than waiting for a reset. `QUOTA_ATTEMPT` starts at 1 on the
first quota failure of this phase and increments on each subsequent one.

```bash
ESC_JSON=$(gsd_run query resolve-execution gsd-executor --attempt "${QUOTA_ATTEMPT:-1}" --failure-class quota-exceeded)
ESCALATED=$(echo "$ESC_JSON" | jq -r '.escalation.escalated')
EXHAUSTED=$(echo "$ESC_JSON" | jq -r '.escalation.exhausted')
ESC_FROM=$(echo "$ESC_JSON" | jq -r '.escalation.from')
ESC_TO=$(echo "$ESC_JSON" | jq -r '.escalation.to')
ESC_TRIED=$(echo "$ESC_JSON" | jq -r '.escalation.attempted | join(" -> ")')
```

- **`ESCALATED == "true"`** — log the switch, honor the provider's own backoff
  (`sleep "$RETRY_AFTER"` when `RETRY_AFTER` is set), then re-dispatch the failed plan with
  `executor_model` overridden to `$ESC_TO` and `QUOTA_ATTEMPT` incremented. Do not prompt —
  this is the configured, opt-in path.

  ```text
  ⚡ Provider quota hit — escalating model: {ESC_FROM} → {ESC_TO}
    Runtime sentinel: {SENTINEL}
    {RETRY_HINT}
  ```

- **`EXHAUSTED == "true"`** — the ladder is spent. Fail loudly naming every model tried,
  then fall through to the manual options below. Never silently retry the last one.

  ```text
  ⛔ Provider escalation exhausted — tried: {ESC_TRIED}
  ```

- **`ESCALATED == "false"` and not exhausted** — escalation is not configured for this
  project; use the manual path below. This is the default.

**7.1b — manual recovery (default when escalation is not configured).**

```text
⚠ Plan {plan_id} terminated by provider quota / rate limit
  Runtime sentinel: {SENTINEL}
  {RETRY_HINT}
  Partial commits on worktree branch: {N}
  SUMMARY.md present: {yes|no}
  1. Wait for quota reset, then resume (recommended)
2. Switch to a different runtime / model and resume
3. Abort phase and report partial state
```

Re-run `/gsd:execute-phase` after the quota resets for Option 1.

# Auto-Advance Check (plan-phase step 15)

This file is Read, not textually substituted: wherever a snippet below shows `$ARGUMENTS`, write the parent command's original argument string there (#4772).

Check for auto-advance trigger using values already loaded in step 1:

1. Parse `--auto` and `--chain` flags from $ARGUMENTS
2. Use `auto_chain_active` and `auto_advance` from the INIT JSON parsed in step 1 — **do not issue additional `config-get` calls for these values** (they are already present in the init output). Issuing redundant `config-get` calls for values already in INIT can cause infinite read loops on some runtimes.
3. **Sync chain flag with intent** — if user invoked manually (no `--auto` and no `--chain`), clear the ephemeral chain flag from any previous interrupted `--auto` chain. This does NOT touch `workflow.auto_advance` (the user's persistent settings preference):
   ```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
   if [[ ! "$GSD_ARGS" =~ --auto ]] && [[ ! "$GSD_ARGS" =~ --chain ]]; then
     gsd_run query config-set workflow._auto_chain_active false || true
   fi
   ```

Set local variables from INIT (parsed once in step 1):
- `AUTO_CHAIN` = `auto_chain_active` from INIT JSON (boolean, default false)
- `AUTO_CFG` = `auto_advance` from INIT JSON (boolean, default false)

**If `--auto` or `--chain` flag present AND `AUTO_CHAIN` is not true:** Persist chain flag to config (handles direct invocation without prior discuss-phase):
```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
if ([[ "$GSD_ARGS" =~ --auto ]] || [[ "$GSD_ARGS" =~ --chain ]]) && [[ "$AUTO_CHAIN" != "true" ]]; then
  gsd_run query config-set workflow._auto_chain_active true
fi
```

**If `--auto` or `--chain` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true:**

Display banner:
```
### GSD ► AUTO-ADVANCING TO EXECUTE

Plans ready. Launching execute-phase...
```

Launch execute-phase using the Skill tool to avoid nested Task sessions (which cause runtime freezes due to deep agent nesting):
```
Skill(skill="gsd-execute-phase", args="${PHASE} --auto --no-transition ${GSD_WS}")
```

The `--no-transition` flag tells execute-phase to return status after verification instead of chaining further. This keeps the auto-advance chain flat — each phase runs at the same nesting level rather than spawning deeper Task agents.

**Handle execute-phase return:**
- **PHASE COMPLETE** → Display final summary:
  ```
### GSD ► PHASE ${PHASE} COMPLETE ✓

  Auto-advance pipeline finished.

  Next: /gsd:discuss-phase ${NEXT_PHASE} --auto ${GSD_WS}
  ```
- **GAPS FOUND / VERIFICATION FAILED** → Display result, stop chain:
  ```
  Auto-advance stopped: Execution needs review.

  Review the output above and continue manually:
  /gsd:execute-phase ${PHASE} ${GSD_WS}
  ```

**If neither `--auto` nor config enabled:**
Route to `<offer_next>` (existing behavior).

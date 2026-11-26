# How to run the TDD RED gate on a stronger model

Use a stronger model for the RED step of a `type: tdd` plan (writing the failing test) and a cheaper one for GREEN and REFACTOR (making that test pass), inside one plan. This guide assumes TDD mode already works for you. If it does not, start with the [TDD pipeline mode](../features/tdd-pipeline-mode.md) section of the feature reference.

---

## 1. Turn on TDD mode

The split only applies when `workflow.tdd_mode` is `true`:

```bash
gsd-tools config-set workflow.tdd_mode true
```

## 2. Name the model for each gate

Set the gate you want to change, plus the executor's own model for everything else, in `.planning/config.json`:

```json
{
  "model_overrides": {
    "gsd-executor:tdd-red": "opus",
    "gsd-executor": "sonnet"
  }
}
```

An unset gate key uses the routed executor's own model, so the example above runs RED on `opus` and GREEN/REFACTOR on `sonnet`. To change only GREEN/REFACTOR, set `gsd-executor:tdd-green-refactor` instead.

If a plan uses a specialist executor (`agent_hint: acme-rails-executor`), the keys are `acme-rails-executor:tdd-red` and `acme-rails-executor:tdd-green-refactor`, and an unset one uses that specialist's own model.

If your repository is shared by several runtimes, give each key an object keyed by runtime, as for any [per-agent override](../CONFIGURATION.md#per-agent-overrides): `"gsd-executor:tdd-red": { "claude": "opus", "codex": "gpt-6-astra" }`.

## 3. Check what each gate resolves to

```bash
gsd-tools query resolve-model "gsd-executor:tdd-red" --fallback-agent gsd-executor --raw
gsd-tools query resolve-model "gsd-executor:tdd-green-refactor" --fallback-agent gsd-executor --raw
```

These are the calls `execute-phase` makes. A gate prints the model you set for it only when its key is set; when `execute-phase` sees the fallback it uses the executor's own model instead. In the `--raw` output a gate with no key prints the `gsd-executor` model. If both gates would use the same model, the plan will not split.

## 4. Run the phase

Run `/gsd-execute-phase` as usual. A split plan shows two executor dispatches for the one plan: first RED, then GREEN/REFACTOR. The `SUMMARY.md` comes from the second one.

## When nothing splits

A plan that did not split ran as one dispatch on `gsd-executor`'s model. That is not an error. Work down this table to find out why:

| Reason | How to tell | What to do |
|---|---|---|
| TDD mode is off | `gsd-tools config-get workflow.tdd_mode` prints `false` | Step 1 |
| The plan is not `type: tdd` | The plan's frontmatter has another `type:` | Only `type: tdd` plans split. A `tdd="true"` task inside a standard plan never does. |
| Both gates would use the same model | Neither key is set, or both name the same model | Set a gate key to a different model |
| The phase runs on the `orchestrator-worktree` backend | `execute-phase` printed `keeps a single dispatch` on stderr | Not supported; the plan keeps one dispatch |
| The plan names `executor_runtime` | Its frontmatter declares it; the same stderr note appears | Not supported; the foreign runtime's own model applies |
| A gate model could not be resolved | `execute-phase` printed `could not resolve its TDD gate models` on stderr | Run step 3 and fix the error it prints |

## When a split plan stops after RED

The orchestrator checks the RED dispatch before it starts GREEN. If the RED dispatch reports a halt (`INVALID_RED`, or the test passed before any implementation), no `test(...)` commit for the plan is in the git log, or the dispatch also wrote a `SUMMARY.md` or an implementation commit, the plan stops and the executor's report is shown. Fix the test, then run the phase again. If the RED commit already exists and no `SUMMARY.md` does (a resumed plan), the run skips the RED dispatch and starts at GREEN/REFACTOR.

## Limits

- A split plan runs in the orchestrator's own working tree in sequential mode, not an isolated worktree, so it is serialized against the other plans of its wave.
- Effort is not switched per gate. Reasoning effort still comes from the agent's own configuration.
- Only `execute-phase` splits plans. The standalone execute-plan path keeps one dispatch.

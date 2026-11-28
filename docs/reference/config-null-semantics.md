# Config section null semantics

> Reference. How an explicit non-object section such as `"workflow": null` interacts with the
> config merge. The unreadable-file behavior is in [Configuration](../CONFIGURATION.md#when-your-config-file-cannot-be-read).

A section that is present but is not an object (for example, `"git": null`) is an explicit
inheritance barrier. GSD does not silently recreate that section's flattened values from lower
files or built-in defaults. This applies to project and global-defaults loading. The planner
watchdog is the fail-safe exception: `"planner": null` still leaves
`planner_stall_detection_enabled` enabled, while the raw per-key resolver reports
`planner.stall_detection_enabled` as not configured.

An explicit `workflow: null` removes every `workflow.*` default, including research,
plan-checker, verifier, Nyquist validation, TDD, subagent timeout and the security settings
`security_enforcement`, `security_asvs_level` and `security_block_on`. Init payloads report
absent gate flags as `false`. An explicit `review: null`
removes the prompt-budget default, so reviewer lanes run without default prompt trimming.
Use an object with explicit settings when those safeguards should remain enabled.

An explicit `planning: null` removes planning defaults, including `commit_docs`, so planning commits are skipped unless a flat `commit_docs: true` in the effective config (the root file merged with the active workstream file) explicitly enables them. An explicit `git: null` removes inherited/default branching strategy, base branch and branch templates. Explicit flat keys in that effective config retain precedence over their blocked nested aliases, including a flat `max_prompt_tokens` under `review: null`. Only a flat key the loader actually reads keeps its value: a top-level `repo_tagging` or `tdd_mode` is not read, so it does not keep the projection that `git: null` or `workflow: null` removes.

A workstream section that is an object replaces a non-object section in the root file, the way the loader merges the two files. With root `"workflow": null` and workstream `"workflow": {}`, `workflow.*` defaults apply. The reverse (root object, workstream `"workflow": null`) still blocks them.

`parallelization` is outside this barrier. Its flat spelling is a legitimate boolean (`"parallelization": true`), so `"parallelization": null` falls back to the default for the assembled config, while the per-key resolver reports `parallelization.enabled` as not configured in every state, because it is not an eligible resolver key.

The same applies to the global `$GSD_HOME/.gsd/defaults.json`. If the project config is also unusable, the
project one is reported, since that is the file you are most likely able to fix.

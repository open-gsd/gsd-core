---
id: 5328
title: Agent Model Guard
group: v1.7.0 Features
---

**Purpose:** Catch an orchestrator that dispatches a guarded GSD agent on a model other than the one GSD resolved for it (#5328).

PreToolUse hook. Besides the isolation-parameter check, on Claude Code it compares the `model` passed to `Agent()`/`Task()` for `gsd-executor`, `gsd-verifier`, `gsd-plan-checker` and `gsd-planner` with the resolved model (tier level: `claude-sonnet-4-6` equals `sonnet`). `hooks.agent_model_guard`: `"warn"` (default; any other stored value behaves as warn) adds model-visible context on mismatch, `"deny"` blocks a wrong or an omitted model, `false` disables. A deliberate escalation via `resolve-execution <agent>` (`--attempt N` or `--failure-class`) writes a single-slot `.gsd/model-escalation-<agent>.json` that the guard honours for 10 minutes, only for a model of the same tier family and, when both the dispatch and the record carry a session id, only if `resolve-execution` ran in that session; nothing clears it earlier. `--attempt N` records only when `dynamic_routing` `tier_models` or a quota `--failure-class` resolves a model other than the baseline; otherwise it resolves the baseline and records nothing, so under `"deny"` pass the resolved model. Fails open on any inability to verify, including a root `.planning/config.json` larger than 64 KiB, so `"deny"` is not enforced then.

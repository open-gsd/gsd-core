# Harness advisor inheritance and the planning subsystem

Date: 2026-11-14. Point-in-time research record, `next` at d741273228. Claude Code current release at time of writing: 2.1.325 (npm, published 2026-11-13).
Question: do recent Claude Code harness changes (primarily the `--advisor` / advisor tool feature) interfere with GSD's planning chain (plan-phase -> gsd-planner / gsd-plan-checker -> execute-phase -> gsd-executor -> gsd-verifier) and its model-selection layer (`model_profile`, `model_overrides` in `.planning/config.json`)?
Scope: research only. No source edits. The owner's field report is treated as a set of claims to verify.

## 1. Summary

- CONFIRMED (documented): Claude Code subagents inherit the session's configured advisor. "Subagents inherit the configured advisor and apply the same pairing check against their own model." ([advisor docs](https://code.claude.com/docs/en/advisor), "Choose an advisor model"). GSD's planner, plan-checker, executor and verifier are ordinary subagents, so all of them get the advisor in an advisor session.
- QUALIFIED: "regardless of the agent's own `model:`" is not quite right. Inheritance is subject to a per-subagent pairing check: the advisor must rank at or above the subagent's model. A subagent whose model outranks the advisor runs without it; a lower-ranked subagent keeps it even when the main model is too strong for it ("Subagents whose own model satisfies the pairing may still use the advisor"). For GSD's default profiles (opus/sonnet/haiku agents, Opus or Fable advisor) the check always passes, so in practice every GSD agent gets the advisor.
- CONFIRMED: `model_profile` / `model_overrides` select only the subagent's executor model (the Agent tool `model` parameter or `model:` frontmatter). There is no per-subagent advisor field; the upstream request for one ([anthropics/claude-code#73072](https://github.com/anthropics/claude-code/issues/73072)) was closed NOT_PLANNED (stale) on 2026-09-15.
- CONFIRMED: every advisor call sends the calling agent's full transcript, is billed at the advisor model's rates, and is uncached by default. Advisor tokens are reported only in `usage.iterations[]` entries of `type: "advisor_message"`; "Top-level `usage` fields reflect executor tokens only" ([API advisor tool, Usage and billing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#usage-and-billing)).
- CONFIRMED (mitigations): `/advisor off`, unsetting `advisorModel`, and `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` are all documented. `/advisor <model>` persists to `~/.claude/settings.json`. The env var is not headless-only; it works in every mode.
- INDEPENDENT MEASUREMENT (this machine): inheritance reproduced; the per-call usage numbers could not be reproduced (see section 3).
- GSD IMPACT: GSD neither detects nor warns about an active advisor. GSD documents the inheritance as a feature (`gsd-core/references/model-profiles.md:140-165`), but that section points at a closed upstream issue as "tracked", omits the cost and model-correlation consequences, and gives a stale minimum version. GSD has no token/cost accounting that sums transcript `usage`, so it does not mis-sum `usage.iterations`; its only token arithmetic is context occupancy (statusline), which advisor tokens do not occupy.
- OTHER HARNESS CHANGES: in the last three months Claude Code added an Agent-tool `effort` parameter (2.1.292), changed subagent effort resolution (2.1.316, 2.1.317), changed `CLAUDE_CODE_SUBAGENT_MODEL` precedence (2.1.251) and added `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (2.1.257). Two GSD statements are now stale as a result (`gsd-core/references/model-profiles.md:236` "Agent tool has no per-spawn effort parameter"; `gsd-core/workflows/execute-phase.md:107` full-ID example). Details in section 4.

## 2. Claims verification

| # | Owner claim | Verdict | Primary source |
|---|---|---|---|
| 1 | Claude Code hands a session's `--advisor` to every subagent it spawns | Confirmed, with a pairing-check qualifier | [advisor docs](https://code.claude.com/docs/en/advisor): "Subagents inherit the configured advisor and apply the same pairing check against their own model." |
| 2 | ...regardless of the agent's own `model:` | Contradicted in part | Same page: inheritance is gated by a per-subagent pairing check ("an advisor must rank at or above your session's main model"); "Claude Code doesn't apply an Opus or Sonnet advisor to a Fable main model". A `model:` above the advisor's rank removes it. Not contradicted for GSD's default tiers |
| 3 | GSD planner, executor, plan-checker, verifier can all consult the advisor | Confirmed | Claim 1 + they are subagents spawned via `Agent()` (`gsd-core/workflows/plan-phase.md:969`, `:1105`; `gsd-core/workflows/execute-phase.md:683`) |
| 4 | `model_overrides` / `model_profile` do not change that | Confirmed (except via claim 2's rank effect) | Model order in [sub-agents docs](https://code.claude.com/docs/en/sub-agents), "Choose a model", has no advisor term; no `advisor` frontmatter field is documented; #73072 closed NOT_PLANNED |
| 5 | Inheritance: 325/325 subagents in advisor sessions, 0/220 without | Not documented (measurement claim) | Local re-measurement: inheritance reproduced on every subagent in advisor sessions; no non-advisor control sessions exist on this machine (section 3) |
| 6 | Usage counts: 452 completed calls / 541 attempts / 279 of 325 subagents; per-agent ratios; main sessions 32 calls | Not documented; not reproduced | Local transcripts in the same version range record zero advisor call blocks and zero `advisor_message` iterations (section 3) |
| 7 | Each call sends the agent's whole context | Confirmed | API doc: advisor "receives the executor's full transcript as quoted context"; CC doc: "The advisor receives the full conversation, including every tool call and result" |
| 8 | 93.4M input tokens, zero cache reads | Zero cache reads consistent with docs; total not reproduced | API doc: advisor-side `caching` defaults to `null` (off). CC doc: "The advisor model's own read of the conversation is not cached. Each advisor call processes the full transcript anew" |
| 9 | Advisor tokens are in `usage.iterations`, outside top-level `usage` | Confirmed | API doc: "Top-level `usage` fields reflect executor tokens only. Advisor tokens are not rolled into the top-level totals" |
| 10 | A cheap executor profile is not cheap in an advisor session | Confirmed in direction (magnitude workload-dependent) | CC doc "Cost": "each call consumes tokens at the advisor model's rates in addition to your main model's usage"; subscription usage counts toward plan limits |
| 11 | A verifier in an advisor session is not independent of the advisor model | Confirmed for model diversity; context stays separate | Each subagent's advisor sees only that subagent's transcript (API doc), so context isolation holds; the same advisor model reviews planner, executor and verifier turns, so model-level judgement is shared |
| 12 | `/advisor off` before a chain: agents spawned after do not get it | Not documented explicitly; consistent with docs | Docs say subagents inherit "the configured advisor"; `/advisor off` changes that configuration. No doc statement about already-running subagents |
| 13 | `/advisor <model>` persists `advisorModel` to user settings.json | Confirmed | [settings reference, `advisorModel`](https://code.claude.com/docs/en/settings-reference): "Claude Code saves your pick to this key in `~/.claude/settings.json`" (session-only from Remote Control / remote workers) |
| 14 | Headless: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | Confirmed, and broader than headless | [env-vars](https://code.claude.com/docs/en/env-vars): "`/advisor` becomes unavailable, any configured `advisorModel` is ignored, and the `--advisor` flag is accepted but has no effect" |
| 15 | Range Claude Code 2.1.312-2.1.322 | Consistent | Advisor present since at least 2.1.117 (CHANGELOG "Advisor Tool (experimental)"); no advisor-inheritance change in 2.1.312-2.1.325 |

## 3. Independent measurement

Method. Script outside the repo (session scratchpad, `measure.cjs`), aggregate counts only. Layout (matches [sub-agents docs](https://code.claude.com/docs/en/sub-agents), "`~/.claude/projects/{project}/{sessionId}/subagents/`"): main transcript `~/.claude/projects/<project>/<sessionId>.jsonl`; subagent transcripts `<project>/<sessionId>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json` (`agentType`, `model`). Signals used:
- advisor configured on a turn: `advisorModel` field on `assistant` records;
- advisor attached to a request: an `api-request-shape` record whose tool list contains `"type":"advisor_20260301"`;
- advisor call: an assistant content block `type:"server_tool_use"`, `name:"advisor"`, its `advisor_tool_result` (success vs `advisor_tool_result_error`), and `usage.iterations[]` entries of `type:"advisor_message"`, deduplicated by message id.
Sessions are bucketed by first timestamp; the version-filtered run keeps only transcripts whose every `version` is in 2.1.312-2.1.322.

| Metric | Owner | Local, 2026-10-31..11-14 (all versions, 2.1.309-2.1.323) | Local, versions 2.1.312-2.1.322 only | Local, 2026-09-01..10-30 (2.1.293-2.1.314) |
|---|---|---|---|---|
| Main sessions with advisor / without | 22 sessions total, 7 projects | 93 / 0 (28 project dirs) | 91 / 0 (27) | 168 / 0 (40) |
| Subagents in advisor sessions carrying `advisorModel` | 325/325 | 2737/2737 | 2691/2691 | 2035/2035 |
| ...with the advisor tool in the request shape | n/a | 2737/2737 (sonnet 2204/2204, opus 515/515, haiku 17/17) | n/a | 1911/2035 (124 have no shape record) |
| Subagents in non-advisor sessions carrying it | 0/220 | no control group (0 sessions) | no control group | no control group |
| GSD planning agents present | executor 117, planner 39, verifier 34, plan-checker 29 | planner 3, plan-checker 3 | planner 3, plan-checker 3 | executor 260, planner 39, verifier 28, plan-checker 27 |
| Advisor call blocks / `advisor_message` iterations (subagents) | 541 attempts, 452 completed | 0 / 0 | 0 / 0 | 0 / 0 |
| Advisor calls, main sessions | 32 | 0 | 0 | 0 |
| Advisor input tokens | 93.4M, 0 cache reads | 0 | 0 | 0 |

Findings.
- Inheritance reproduced at scale: every subagent of every advisor session (4,772 across both windows) carried the session's advisor, and every subagent with a request-shape record (4,648) had the advisor tool attached, including all sonnet and haiku agents and the GSD planner/executor/verifier/checker agents. This matches the documented rule.
- No control group: `~/.claude/settings.json` has no `advisorModel`, yet all 261 main sessions in both windows carried one, so they were started with `--advisor` (or an equivalent launcher). The owner's 0/220 negative case cannot be checked here.
- Usage not reproduced: across both windows, no transcript holds an advisor `server_tool_use` block, an `advisor_tool_result`, or an `advisor_message` iteration; recorded `usage.iterations[]` entries are all `type:"message"`. A full-tree string scan of all 6,193 transcript files under `~/.claude/projects` found the three advisor result/iteration strings in exactly one file, and there only inside request-payload records, not in assistant content or usage. Either the advisor was never called in this corpus, or this Claude Code build does not persist advisor blocks and iterations to local transcripts. The agent cannot tell these apart from transcripts alone; the owner's corpus, on another dataset, did record them. A controlled run (one session, `consult the advisor before you continue`, then inspect the transcript) would settle it.
- Session counts differ (owner 22 sessions / 7 projects / 545 subagents; local 93 / 28 / 2,737 for the comparable window). The owner's counts are on another dataset or filtered to GSD sessions; the agent did not try to reconstruct that filter.
- 5 subagents (1 in the earlier window) had the advisor although the parent's last recorded assistant turn before the spawn had none. All are in sessions that had the advisor elsewhere. The most likely cause is that the spawn came before the parent's first assistant record (the measurement then reads "off"); the transcripts do not show an `/advisor off` toggle, so this is not evidence for or against owner claim 12.

## 4. Other harness changes (Claude Code CHANGELOG, roughly 2026-08-14 to 2026-11-13)

Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (versions carry no dates; dates are npm publish times from `npm view @anthropic-ai/claude-code time`). Only entries that touch the planning chain are listed.

| Version (date) | Change | Effect on GSD planning |
|---|---|---|
| 2.1.251 (2026-08-28) | "`CLAUDE_CODE_SUBAGENT_MODEL` to set the default subagent model rather than override everything: an agent definition's `model:` and an explicit per-spawn model now take precedence" | GSD's per-spawn `model=` and install-baked `model:` frontmatter now win over the env var; a user who relied on the env var to force all GSD agents onto one model lost that |
| 2.1.257 (2026-09-01) | Added `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` "ignoring per-spawn and agent-definition model overrides" | A harness-level override that silently makes `model_profile` / `model_overrides` inert; GSD does not detect it |
| 2.1.257 | "Fixed sessions with an advisor model set missing the prompt cache on background requests" | Advisor sessions were more expensive than necessary before this |
| 2.1.259 | "Fixed frontmatter `model:` on custom commands and skills being ignored in interactive sessions" | Skill/command-level `model:` now honoured |
| 2.1.265 (2026-09-08) | Advisor decision "made once and announced in the conversation when it changes" | Advisor state is per-conversation, not per-request |
| 2.1.267 | "Fixed `effort:` frontmatter on custom commands, skills, and subagents being ignored on models whose default effort is still pinned" | GSD's baked `effort:` was a no-op on Opus 4.7/4.8/Fable 5 before |
| 2.1.273 (2026-09-15) | "Fixed the context meter and auto-compact counting advisor-tool turns at roughly twice their real context size" | Before 2.1.273, advisor sessions auto-compacted at about half the window and GSD's context monitor (which consumes the statusline's remaining percentage) warned early |
| 2.1.285 | Fork subagents keep the parent's plan mode | Forks of a planning session cannot exit plan mode |
| 2.1.290 | `serverToolUses` (the advisor's calls) exposed to a mod's `turn.step` hook | Only harness-side observation channel for advisor calls; not a GSD hook surface |
| 2.1.292 (2026-10-06) | "Added an `effort` parameter to the Agent tool" | Contradicts `gsd-core/references/model-profiles.md:236` ("Claude Code's Agent tool has no per-spawn effort parameter") |
| 2.1.296 | `autoCompactWindow` subagent frontmatter; `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` | New per-agent context knob GSD does not set |
| 2.1.300 | Agent hooks honour `model`; `agent.spawn` mod hook can rewrite a workflow agent's `model` | A mod can override GSD's chosen model at spawn |
| 2.1.302 (2026-10-16) | Desktop/VS Code always background the main conversation's subagents; a subagent's own Agent calls in `-p`/SDK/desktop/VS Code default to foreground | Changes the foreground/background shape GSD's orchestrators assume per surface |
| 2.1.307 | "Fixed subagent transcripts recording placeholder token usage and an empty stop reason for streamed responses" | Transcript-derived token totals before 2.1.307 are unreliable for subagents |
| 2.1.316 (2026-10-31) | Added `CLAUDE_CODE_SUBAGENT_EFFORT` | Default subagent effort when nothing names one |
| 2.1.317 (2026-11-02) | "subagents and teammates on a different model from the main conversation to use that model's saved effort level or its default, instead of the session's effort level" | GSD agents on a different model than the orchestrator no longer inherit session effort; only baked `effort:` frontmatter or the new Agent `effort` parameter sets it |
| 2.1.318 | Subagents stop instead of switching models when the flagged-message setting is "Ask each time"; background subagents background a shell command after 3 minutes | Long executor Bash calls move to background |
| 2.1.325 (2026-11-13) | "Fixed subagents with their own model being moved to the plan-mode model when the model setting is `opusplan` or `haiku`" | Before 2.1.325, a GSD session on `opusplan` could run planner/executor on the plan-mode model instead of the profile's choice |

Inheritance documented on [sub-agents](https://code.claude.com/docs/en/sub-agents): subagents inherit permission rules and permission mode, "your main conversation's extended thinking configuration. There is no per-subagent thinking setting", and tools; the context window "is sized by its own model". Model order: per-invocation `model` parameter ("takes a model alias, not a full model ID or `inherit`") > definition `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > parent model.

Other runtimes. No GSD runtime descriptor declares an advisor-type capability (`capabilities/*/capability.json` `hostBehaviors`; `gsd-core/bin/lib/capability-validator.cjs:1967` lists `nativeModelAliases` but nothing advisor-related). Codex, OpenCode and Kilo declare `bakesStaticAgentModel` (`capabilities/codex/capability.json:119`, `capabilities/opencode/capability.json:139`, `capabilities/kilo/capability.json:128`), i.e. the model is fixed in the agent file at install time. The agent found no primary source for an inherited second-model consultation feature in those runtimes; none is claimed.

## 5. GSD code impact

| file:line | What it does | Interaction with the advisor / harness |
|---|---|---|
| `src/model-resolver.cts:525-711` (`resolveModelInternal`) | Resolves an agent's executor model: `model_overrides` > `model_policy` > runtime tier map > `resolve_model_ids:"omit"` > claude tier override > `dynamic_routing` > profile alias | No advisor term; the advisor is outside every layer of this ladder |
| `src/model-resolver.cts:706-707` | `resolve_model_ids: true` materializes full model IDs | Claude Code's Agent tool `model` parameter "takes a model alias, not a full model ID" (sub-agents docs); the comment at :702-705 already says full IDs cannot spawn on Claude |
| `src/commands.cts:566-591` (`cmdResolveModel`) | `resolve-model` CLI returns `{model, profile, effort, tier}` | Reports no host-side modifiers (advisor, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`), so its output can disagree with what actually runs |
| `src/install-model-override-resolver.cts:329-341` | Bakes `model_overrides` / tier models into agent frontmatter at install | Frontmatter `model:` is order 2 in Claude Code; a per-invocation `model=` wins, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides both |
| `gsd-core/workflows/plan-phase.md:110`, `:969`, `:1105`, `:1202` | Spawns planner/checker with `model="{planner_model}"` / `"{checker_model}"` | Advisor inherited regardless |
| `gsd-core/workflows/execute-phase.md:107` | "Only set `model=` when `executor_model` is an explicit model name (e.g., `"claude-sonnet-5"`...)" | Example contradicts the documented Agent `model` parameter (aliases only); the resolver returns aliases on Claude, so the prose is stale, not the behaviour |
| `gsd-core/workflows/execute-phase.md:683` | Executor spawn | Advisor inherited |
| `gsd-core/references/model-profiles.md:140-165` | Advisor section | Documents inheritance as a benefit. Gaps: (a) :142 "v2.1.98+" not verifiable against the CHANGELOG, whose first advisor entry is 2.1.117; (b) :165 says per-agent control "is tracked upstream at #73072" but it was closed NOT_PLANNED on 2026-09-15; (c) no mention of full-context-per-call cost, uncached advisor reads, the `usage.iterations` reporting split, or shared advisor-model judgement across planner/checker/verifier; (d) no off-switch guidance |
| `gsd-core/references/model-profiles.md:236` | "Claude Code's Agent tool has no per-spawn effort parameter" | Stale since 2.1.292 |
| `hooks/gsd-statusline.js:450-457`, `:771-774` | Sums `context_window.current_usage` (input + cache-creation + cache-read [+ output]) | Context occupancy, not cost. Advisor tokens do not occupy the executor's window, so excluding them is correct. Pre-2.1.273 hosts over-counted advisor turns upstream of this hook |
| `hooks/gsd-context-monitor.js:39-40`, `:420-424` | Warns at remaining <= 35% / 25% | Consumes host-computed remaining percentage; inherits the pre-2.1.273 advisor double-count on older hosts |
| `src/profile-pipeline.cts:98-108` | Reads `~/.claude/projects/*.jsonl` for user profiling | Extracts messages only; no token arithmetic |
| `gsd-core/workflows/stats.md` | `/gsd-stats` | No token or cost fields |
| `agents/gsd-verifier.md:21` | "Do NOT trust SUMMARY.md claims" | Independence from the executor's narrative, by fresh context. Holds under the advisor (separate transcript), but the same advisor model judges both |
| `docs/FEATURES.md:2305` | "on Claude Code, plan and execute run inline to preserve worktree isolation and independent verification" | Independence assumed; advisor not considered |
| `docs/how-to/set-up-cross-ai-review.md:15` | "different models have different blind spots" | The rationale the advisor erodes inside a single runtime |

Detection / warning: none. `git grep` over `src/`, `gsd-core/`, `hooks/`, `agents/`, `commands/` finds no read of `advisorModel`, `--advisor`, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, `advisor_message` or `usage.iterations`.

Token accounting: GSD has no cost/token roll-up that reads transcript `usage`. The owner's warning about summing top-level `usage` applies to third-party transcript cost tools and to any future GSD cost feature, not to current GSD code.

## 6. Harness leak points (scope reduced; deepening analysis owned by a separate architecture pass)

- `src/model-resolver.cts:525` — the model "decision" module answers only one of the harness's model inputs; advisor, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `agent.spawn` mod rewrites and `opusplan` behaviour happen after it and are invisible to it.
- `src/commands.cts:566` — `resolve-model` presents its answer as the agent's model with no "host may modify" field.
- `gsd-core/workflows/plan-phase.md:110` and `gsd-core/workflows/execute-phase.md:107` — Agent-tool parameter rules (alias-only `model`, omit for inherit) are restated in workflow prose per workflow instead of owned by one runtime-descriptor seam; :107 has already drifted.
- `gsd-core/references/model-profiles.md:140-165`, `:236` — host feature facts (advisor, effort parameter) live in hand-written reference prose with no version anchor; two have gone stale.
- `capabilities/claude/capability.json:109-113` — `hostBehaviors` has no field for host-side model modifiers, so no GSD code can reason about them.
- `hooks/gsd-context-monitor.js:420` — trusts the host's remaining-percentage arithmetic, which was wrong for advisor sessions before 2.1.273.
- `docs/FEATURES.md:2305`, `agents/gsd-verifier.md:21` — verification independence is defined only as context independence; the model-diversity dimension is not stated, so a harness that shares a reviewer model across agents breaks no explicit contract.

## 7. Mitigations for users

- Start GSD planning/execution sessions without `--advisor`, or run `/advisor off` before `/gsd-plan-phase` / `/gsd-execute-phase`. Note `/advisor <model>` writes `advisorModel` to `~/.claude/settings.json`, so later sessions started without the flag still get it; check that key.
- To disable entirely (any mode, including `-p` and the Agent SDK): `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. `--advisor` is then accepted but ignored ([env-vars](https://code.claude.com/docs/en/env-vars)).
- If the advisor is wanted for some agents only: there is no per-agent switch. Rank is the only lever: a subagent whose model outranks the advisor runs without it. That is not a practical control for GSD tiers.
- For cost estimates in advisor sessions, sum `usage.iterations[]` entries with `type: "advisor_message"` separately and price them at the advisor model's rates; top-level `usage` excludes them.
- Hosts older than 2.1.273: expect early auto-compaction and early GSD context warnings in advisor sessions. Hosts older than 2.1.325 on `opusplan`: subagent models may be replaced by the plan-mode model.
- Check for `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in the environment: when set, `model_profile` and `model_overrides` have no effect.

## 8. Sources

- Claude Code, advisor: https://code.claude.com/docs/en/advisor
- Claude Code, sub-agents (model order, inheritance, effort, forks, transcript layout): https://code.claude.com/docs/en/sub-agents
- Claude Code, settings reference (`advisorModel`, `effortLevel`): https://code.claude.com/docs/en/settings-reference
- Claude Code, environment variables (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, `CLAUDE_AUTO_BACKGROUND_TASKS`): https://code.claude.com/docs/en/env-vars
- Claude Code CHANGELOG: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (fetched 2026-11-14, head 2.1.325)
- npm publish times: `npm view @anthropic-ai/claude-code time`
- Claude API, advisor tool (usage, caching, errors): https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Upstream per-subagent advisor request: https://github.com/anthropics/claude-code/issues/73072 (closed NOT_PLANNED, 2026-09-15)
- GSD files cited inline at `next` d741273228.

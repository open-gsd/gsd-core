# ADR 443: Unified cross-provider effort controls and fast-mode-aware routing

- **Status:** Proposed (2026-05-28)
- **Date:** 2026-05-28
- **Tracking issue:** [#443](https://github.com/open-gsd/get-shit-done-redux/issues/443)

## Context

### Effort control and fast mode in Claude Opus 4.8

Claude Opus 4.8 introduced two orthogonal execution controls relevant to GSD's agent orchestration:

1. **Effort control** — API request field `output_config.effort` (string enum). Anthropic levels: `low`, `medium`, `high`, `xhigh`, `max`; Opus 4.8 defaults to `high`. In Claude Code it is exposed as `/effort`, the `--effort` CLI flag, the `CLAUDE_CODE_EFFORT_LEVEL` env var, the `effortLevel` settings.json key (accepts `low`/`medium`/`high`/`xhigh`; `max` is session-only), and — critically for orchestration — a per-subagent `effort` frontmatter key (shipped per anthropics/claude-code issue #31536, CLOSED/COMPLETED).

2. **Fast mode** — API request field `speed` (`standard`|`fast`); `fast` enables high output-tokens-per-second inference. Pricing for Opus 4.8 fast mode is $10/$50 per MTok in/out vs $5/$25 standard. In Claude Code it is the interactive `/fast` toggle ONLY — there is no settings.json key, env var, or subagent-frontmatter mechanism to enable fast mode for a spawned subagent.

GSD already routes WHICH model runs a task (routingTier `heavy`/`standard`/`light`, model_profile `quality`/`balanced`/`budget`/`adaptive`/`inherit`, `model_overrides`, and dynamic_routing escalation). It had no way to control HOW HARD the model reasons or WHICH speed tier it uses.

### The "flavor text" problem: issue #2517

Issue #2517 added `resolveReasoningEffortInternal` and made `query resolve-model` emit a `reasoning_effort` field derived from the Codex runtime's per-tier catalog values (`model-catalog.json` `runtimeTierDefaults.codex.*.reasoning_effort`). However, a codebase audit found that NO orchestrator, workflow, or agent ever consumes that emitted field — it is never passed to an actual Codex invocation. The resolver computed a value and a test asserted the computed JSON, but the value reached no runtime. The feature was inert ("flavor text, no code"): asserting a resolver's return value is not the same as asserting the control reaches the model.

### Cross-provider effort enum mismatch

The two providers' effort enums are NOT identical:

- **Anthropic/Claude (Opus 4.8):** `low`, `medium`, `high`, `xhigh`, `max` (has `max`; no `minimal`)
- **OpenAI/Codex** (`model_reasoning_effort` / Responses API `reasoning.effort`; SDK `ReasoningEffort` ranks `none=0`, `minimal=1`, `low=2`, `medium=3`, `high=4`, `xhigh=5`): `minimal`, `low`, `medium`, `high`, `xhigh` (has `minimal`; no `max`)

Common core: `low`, `medium`, `high`, `xhigh`.

## Decision

1. **Introduce a single universal `effort` config knob** (and an orthogonal `fast_mode` knob) that compose with model selection rather than replace it. Resolution precedence mirrors the existing model cascade: (1) orchestrator invocation override, (2) `effort.agent_overrides[agent]`, (3) `effort.routing_tier_defaults[routingTier]`, (4) `effort.default`, (5) built-in default `high`. Same cascade for `fast_mode` with built-in default `false`. Invalid enum values at any level are ignored and fall through (mirrors the `VALID_TIERS` gate in `resolveModelInternal`) so a typo never silently breaks resolution.

2. **The universal effort value is provider-agnostic; a per-runtime renderer maps it to each runtime's wire parameter**, clamping the genuinely-unique tail levels:

   - **Claude / API:** param `output_config.effort` (Claude Code: subagent `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env). `minimal` clamps to `low` (Claude has no `minimal`); `low`/`medium`/`high`/`xhigh`/`max` pass through.
   - **Codex:** param `model_reasoning_effort` (Responses API `reasoning.effort`). `max` clamps to `xhigh` (Codex has no `max`); `minimal`/`low`/`medium`/`high`/`xhigh` pass through.

   | Universal level | Claude rendering | Codex rendering |
   | --- | --- | --- |
   | `minimal` | `low` (clamped) | `minimal` |
   | `low` | `low` | `low` |
   | `medium` | `medium` | `medium` |
   | `high` (default) | `high` | `high` |
   | `xhigh` | `xhigh` | `xhigh` |
   | `max` | `max` | `xhigh` (clamped) |

3. **Fold the inert `reasoning_effort` output into this unified model.** `query resolve-model` is preserved for back-compat; a NEW `query resolve-execution` is the superset that emits: `model`, `effort` (universal), the per-runtime rendered effort, the wire param name, the propagation channel, `fast_mode`, and `fast_mode_supported`. Each config key ships help text naming exactly which runtime field/invocation it drives.

4. **Make effort actually reach the runtime (close the flavor-text gap).** Claude is first-class: the resolved effort propagates to spawned subagents via the `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env. Tests assert end-to-end propagation, not just resolver return values.

5. **Fast mode honesty:** because Claude Code has no per-subagent fast-mode mechanism, `fast_mode` is resolved and surfaced (with a `fast_mode_supported` flag, `false` for the claude runtime's subagents) but is NEVER emitted as a fake frontmatter key — doing so would be a silent no-op. It propagates only where the runtime supports it (API `speed:"fast"`).

6. **Dynamic-routing integration is additive:** a new effort-escalation path (effort steps up the ladder on a failed attempt BEFORE model-tier escalation) is gated on the same `dynamic_routing.enabled` / `escalate_on_failure` switches and does NOT modify `resolveModelForTier` (so existing feat-3024 behavior is unchanged).

## Consequences

### Positive

- One coherent effort policy across all runtimes; Claude effort is first-class and actually wired.
- The dead `reasoning_effort` field becomes meaningful; finer-grained cost/quality control (a light-tier scanning agent can run `low` effort; a heavy planning agent `xhigh`) without changing model class.
- Effort-first escalation reduces unnecessary model upgrades.
- Cross-provider clamping is explicit and documented.

### Negative

- The universal enum is the union of two providers' ladders, so two levels (`max`, `minimal`) are runtime-specific and clamp when rendered to the other provider — users must understand the mapping (mitigated by help text and the table above).
- Fast mode remains asymmetric: it cannot be forced per-subagent on Claude Code, only at session level or on API-direct runtimes.
- Updating issue-2517's tests to assert real wiring is a deliberate behavior/contract change (the old "null on claude" assertion encoded the now-false premise that Claude has no effort control).

## Alternatives Considered

**(a) Global effort env override** (e.g. a single `CLAUDE_CODE_EFFORT_LEVEL` for the whole session) — rejected: caps cost but starves heavy agents that legitimately need deep reasoning; static global breaks the per-tier design.

**(b) Model selection alone (status quo)** — rejected: choosing Haiku for light tasks reduces cost, but within one model class there is no way to tune reasoning depth; a quality profile pays full reasoning cost even for scanning.

**(c) Static per-agent effort only** — rejected: loses context sensitivity; the same agent doing trivial vs complex work should not always get the same effort.

**(d) A separate `effort` field kept fully parallel to Codex's existing `reasoning_effort` (two independent lanes)** — rejected: produces two overlapping fields that can diverge and confuse; Codex's `reasoning_effort` is better modeled as one rendering of the single universal effort.

**(e) Overloading the existing `reasoning_effort` field to also carry Claude effort** — rejected: it would conflate a Codex-specific wire name with the universal concept and break the clean per-runtime rendering.

## References

- Tracking issue: #443
- Prior art (inert reasoning_effort): #2517; `tests/issue-2517-runtime-aware-profiles.test.cjs`
- dynamic_routing escalation: #3024; `tests/feat-3024-dynamic-routing.test.cjs`
- phase-type tiers: #3023
- Anthropic effort API: `output_config.effort` (`low`/`medium`/`high`/`xhigh`/`max`); fast mode: `speed` (`standard`/`fast`)
- Claude Code effort: `/effort`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel` setting, subagent `effort` frontmatter (anthropics/claude-code #31536, completed); fast mode: `/fast` (interactive only)
- OpenAI Codex effort: `model_reasoning_effort` config key; Responses API `reasoning.effort`; `ReasoningEffort` enum `none<minimal<low<medium<high<xhigh`

# Effort and fast_mode test strategy

Why the tests for the unified effort and fast_mode engine (issue #443) are shaped as they are: what each layer covers, the architectural invariants and the production failure each prevents, the coverage targets, and what is not yet tested. The suites themselves are catalogued in [Testing Suites](../TESTING-SUITES.md).

> Feature: unified cross-provider effort and fast_mode knobs (issue #443).
> Test files: `tests/model-resolver.test.cjs` (unit),
> `tests/model-resolver.test.cjs` (integration).

## Testing pyramid

| Layer | File | What it covers |
|---|---|---|
| **Unit** | `feat-443-effort-fast-mode.test.cjs` | Pure logic: cascade rules, clamping, escalation math, malformed config handling, schema key validation. No CLI subprocess. |
| **Integration** | `feat-443-effort-fast-mode.integration.test.cjs` | Architecture-level invariants: cross-provider validity, totality across the 33-agent registry, CLI JSON contract, config round-trip, fast-mode honesty. Real subprocesses via `runGsdTools`. |
| **E2E** *(pending)* | *(not yet wired)* | Propagation layer: effort frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env actually reaching a spawned Claude Code subagent. See "Gaps" below. |

## Architectural invariants

Each invariant exists to prevent a specific class of production failure.

### (a) Cross-provider validity

**What:** `renderEffortForRuntime(runtime, universalEffort).value` must always
be a member of the runtime's real provider enum. Ground-truth enums are defined
as local constants in the test — not sourced from the implementation.

```
PROVIDER_EFFORT_ENUMS = {
  claude: Set { 'low', 'medium', 'high', 'xhigh', 'max' }   // Anthropic output_config.effort
  codex:  Set { 'minimal', 'low', 'medium', 'high', 'xhigh' } // OpenAI model_reasoning_effort
}
```

**Why:** Passing a value outside these sets results in a 400 from the real API.
The clamping logic (`max -> xhigh` for codex; `minimal -> low` for claude) must
hold for every cell of the VALID_EFFORTS × runtimes matrix.

### (b) Param/channel contract

**What:** Each runtime exposes a stable `param` string (the native API field
name) and `channel` (how the value is propagated). Unknown runtimes return
`param: null, channel: null` and pass the effort value through unchanged.

**Why:** Callers read `.param` to construct the dispatch payload. A regression
here would silently drop effort from subagent invocations.

### (c) Resolve-execution JSON contract

**What:** The `gsd-tools resolve-execution <agent>` command emits a JSON object
with all eight keys present and typed correctly: `model` (string), `profile`
(string), `effort` (VALID_EFFORTS member), `effort_rendered` (string),
`effort_param` (string|null), `effort_propagation` (string|null), `fast_mode`
(boolean), `fast_mode_supported` (boolean).

**Why:** Orchestrators and workflow dispatchers parse this JSON. A missing or
mistyped field silently breaks downstream consumers.

### (d) Totality across the real registry

**What:** For every agent in the 33-agent registry, `resolveEffortInternal`
returns a VALID_EFFORTS member (never undefined/null), `resolveFastModeInternal`
returns a strict boolean, and `renderEffortForRuntime('claude', effort)` stays
within the claude provider enum.

**Why:** A catalog addition that introduces a missing `routingTier` mapping
would otherwise produce `undefined` and propagate silently.

### (e) Fast-mode honesty invariant

**What:** When the runtime is `claude`, `fast_mode_supported` in
resolve-execution output is always `false`, regardless of the fast_mode config.
`RUNTIMES_WITH_FAST_MODE` contains only `'api'`.

**Why:** Claude Code's `/fast` toggle is session-level only. Emitting
`fast_mode: true` as frontmatter on a Claude subagent is a silent no-op.
Advertising `fast_mode_supported: true` for claude would cause orchestrators to
believe the knob was wired when it is not.

### (f) Precedence first-valid-wins

**What:** Both effort and fast_mode use a layered cascade. The test table covers
all four effort layers (invocation override → agent_overrides →
routing_tier_defaults → default) and all five fast_mode layers, including the
case where an invalid value at a higher layer correctly falls through.

**Why:** Silent precedence bugs (e.g., a numeric value in agent_overrides not
being rejected) would override intentional user config.

### (g) Dynamic-routing composition

**What:** `resolveEffortForTier` escalates effort by attempt number
independently of the model tier mapping. The test verifies the effort ladder
(`low -> medium -> high -> xhigh -> max`), the `max` clamp, the
`max_escalations` cap, and that `escalate_on_failure: false` suppresses
escalation entirely.

**Why:** Effort escalation and model escalation share configuration
(`dynamic_routing`) but must operate independently; coupling them would cause
over-escalation or under-escalation.

### (h) Config-tooling round-trip

**What:** `gsd-tools config-set` accepts all new key namespaces
(`effort.default`, `effort.routing_tier_defaults.<tier>`,
`effort.agent_overrides.<agent>`, `fast_mode.enabled`,
`fast_mode.routing_tier_defaults.<tier>`, `fast_mode.agent_overrides.<agent>`)
without an "Unknown config key" error, and values set via `config-set` are
reflected in `resolve-execution` output.

**Why:** The schema validation gate (`VALID_CONFIG_KEYS` + `DYNAMIC_KEY_PATTERNS`)
is separate from the resolver logic. A key missing from the schema would produce
a silent write failure and appear as a bug only at runtime.

## Coverage targets

| Suite | Target |
|---|---|
| Unit | Every cascade rule, every fallthrough, every clamp. All function branches in `resolveEffortInternal`, `resolveFastModeInternal`, `resolveEffortForTier`, `renderEffortForRuntime`. |
| Integration | All 8 architectural invariants. All 33 registered agents. All 6 provider × effort combinations for the valid-enum check. Full config-set key namespace. |

## Gaps / not yet covered

**E2E orchestrator-spawn-propagation layer (pending follow-up wiring):**
The integration tests verify that GSD resolves and renders effort values
correctly. They do NOT verify that the rendered values actually reach a spawned
Claude Code or Codex subagent at runtime. Specifically uncovered:

- `CLAUDE_CODE_EFFORT_LEVEL` env var being set and read by a spawned claude subprocess
- `output_config.effort` frontmatter key surviving the AGENTS.md template substitution
- `model_reasoning_effort` field surviving serialization into a Codex API request body
- Fast-mode `speed: "fast"` field reaching an `api`-runtime request when `fast_mode_supported: true`

These require spawning real subagents (or stubs thereof) and asserting on the
process environment / request payload — a scope that belongs in a future E2E
suite under `*.slow.test.cjs` or dedicated fixture-driven integration work.

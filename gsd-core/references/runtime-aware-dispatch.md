# Runtime-Aware Subagent Dispatch (epic #2505 Phase 4 / #2508)

GSD workflows call `Agent(subagent_type="gsd-<role>")` to dispatch specialized
subagents (gsd-planner, gsd-executor, gsd-verifier, …). On **named-dispatch
runtimes** (Claude Code, OpenCode, Cursor, Cline, … — every runtime whose
descriptor declares `hostIntegration.dispatch.namedDispatch: true`), the
`gsd-*` name dispatches the named subagent directly.

On **built-in-only runtimes** (kimi-code — three built-in subagents only:
`coder`, `explore`, `plan`; no custom registration per
`moonshotai.github.io/kimi-code/en/customization/agents`), a `gsd-*` name is
unknown and the dispatch must use the closest built-in.

## Resolution

Before every `Agent(subagent_type="gsd-*")` call, resolve the type for the
current runtime:

```bash
RESOLVED_TYPE=$(gsd_run query resolve-dispatch-type --requested gsd-planner --raw 2>/dev/null || echo gsd-planner)
```

- On named-dispatch runtimes: `RESOLVED_TYPE` is `gsd-planner` (unchanged).
- On kimi-code: `RESOLVED_TYPE` is `plan` (suffix `-planner` → `plan`).
- The `|| echo gsd-<role>` fallback preserves named-dispatch behavior if the
  query is unavailable (older GSD install).

Then dispatch with `$RESOLVED_TYPE`:

```
Agent(subagent_type="$RESOLVED_TYPE", prompt="…${AGENT_SKILLS_<ROLE>}…")
```

## Suffix → built-in map

| Agent name suffix | Built-in | Rationale |
|---|---|---|
| `-planner`, `-roadmapper`, `-selector`, `-spec` | `plan` | Plans/designs; no file writes |
| `-researcher`, `-mapper`, `-checker`, `-verifier`, `-auditor`, `-analyzer`, `-synthesizer`, `-profiler`, `-curator`, `-classifier`, `-reviewer` | `explore` | Read-only investigation |
| everything else (`-executor`, `-fixer`, `-writer`, `-debugger`, …) | `coder` | General-purpose with full tool set |
| `general-purpose`, `general`, `default`, `sonnet`, `opus`, `haiku` | `coder` | Already-generic names |

## Persona injection

The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3 / #2510) regardless of the
resolved type — on non-Claude runtimes with no `agent_skills` config,
`gsd-tools query agent-skills <role>` returns the installed agent prompt as the
block. So `Agent(subagent_type="coder", prompt="…${AGENT_SKILLS_PLANNER}…")`
on kimi-code dispatches the coder built-in WITH the planner persona injected.

## Why not a hook?

Kimi Code's documented PreToolUse hook API
(`moonshotai.github.io/kimi-code/en/customization/hooks`) supports only
`permissionDecision: allow|deny` on blockable events — it cannot rewrite
`tool_input.subagent_type` in flight. A PreToolUse-remap hook (the epic's
original "Option B") is therefore infeasible; this per-dispatch resolution
(Option A) is the documented-API-correct path.

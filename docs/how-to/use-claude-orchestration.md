# Use Claude orchestration for execute waves

Claude orchestration is a default-off capability for Claude Code execution
waves. When enabled, GSD runs a pre-wave policy gate before spawning executor
agents. The first shipped slice does not replace the executor with a generated
Workflow script yet; it makes the backend decision explicit and blocks known
unsafe manual dispatch states.

## Prerequisites

- Runtime resolves to `claude` (`GSD_RUNTIME=claude`, or `runtime: "claude"` in `.planning/config.json`).
- The current shipped slice uses GSD's existing inline executor dispatch path. The
  `workflow` backend value is reserved until the generated Workflow executor ships.

## Enable the capability

```bash
node gsd-tools.cjs query config-set workflow.claude_orchestration true
node gsd-tools.cjs query config-set workflow.claude_orchestration_backend auto
```

Backend choices:

| Value | Behaviour |
|---|---|
| `auto` | Use the current inline dispatch preflight slice; block if Claude agent teams are active |
| `workflow` | Reserved for the generated Workflow executor; block in this slice |
| `inline` | Use existing manual executor dispatch; block if Claude agent teams are active |

## Check the policy before execution

```bash
node gsd-tools.cjs query claude-orchestration.status --raw
```

If `block` is `true`, fix the reported `message` before running
`/gsd-execute-phase`. The execute workflow runs the same policy through
`check claude-orchestration.preflight` before each wave, so unsafe states are
caught even if the environment changes after planning.

## Disable it

```bash
node gsd-tools.cjs query config-set workflow.claude_orchestration false
```

With the capability disabled, GSD uses the existing execute-phase dispatch path.

# Agent Skills Self-Load (Bootstrap)

> **Shared contract.** Every `agent_skills` consumer agent self-loads its configured
> skills in its mandatory init step, so a project's `.planning/config.json`
> `agent_skills.<agent-type>` mapping reaches the agent that actually does the work —
> even when the orchestrator did not run bash init (e.g. a runtime whose `Skill()`
> delegation does not reliably execute the delegated workflow's bash, such as Cursor;
> see open-gsd/gsd-core#1600 / #1601). This is the durable counterpart to the
> orchestrator-side injection documented under
> [Agent Skills Injection](../../docs/CONFIGURATION.md#agent-skills-injection).

## When to run

In your mandatory init step — right after `mandatory-initial-read.md` / the
`Project skills` discovery, before any other work.

## Steps

1. **Dedup guard (MANDATORY).** Look at your own prompt. If it already contains an
   `<agent_skills>` block, the orchestrator already injected one — **skip self-load
   entirely.** Loading a second copy wastes context on runtimes where orchestrator-side
   injection also runs (e.g. Claude Code). The guard is what keeps the two seams from
   doubling the block.

2. **Query your configured skills.** Use **your own agent type** — the `name:` value in
   your frontmatter (e.g. an agent whose frontmatter says `name: gsd-executor` queries
   `gsd-executor`). The query is read-only and idempotent — it exits 0 with an empty
   block when nothing is configured for your type:

   ```bash
   _AGENT_SKILLS=$(gsd_run query agent-skills <YOUR-FRONTMATTER-NAME> 2>/dev/null || true)
   ```

   The runtime `gsd_run` resolver is the standard one from
   `_runtime-launcher.snippet.sh`; your own init already defines it.

3. **Read every listed skill.** The block emits entries as `@<path>/SKILL.md`
   includes — `Read` each one before starting work. If the block is empty, there is
   nothing to do (zero overhead).

## What self-load does and does not cover

| Skill form | Self-loads? | Notes |
|---|---|---|
| Project-relative path (`skills/my-skill`) | ✅ everywhere | `Read` the `@`-include |
| Global personal (`global:<name>`) | ✅ everywhere | resolves to the runtime global skills dir, then `Read` |
| Plugin-provided (`global:<plugin>:<skill>`) | Claude only | emitted as a Skill-tool directive on Claude; **skipped with a warning on all other runtimes** — the plugin/Skill-tool model has no equivalent elsewhere (#1601, #1258). Not closeable on Cursor. |

## Notes

- **Idempotent and read-only.** `query agent-skills` never mutates state; calling it
  twice (once by the orchestrator, once by the agent) is harmless because the dedup
  guard suppresses the second load.
- **No new config keys.** This reuses the existing `agent_skills` map and the existing
  `buildAgentSkillsBlock` / `cmdAgentSkills` machinery (`src/init.cts`). The 22 consumer
  agent types are mirrored in `tests/agent-skills.test.cjs` (`CONSUMER_AGENTS`) and
  guarded against drift by `tests/agent-skills-bootstrap.test.cjs`.
- **Checkers / read-only agents.** Bash is universal across consumer agents, so
  self-load works for plan-checkers, verifiers, and auditors too; the bootstrap assumes
  no tool an agent lacks.

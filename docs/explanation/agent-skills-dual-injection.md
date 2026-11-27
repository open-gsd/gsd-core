# Agent skills dual injection

How configured skills reach a consumer agent, and why there are two paths doing it. The keys that configure skills are in [Agent Skills Injection](../CONFIGURATION.md#agent-skills-injection); the contract itself is recorded in [ADR 1866](../adr/1866-agent-skills-dual-injection-contract.md).

## The two cooperating seams

Skills reach a consumer agent through **two cooperating seams**:

1. **Orchestrator-side (primary on Claude Code).** At spawn time, workflows call `gsd-tools query agent-skills <type>` (or legacy `node gsd-tools.cjs agent-skills <type>`) in their bash init and interpolate the resulting `<agent_skills>` block into the `Task()`/`Agent()` prompt. This is established across ~25 workflows.

2. **Agent-side self-load (durable fallback).** Each of the 22 consumer agents also self-loads in its own mandatory init step — it runs `gsd_run query agent-skills <its-type> --skills-only` (the type is written into the agent file's body; `--skills-only` skips the persona fallback that non-Claude runtimes get from the plain query, so the agent never re-reads its own persona) and `Read`s every listed `SKILL.md` per [`gsd-core/references/agent-skills-bootstrap.md`](../../gsd-core/references/agent-skills-bootstrap.md). This is the path that works on every runtime, including **Cursor**, where `Skill()`-delegated workflow bash init does not reliably execute and `/gsd-autonomous` delegates via flat `Skill()` calls.

Why two: the orchestrator seam is cheap and centralized but depends on the host actually running the workflow's bash init; the self-load seam costs a little at every spawn and therefore works everywhere. The durable fallback exists because a runtime that silently skips the orchestrator path would otherwise run its agents with no configured skills and no signal that anything was missed.

## The dedup guard

If an agent's prompt already contains an `<agent_skills>` block (orchestrator already injected one), the agent skips self-load — so on runtimes where both seams run (Claude Code), the prompt never carries two copies. `query agent-skills` is read-only and idempotent: it exits 0 with an empty block when nothing is configured for the type, so self-load is zero-overhead for unconfigured agents.

## What the injected block looks like

For project-relative and global personal skills, entries appear as `@`-includes:

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- @/Users/you/.claude/skills/shared-conventions/SKILL.md
</agent_skills>
```

For a mixed config (path-resolvable and plugin-provided skills together), entries appear interleaved in config order in a single section:

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- Load the `coderabbit:code-review` skill via the Skill tool before proceeding (plugin-provided).
</agent_skills>
```

If no skills are configured, the block is omitted (zero overhead).

---

## Related

- [Agent Skills Injection (Configuration)](../CONFIGURATION.md#agent-skills-injection) — the keys, entry forms and agent types
- [Context engineering](context-engineering.md) — why agents get fresh, bounded context
- [Attach a plugin-provided skill to a GSD agent](../how-to/attach-a-plugin-skill-to-a-gsd-agent.md) — the steps for the `global:plugin:skill` form
- [ADR 1866](../adr/1866-agent-skills-dual-injection-contract.md) — the contract record

## The trusted-roots boundary

By default, a `global:<name>` skill whose `SKILL.md` real path (after resolving symlinks) escapes the runtime's global skills directory (for example `~/.claude/skills/`) is rejected as a symlink-escape. The check exists because both seams read the `SKILL.md` a name resolves to, and a symlink can make that file live anywhere on disk. [`agent_skills_security.trusted_global_roots`](../CONFIGURATION.md#trusted-global-skill-roots-agent_skills_securitytrusted_global_roots) lets a project declare additional roots, so a symlinked skill whose real target lies under one of them is accepted.

The common case is a single source-of-truth skills directory elsewhere on disk (for example `~/shared/skills`) symlinked into `~/.claude/skills/`, so `git pull` or `rsync` keeps a team's skills current without copies.

How the boundary is resolved:

- **Absolute or tilde-prefixed entries only.** Project-relative paths are rejected, so an untrusted repository's `.planning/config.json` cannot point trust at a directory inside itself.
- **`realpathSync` on every run.** Each declared root is resolved when skills load, so trust follows the real target and cannot drift silently if a root later becomes a symlink. Roots that do not exist or cannot be read are dropped without error.
- **Broad roots are refused.** The filesystem root (`/`), drive or UNC roots and the home directory itself cannot be declared, because they would make the allowlist meaningless.
- **One acceptance rule.** A skill is accepted if and only if its real `SKILL.md` path lies inside the default global skills directory or inside one of the resolved trusted roots. Everything else is still rejected.
- **The widened boundary stays visible.** A skill accepted through a trusted root rather than the default directory writes a `[agent-skills] NOTE:` line to stderr.

The key is read from the project-local `.planning/config.json`, which is why the reference page carries a security note: a declared root applies to every agent in that project.

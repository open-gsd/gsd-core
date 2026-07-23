# How to attach a plugin-provided skill to a GSD agent

Use this guide when you have a Claude Code plugin that ships a skill and you want GSD agents to load it automatically at spawn time. The `global:<plugin>:<skill>` entry form makes GSD emit a Skill-tool load directive so the agent picks up the plugin skill alongside any project-local or personal global skills.

**This feature works on the Claude runtime only.** On other runtimes (Codex, Antigravity, Cursor, etc.) the entry is skipped with a warning. Plan accordingly if your team uses multiple runtimes.

---

## 1. Install the plugin in Claude Code

GSD does not install or manage Claude Code plugins. Install the plugin first:

```
/plugin install <plugin-source>
```

Verify the plugin is active and note the skill names it exposes. The plugin's documentation or `README` will list available skill names in the format `plugin:skill` — for example, `coderabbit:code-review`.

---

## 2. Find the namespaced skill name

The name you need has two colon-separated segments after `global:`:

```
global:<plugin>:<skill>
```

For example, if the plugin slug is `coderabbit` and it provides a skill called `code-review`, the entry is:

```
global:coderabbit:code-review
```

Each segment must consist of alphanumeric characters, underscores, or hyphens only. No spaces, no slashes, no dots.

---

## 3. Add the entry to `agent_skills`

Open `.planning/config.json` and add the namespaced skill to the array for the agent type that should receive it:

```json
{
  "agent_skills": {
    "gsd-executor": [
      "skills/project-conventions",
      "global:coderabbit:code-review"
    ],
    "gsd-verifier": [
      "global:coderabbit:code-review"
    ]
  }
}
```

You can mix all three entry forms freely within the same array — project-relative paths, `global:<name>` personal skills, and `global:<plugin>:<skill>` plugin skills.

Or set it from the CLI:

```bash
gsd-tools query config-set agent_skills.gsd-executor '["skills/project-conventions","global:coderabbit:code-review"]'
```

---

## 4. Verify the injection

Start a phase on the Claude runtime. When the target agent is spawned, its Task() prompt will contain an `<agent_skills>` block that includes a Skill-tool load directive for the plugin skill:

```xml
<agent_skills>
Read these user-configured skills:
- @skills/project-conventions/SKILL.md
- Load the `coderabbit:code-review` skill via the Skill tool before proceeding (plugin-provided).
</agent_skills>
```

Both entry types appear in the same `Read these user-configured skills:` section, interleaved in config order. There is no separate header for plugin-provided skills.

If you see `[agent-skills] WARNING: Plugin-namespaced skill "global:coderabbit:code-review" requires a Skill-tool-capable runtime (claude) — skipping on runtime "<runtime>"` in the logs, the entry is being skipped because the active runtime is not Claude. The configuration is still valid; no change is needed.

---

## Notes

- **Plugin must be pre-installed.** GSD only references the skill by namespaced name. If the plugin is not installed in Claude Code, the Skill tool call will fail at agent runtime — GSD cannot validate plugin presence at configuration time.
- **Which agents support it.** All 22 GSD agent types that consume `agent_skills` carry the `Skill` tool, so any of them can load plugin-provided skills. See [Agent Skills Injection — Supported Agent Types](../CONFIGURATION.md#supported-agent-types) for the full list.
- **Non-Claude runtimes.** The `global:<plugin>:<skill>` entry is silently skipped with a warning on non-Claude runtimes. Project-relative and `global:<name>` entries work on all runtimes.
- **Security boundary.** Plugin skill content is resolved entirely by Claude Code at agent runtime. GSD does not read, cache, or validate the plugin's files.

---

## Related

- [Configuration — Agent Skills Injection](../CONFIGURATION.md#agent-skills-injection)
- [Install a minimal GSD and add skills later](install-minimal-and-add-skills.md)
- [Import a capability from a URL](import-a-capability-from-a-url.md)

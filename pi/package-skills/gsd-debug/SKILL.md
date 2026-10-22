---
name: gsd-debug
description: "Systematic debugging with persistent state across context resets"
---
**Partly supported on Pi.** `/skill:gsd-debug` runs `list` and `status <slug>` on Pi. Every other form cannot run on Pi: needs nested dispatch; Pi dispatch is flat.

If the text typed after the skill name is exactly `list`, or starts with `status ` followed by a slug, read the file listed under `<execution_context>` below with your read tool (the leading `@` is accepted). Run section 0 of that workflow, then only section 1a for `list` or section 1b for `status`, and stop. For any other text, tell the user the form cannot run on Pi and why, and stop. Do not dispatch any role, do not start the rest of the workflow, and do not perform the debugger's steps inline.

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/debug.md
</execution_context>

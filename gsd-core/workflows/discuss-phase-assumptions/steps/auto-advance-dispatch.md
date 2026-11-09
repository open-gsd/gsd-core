<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

**If `--auto` flag present OR `AUTO_MODE` is true:**

Display banner:
```text
### GSD ► AUTO-ADVANCING TO PLAN

Context captured (assumptions mode). Launching plan-phase...
```

Launch: `Skill(skill="gsd-plan-phase", args="${PHASE} --auto")`

Handle return: PHASE COMPLETE / PLANNING COMPLETE / INCONCLUSIVE / GAPS FOUND
(identical handling to discuss-phase.md auto_advance step)

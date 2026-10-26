<step name="evolve_project_full_review">

Full PROJECT.md evolution review at milestone completion.

Read all phase summaries:

```bash
_SUMMARIES=( .planning/phases/*-*/*-SUMMARY.md )
if [ -e "${_SUMMARIES[0]}" ]; then cat "${_SUMMARIES[@]}"; fi
```

**Full review checklist:**

1. **"What This Is" accuracy:**
   - Compare current description to what was built
   - Update if product has meaningfully changed

2. **Core Value check:**
   - Still the right priority? Did shipping reveal a different core value?
   - Update if the ONE thing has shifted

3. **Business Context check (only if the section is present):**
   - Skip entirely if PROJECT.md has no `## Business Context` section
   - Customer, revenue model, and success metric still accurate after shipping?
   - Update any field that drifted; refresh the linked strategy doc reference if it moved

4. **Requirements audit:**

   **Validated section:**
   - All Active requirements shipped this milestone → Move to Validated
   - Format: `- ✓ [Requirement] — v[X.Y]`

   **Active section:**
   - Remove requirements moved to Validated
   - Add new requirements for next milestone
   - Keep unaddressed requirements

   **Out of Scope audit:**
   - Review each item — reasoning still valid?
   - Remove irrelevant items
   - Add requirements invalidated during milestone

5. **Context update:**
   - Current codebase state (LOC, tech stack)
   - User feedback themes (if any)
   - Known issues or technical debt

6. **Key Decisions audit:**
   - Extract all decisions from milestone phase summaries
   - Add to Key Decisions table with outcomes
   - Mark ✓ Good, ⚠️ Revisit, or — Pending

7. **Constraints check:**
   - Any constraints changed during development? Update as needed

Update PROJECT.md inline. Update "Last updated" footer:

```markdown
---
*Last updated: [date] after v[X.Y] milestone*
```

**Example full evolution (v1.0 → v1.1 prep):**

Before:

```markdown
## What This Is

A real-time collaborative whiteboard for remote teams.

## Core Value

Real-time sync that feels instant.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Canvas drawing tools
- [ ] Real-time sync < 500ms
- [ ] User authentication
- [ ] Export to PNG

### Out of Scope

- Mobile app — web-first approach
- Video chat — use external tools
```

After v1.0:

```markdown
## What This Is

A real-time collaborative whiteboard for remote teams with instant sync and drawing tools.

## Core Value

Real-time sync that feels instant.

## Requirements

### Validated

- ✓ Canvas drawing tools — v1.0
- ✓ Real-time sync < 500ms — v1.0 (achieved 200ms avg)
- ✓ User authentication — v1.0

### Active

- [ ] Export to PNG
- [ ] Undo/redo history
- [ ] Shape tools (rectangles, circles)

### Out of Scope

- Mobile app — web-first approach, PWA works well
- Video chat — use external tools
- Offline mode — real-time is core value

## Context

Shipped v1.0 with 2,400 LOC TypeScript.
Tech stack: Next.js, Supabase, Canvas API.
Initial user testing showed demand for shape tools.
```

**Step complete when:**

- [ ] "What This Is" reviewed and updated if needed
- [ ] Core Value verified as still correct
- [ ] Business Context checked (or confirmed absent)
- [ ] All shipped requirements moved to Validated
- [ ] New requirements added to Active for next milestone
- [ ] Out of Scope reasoning audited
- [ ] Context updated with current state
- [ ] All milestone decisions added to Key Decisions
- [ ] "Last updated" footer reflects milestone completion

</step>

# How to migrate a project to bracket phase IDs

**Goal:** Move an existing project to the bracket phase-ID convention (`[GSD.02] 05`) so that ROADMAP, the phase directories, `STATE.md` and `PROJECT.md` all speak one vocabulary, and know what to do with any reference the migration would not guess at.

**Prerequisites:** A `.planning/ROADMAP.md` with legacy (`### Phase 3: Name`) or milestone-prefixed (`### Phase 2-01: Name`) headings, a `project_code` in `.planning/config.json`, and a clean tracked working tree. For the grammar and the reasons behind it, see [ADR-612](../adr/612-bracket-phase-id-convention.md). For every flag, see [`roadmap upgrade`](../COMMANDS.md#roadmap-upgrade---convention-target).

---

## 1. Preview the migration

Dry-run is the default. It prints the plan as JSON and writes nothing.

```bash
node gsd-tools.cjs roadmap upgrade --convention bracket
```

Read these keys of the plan:

| Key | What it lists |
|---|---|
| `phases` | Phase directories that will be renamed, `oldDir` to `newDir` |
| `roadmapEdits` | ROADMAP headings and checklist bullets that will be rewritten |
| `crossRefEdits` | `STATE.md` and `PROJECT.md` labels that will be rewritten, one entry per spelling found |
| `crossRefSkipped` | References the migration left alone, each with a `reason` |

A `crossRefEdits` entry replaces the label as written with the canonical display and the same colon. `Phase 3:` becomes `[GSD.02] 01:`, the shape the migrated ROADMAP heading has. Only the exact `Phase <number>:` spelling is a label: `Phase 3 shipped`, `phase 3:` and directory names such as `GSD-01-setup` are not touched, and a label inside a fenced code block is neither rewritten nor reported.

## 2. Resolve every `crossRefSkipped` entry

A label is rewritten only when exactly one roadmap phase answers to it. Anything else is skipped and named, because choosing a milestone would recreate the ambiguity the convention removes.

| `reason` | Meaning | What to do |
|---|---|---|
| `ambiguous-milestone` | The label's number is carried by phases in more than one milestone (for example `Phase 1:` exists in v1.0 and in v2.0). `from` names the label. | After the migration, edit each occurrence by hand to the bracket display of the phase you meant, for example `[GSD.01] 01:`. |
| `file-unreadable` | `STATE.md` or `PROJECT.md` exists but is not a regular, readable file, or its content cannot be read as a planning document (for example an unterminated frontmatter fence). No `from`. | Fix the file, then re-run the dry-run before applying. |

An empty `crossRefSkipped` and an empty `crossRefEdits` together mean nothing needed rewriting. A label for a phase that is not in the roadmap at all appears in neither list; it is left as written.

## 3. Apply

```bash
node gsd-tools.cjs roadmap upgrade --convention bracket --apply
```

The apply refuses a dirty tracked working tree. If any write fails, every rename is reversed and every file it changed, `STATE.md` and `PROJECT.md` included, is restored to its exact bytes, unless another writer changed that file after the migration wrote it: such a file is left as found and named in the error. `STATE.md` is written through its own state seam, so its frontmatter (timestamps, progress) is refreshed along with the label rewrite.

Running the same command again reports `alreadyMigrated` with empty edit lists. Labels in a project that was migrated before this behavior existed are not rewritten by a re-run; edit those by hand.

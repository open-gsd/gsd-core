# How to migrate from GSD-2

**Goal:** Bring an older GSD-2 project (`.gsd/` directory layout) forward into GSD Core (`.planning/` layout), and optionally absorb any existing ADRs, PRDs, or specs that live in the repository into the new planning structure.

**Prerequisites:** GSD Core is installed. The GSD-2 project directory is available on disk.

---

## Understand what migrates

GSD-2 used a `.gsd/` directory as its planning root. GSD Core uses `.planning/`. The migration reverses this: it reads `.gsd/` artifacts and writes them into the standard `.planning/` structure that all GSD Core commands expect.

| What exists in GSD-2 | What `/gsd-import --from-gsd2` produces |
|----------------------|-----------------------------------------|
| `.gsd/PROJECT.md` | `.planning/PROJECT.md` |
| `.gsd/ROADMAP.md` | `.planning/ROADMAP.md` |
| `.gsd/STATE.md` | `.planning/STATE.md` |
| `.gsd/phases/` directories | `.planning/phases/` directories |
| Phase `PLAN.md` files | GSD Core `{NN}-{MM}-PLAN.md` files (renaming enforced) |

Conflict detection runs before any files are written. If the target directory already has a `PROJECT.md` and the imported content contradicts it, the migration stops at the BLOCKER gate and lists the conflicts for you to resolve.

---

## Run the migration

### Migrate the current directory

```bash
/gsd-import --from-gsd2
```

GSD reads `.gsd/` in the current working directory and writes the migrated artifacts into `.planning/`.

### Migrate from a different path

```bash
/gsd-import --from-gsd2 --path ~/projects/old-project
```

Use `--path` when the GSD-2 project is not your current working directory.

---

## Resolve conflicts

If conflict detection finds blockers — for example, a GSD-2 tech-stack declaration that contradicts an existing `.planning/PROJECT.md` — it prints a conflict report and stops without writing any files.

Read the report, resolve the contradiction (edit the source document or the existing planning artifact), then re-run `/gsd-import --from-gsd2`. The migration is safe to re-run until it passes cleanly.

---

## Import an external plan file

If you have a standalone plan document (a team planning document, a Markdown spec, an exported task list) rather than a full GSD-2 project, use `--from` instead:

```bash
/gsd-import --from /tmp/team-plan.md
```

GSD performs the same conflict-detection pass, converts the content to GSD Core `PLAN.md` format, and validates the result with the plan-checker. After validation you will see the target filename and next steps.

---

## Absorb existing documentation

If your repository already contains ADRs (Architecture Decision Records), PRDs, or specification documents, use `/gsd-ingest-docs` to synthesise them into the `.planning/` structure after migration:

### Scan the whole repository (auto-detects mode)

```bash
/gsd-ingest-docs
```

If `.planning/` is already present (for example, from the migration you just ran), GSD defaults to merge mode — it synthesises the ingested documents alongside what is already there rather than overwriting it.

### Scope to a specific directory

```bash
/gsd-ingest-docs docs/
/gsd-ingest-docs docs/adr/
```

### Use an explicit precedence manifest

When documents have mixed types or you want to control which document wins on conflicts:

```bash
/gsd-ingest-docs --manifest ingest.yaml
```

The manifest is a YAML file listing `{path, type, precedence?}` per document. See the `--manifest` flag description in [Commands](../COMMANDS.md) for the expected shape.

### Force a specific mode

```bash
/gsd-ingest-docs --mode merge     # Merge into existing .planning/
/gsd-ingest-docs --mode new       # Bootstrap from scratch (overwrites)
```

**Output:** `/gsd-ingest-docs` always produces an `INGEST-CONFLICTS.md` with three buckets — auto-resolved, competing-variants, and unresolved-blockers. Review this file after every ingest run. Hard-stops only occur on LOCKED-vs-LOCKED ADR contradictions; everything else is surfaced for your review, not silently discarded.

---

## Verify the migrated project

Once migration and any doc ingestion are complete, confirm the project state is consistent:

```bash
/gsd-health
/gsd-health --repair
```

`/gsd-health` checks `.planning/` directory integrity and reports any drift. `--repair` auto-fixes recoverable issues.

Then check that GSD Core can read your project state:

```bash
/gsd-progress
```

If the project came across cleanly you will see the current phase status and the recommended next step. From here the standard GSD Core workflow applies.

---

## Conditionals: what migrates and what does not

| Situation | What to do |
|-----------|-----------|
| `.gsd/` exists in the current directory | Run `/gsd-import --from-gsd2` (no `--path` needed) |
| `.gsd/` is in a different directory | Use `--path ~/projects/old-project` |
| You have a standalone plan document, not a full GSD-2 project | Use `/gsd-import --from /path/to/plan.md` |
| You have ADRs in `docs/adr/` | Run `/gsd-ingest-docs docs/adr/` after migration |
| You have a mix of ADRs, PRDs, and specs | Run `/gsd-ingest-docs` at repo root; it classifies automatically |
| Conflict detection reports blockers | Resolve the listed contradictions then re-run; no files are written until all blockers clear |
| You are not sure whether migration worked | Run `/gsd-health` and `/gsd-progress` to confirm |
| INGEST-CONFLICTS.md lists unresolved blockers | These require manual resolution before affected documents are incorporated into planning |

---

## Related

- [Your first project](../tutorials/your-first-project.md)
- [Commands](../COMMANDS.md)
- [docs index](../README.md)

# Git Planning Commit

Commit planning artifacts via `gsd_run query commit`, which checks `commit_docs` config and gitignore status.

## Commit via CLI

Pass the message first, then file paths via `--files`. Both `commit` and `commit-to-subrepo` use `--files` to declare the paths to commit.

Always use this for `.planning/` files — it handles `commit_docs` and gitignore checks automatically:

```bash
DOCS=(); for f in "{state_path}" "{roadmap_path}"; do [ -f "$f" ] && DOCS+=("$f"); done
[ ${#DOCS[@]} -eq 0 ] || gsd_run query commit "docs({scope}): {description}" --files "${DOCS[@]}"
```

`{state_path}` and `{roadmap_path}` are the init fields of those names (the selected project's or workstream's files); never commit a root `.planning/<DOC>.md` literal, which names another project's file under a named project or workstream. Quote each path, and leave out a doc whose init field is null (absent file): an empty pathspec fails the commit, and a `--files` list with nothing after it stages all of `.planning/`.

The CLI will return `skipped` (with reason) if `commit_docs` is `false`, `.planning/` is gitignored, or a per-phase `phase_commit_docs.<phase-id>` override resolves `false` for the phase being committed. No manual conditional checks needed.

## Amend previous commit

To fold `.planning/` file changes into the previous commit:

```bash
gsd_run query commit "" --files .planning/codebase/*.md --amend
```

## Commit Message Patterns

| Command | Scope | Example |
|---------|-------|---------|
| plan-phase | phase | `docs(phase-03): create authentication plans` |
| execute-phase | phase | `docs(phase-03): complete authentication phase` |
| new-milestone | milestone | `docs: start milestone v1.1` |
| remove-phase | chore | `chore: remove phase 17 (dashboard)` |
| insert-phase | phase | `docs: insert phase 16.1 (critical fix)` |
| add-phase | phase | `docs: add phase 07 (settings page)` |

## When to Skip

- `commit_docs: false` in config
- `.planning/` is gitignored
- `phase_commit_docs.<phase-id>` resolves `false` for the phase being committed — overrides the project-wide `commit_docs` for that phase only (reason `skipped_commit_docs_phase_false`)
- No changes to commit (check with `git status --porcelain .planning/`)

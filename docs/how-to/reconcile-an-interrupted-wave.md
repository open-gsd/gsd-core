# How to reconcile an interrupted wave

**Goal:** Discover and reconcile in-flight wave manifests left behind by an interrupted `/gsd-execute-phase` wave run, clean up residual executor worktrees, and unblock subsequent wave execution.

**Prerequisites:** GSD Core installed and an active project using worktree-isolated wave execution.

---

## What you will see

If an earlier wave execution was interrupted (due to a process kill, turn timeout, or crash) before wave cleanup could complete, subsequent `/gsd-execute-phase` invocations fail closed before dispatching any worktrees:

```text
BLOCKED: pre-existing wave manifest found at .planning/phases/01-foundation/wave-1-manifest.json from an earlier/interrupted run.
Refusing to overwrite in-flight wave record. Reconcile first with:
    gsd_run query worktree.cleanup-wave --manifest ".planning/phases/01-foundation/wave-1-manifest.json"
```

Execution halts immediately with exit code 1 to protect existing worktree records from being truncated or orphaned.

---

## Why this happens

During wave execution, the orchestrator records each spawned executor's worktree identity (`agent_id`, `worktree_path`, `branch`, `expected_base`) into a durable, phase-scoped manifest file at `{phase_dir}/wave-{N}-manifest.json` (#4853).

The manifest is an ephemeral coordination record:
- Under normal execution, `gsd-tools worktree cleanup-wave` merges and deletes the executor worktrees, after which `execute-phase` unlinks the manifest.
- If execution stops mid-wave, the manifest remains on disk so that the orchestrator or operator can identify and reconcile the in-flight worktrees.
- Subsequent wave dispatches check for pre-existing manifests using exclusive creation (`{flag: "wx"}`) and fail closed with `BLOCKED` if an uncleaned manifest exists.

---

## Step 1 — Discover active wave manifests

To find all in-flight wave manifests for a phase:

```bash
# By phase ID:
node gsd-tools.cjs worktree manifest-path --phase <phase-id>

# Or by phase directory:
node gsd-tools.cjs worktree manifest-path --phase-dir .planning/phases/<phase-dir>
```

This returns a JSON list of existing manifest paths sorted by wave number. To print bare paths suitable for shell scripts, pass `--raw`:

```bash
node gsd-tools.cjs worktree manifest-path --phase <phase-id> --raw
```

---

## Step 2 — Reconcile and clean up the interrupted wave

Run `cleanup-wave` pointing to the discovered manifest:

```bash
node gsd-tools.cjs worktree cleanup-wave --manifest "<manifest-path>"
```

`cleanup-wave` will:
1. Validate each recorded worktree entry.
2. Merge each executor's branch back into the target branch.
3. Remove each executor worktree directory (`git worktree remove`).
4. Once all residual worktrees are successfully cleaned up, delete or permit removing the manifest.

If residual worktrees had already been cleaned up manually, remove the empty or obsolete manifest file:

```bash
rm "<manifest-path>"
```

Once the manifest is removed, `/gsd-execute-phase` will proceed normally.

---

## Retention, commit & ignore policy

- **Lifecycle:** Wave manifests are temporary runtime coordination artifacts. They are created exclusively at wave dispatch and deleted upon successful wave cleanup.
- **Version control policy:** Manifests contain machine-local absolute paths (`worktree_path`, `orchestrator_root`). Under `commit_docs: true` or workflows that stage planning documents (e.g. `fast`), do not commit unreconciled manifests to version control. Always reconcile an interrupted wave before committing documentation.
- **Gitignore configuration (optional):** To prevent git from ever tracking interrupted manifests, add the following pattern to your project `.gitignore` or `.planning/.gitignore`:
  ```gitignore
  .planning/**/wave-*-manifest.json
  ```

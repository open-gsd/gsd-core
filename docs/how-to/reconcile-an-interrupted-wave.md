# How to reconcile an interrupted wave

**Goal:** Discover and reconcile in-flight wave manifests left behind by an interrupted `/gsd-execute-phase` wave run, clean up residual executor worktrees, and unblock subsequent wave execution.

**Prerequisites:** GSD Core installed and an active project using worktree-isolated wave execution.

---

## 1. Recognize the blocked condition

When a wave run is interrupted before cleanup completes, subsequent `/gsd-execute-phase` invocations fail closed before dispatching new worktrees:

```text
BLOCKED: pre-existing wave manifest found at .planning/phases/01-foundation/wave-1-manifest.json from an earlier/interrupted run.
Refusing to overwrite in-flight wave record. Reconcile first with:
    gsd_run query worktree.cleanup-wave --manifest ".planning/phases/01-foundation/wave-1-manifest.json"
```

Execution halts immediately with exit code 1 to protect existing worktree records from truncation or accidental orphan state.

---

## 2. Step 1 — Discover active wave manifests

To locate in-flight wave manifests left in a phase directory:

```bash
# Via gsd_run (or node gsd-tools.cjs):
gsd_run query worktree.manifest-path --phase <phase-id>

# Or by phase directory:
gsd_run query worktree.manifest-path --phase-dir .planning/phases/<phase-dir>
```

To output bare file paths for scripting or assignment:

```bash
gsd_run query worktree.manifest-path --phase <phase-id> --raw
```

---

## 3. Step 2 — Reconcile and clean up the interrupted wave

Run `cleanup-wave` against the reported manifest path:

```bash
gsd_run query worktree.cleanup-wave --manifest "<manifest-path>"
```

*(Direct CLI equivalent: `node gsd-tools.cjs worktree cleanup-wave --manifest "<manifest-path>"`)*

`cleanup-wave` performs the following reconciliation steps:
1. Validates each recorded worktree entry.
2. Merges each executor branch back into the target branch.
3. Removes each executor worktree directory (`git worktree remove`).
4. Automatically unlinks the manifest file upon completion.

---

## 4. Step 3 — Resume execution

Once `cleanup-wave` reports success and unlinks the manifest, re-run `/gsd-execute-phase`. Execution will proceed without blocking.

---

## Further Reading

For architectural details, lifecycle contracts, commit exclusions, and untracked manifest requirements, see the [Retention, commit & untracked manifest policy](../CLI-TOOLS.md#retention-commit--untracked-manifest-policy) in the CLI Tools reference.

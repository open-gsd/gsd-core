# How to fix a workflow or agent size failure

Use this when CI is red because a workflow (`gsd-core/workflows/*.md`) or an agent (`agents/gsd-*.md`) grew. The guard that reports it, the tier caps and the headroom census are described in [Workflow & agent size budget](../TESTING-SUITES.md#workflow--agent-size-budget).

The differential attribution check reports the file and the byte delta. To resolve:

1. **Justify the growth in your PR** (a sentence in the description is enough) —
   the acknowledgment entry (the trailer in step 2) is the review record that the larger size
   was a deliberate, seen decision, not silent drift.
2. **Add an acknowledgment trailer** to one of your own commits (ADR-3942),
   naming the file and the reason, per `CONTRIBUTING.md`'s "Editing shipped
   content" section and `CONTEXT.md`'s `### Emitted Artifact Provenance` entry:

   ```
   Emitted-Drift-Ack-Growth: explore.md — new dispatch section, reasoning ships with the block
   ```

   Growth keys on the **bare filename** as it appears under `gsd-core/workflows/`
   or `agents/`; an unattributable **hash** ripple uses
   `Emitted-Drift-Ack-Hash:` and keys on the emitted path (which always contains
   a `/`). The two are separate namespaces — a growth trailer will not excuse a
   hash ripple, and the failure output says which one applies. The trailer is the
   review record that the larger size was a deliberate, seen decision.

   If you need to change an acknowledgment, amend the commit carrying it. That is
   deliberate: the trailer cannot drift out of sync with the diff it explains,
   because changing either changes the sha and re-runs the gate.
3. **There is nothing to clean up afterwards.** The trailer is read from
   `git log $(git merge-base <base> HEAD)..HEAD` — your commits and no others —
   so once your PR merges it is out of range by construction. It never becomes
   "spent", it owns no shared key space, it cannot conflict with anyone else's,
   and no sweeper has to delete it. That is the whole reason ADR-3942 moved the
   acknowledgment off the working tree.
4. **Or shrink it instead of acknowledging.** Prefer extraction when the growth
   is incidental: for a workflow, move per-mode bodies to
   `workflows/<name>/modes/`, templates to `workflows/<name>/templates/`, and
   shared prose to `gsd-core/references/`; for an agent, lift shared boilerplate
   into `gsd-core/references/` and `@`-reference it — then load it **LAZILY**. Do
   *not* convert them to eager `@-required_reading` includes: that shrinks the
   file's bytes without shrinking loaded context, so it games the guard while
   making the real cost worse. See `workflows/discuss-phase/` for the
   progressive-disclosure pattern.

If a hard cap (not the ratchet) is what failed, an acknowledgment will **not**
help — that is the signal to extract, per step 4.

## Related

- [Workflow & agent size budget](../TESTING-SUITES.md#workflow--agent-size-budget)
- [CONTRIBUTING.md: Editing shipped content](../../CONTRIBUTING.md)

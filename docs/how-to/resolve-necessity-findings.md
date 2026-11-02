# Resolve necessity findings

`/gsd-code-review` reports **necessity findings**: code that is correct and reachable but guards against a problem that cannot occur in your stack. This guide covers what to do with one. For the rubric itself, see `gsd-core/references/necessity-review.md`.

## Recognize one

A necessity finding is an ordinary `WR-` or `IN-` finding. Its title names the subtype (for example `Impossible-state guard — …`) and its body carries the line `**Category:** necessity`. The "REVIEW.md format" section of `gsd-core/references/necessity-review.md` has a full example.

The review summary shows how many there are on the `Necessity:` line. It shows `not assessed` when the review ran at `--depth=quick`, which never looks for them.

## Decide: keep, simplify, or delete

1. **Check the evidence.** Every necessity finding has to say why the guarded state cannot occur and cite where that is proven. If the citation does not hold up, keep the code. A finding with no evidence is not valid.
2. **Check for a trust boundary.** If the value comes from user input, the network, a file, the environment, or another process, keep the guard, whatever the types say.
3. **Decide what to do with the code:**
   - **Keep** it if the state can occur after all, or the code is a deliberate test seam or defense-in-depth layer.
   - **Simplify** it if part of it is needed, for example by collapsing a one-strategy abstraction into a direct call.
   - **Delete** it if the finding holds. Record the invariant you relied on in a comment or ADR, so the guard is not re-added later.

**Warning** means the reviewer could prove the claim from the repository. **Info** means the claim rests on judgment, so weigh it more carefully.

## Let the fixer remove them

`--fix` leaves necessity findings alone, because deleting code is your scope decision. To have the fixer act on them:

```
/gsd-code-review 3 --fix --all
```

The fixer handles necessity findings last. It marks each removal `fixed: requires human verification` in `REVIEW-FIX.md`. Review those commits before you continue.

## When `--fix` reports nothing in scope

If every remaining finding is outside the fix scope (Info, or necessity without `--all`), the fix summary says **No findings were in fix scope**. It does not say *All issues resolved*. With `--auto`, the re-review loop stops at that point instead of running to its iteration cap. The findings stay in `REVIEW.md` for you to decide on.

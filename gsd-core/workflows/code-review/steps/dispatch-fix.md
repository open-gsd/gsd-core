<step name="dispatch_fix">
If the `--fix` flag was passed (`FIX_FLAG=true`), delegate to the `code-review-fix.md` workflow
to auto-apply findings from the REVIEW.md that was just written (or that already existed).

This step runs AFTER `commit_review` so a freshly-written REVIEW.md is guaranteed to be on disk
before the fixer is invoked. Since #4665 there is a second route: `check_empty_scope` jumps here
directly when the incremental scope is empty but `--fix` was passed and a REVIEW.md already exists
— `code-review-fix.md` resolves it from the phase and owns the missing-review error either way.

```bash
if [ "$FIX_FLAG" = "true" ]; then
  echo ""
  echo "─────────────────────────────────────────────────────────────────"
  echo "  --fix: delegating to code-review-fix.md"
  echo "─────────────────────────────────────────────────────────────────"
  echo ""

  # Build the fix sub-arguments: pass phase arg plus any --all/--auto flags
  FIX_ARGS="${PHASE_ARG}"
  if [ "$FIX_ALL" = "true" ]; then
    FIX_ARGS="${FIX_ARGS} --all"
  fi
  if [ "$FIX_AUTO" = "true" ]; then
    FIX_ARGS="${FIX_ARGS} --auto"
  fi

  # Load and execute the code-review-fix workflow.
  # The fix workflow is the canonical implementation for all fix logic:
  # gsd-code-fixer agent dispatch, --auto iteration loop, REVIEW-FIX.md commit,
  # and result presentation. Do not duplicate that logic here.
  Workflow(workflow="gsd-core/workflows/code-review-fix.md", args="${FIX_ARGS}")

  # Exit after fix workflow completes — present_results is for review-only output.
  # The fix workflow has its own present_results step.
  # Exit workflow.
fi
```

If `FIX_FLAG` is false, skip this step entirely and proceed to `present_results`.
</step>
